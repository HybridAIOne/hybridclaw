/**
 * Outbound HTTP proxy handler for the gateway.
 *
 * Handles `POST /api/http/request` — routes outbound HTTP calls with secret
 * placeholder resolution, bearer token injection, auth rule matching, and
 * automatic OAuth2 token capture.
 */

import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';

import type { RuntimeConfig } from '../config/runtime-config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { logger } from '../logger.js';
import {
  isRuntimeSecretName,
  readStoredRuntimeSecret,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { resolveSecretInput } from '../security/secret-refs.js';

import {
  parsePositiveInteger,
  readJsonBody,
  sendJson,
} from './gateway-http-utils.js';

const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const HTTP_REQUEST_MAX_RESPONSE_BYTES = 1_000_000;
const HTTP_REQUEST_SECRET_PLACEHOLDER_RE = /<secret:([A-Z][A-Z0-9_]{0,127})>/g;
const REDIRECT_RESPONSE_STATUS_MIN = 300;
const REDIRECT_RESPONSE_STATUS_MAX = 399;

type CaptureFieldRule = { jsonPath: string; secretName: string };

type ApiHttpRequestBody = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  json?: unknown;
  bearerSecretName?: unknown;
  secretHeaders?: unknown;
  replaceSecretPlaceholders?: unknown;
  captureResponseFields?: unknown;
  timeoutMs?: unknown;
  maxResponseBytes?: unknown;
};

type ApiHttpRequestSecretHeaderBody = {
  name?: unknown;
  secretName?: unknown;
  prefix?: unknown;
};

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  if (parts[0] === 0) return true;
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
  if (parts[0] >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, '');
  const version = net.isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) return isPrivateIpv6(normalized);
  return false;
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  if (net.isIP(host) > 0) return isPrivateIp(host);
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0) return false;
    return resolved.some((entry) => isPrivateIp(entry.address));
  } catch (error) {
    logger.warn(
      { host, error },
      'DNS lookup failed during SSRF host check; treating host as private/blocked',
    );
    return true;
  }
}

async function readHttpResponseBuffer(
  response: Response,
  maxResponseBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    if (typeof response.arrayBuffer === 'function') {
      const buffered = Buffer.from(await response.arrayBuffer());
      if (buffered.length > maxResponseBytes) {
        throw new GatewayRequestError(
          413,
          `Outbound response exceeded limit (${buffered.length} bytes > ${maxResponseBytes}).`,
        );
      }
      return buffered;
    }
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new GatewayRequestError(
          413,
          `Outbound response exceeded limit (${totalBytes} bytes > ${maxResponseBytes}).`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

async function assertHttpRequestUrl(raw: unknown): Promise<URL> {
  const input = String(raw || '').trim();
  if (!input) {
    throw new GatewayRequestError(400, 'Missing `url` in request body.');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new GatewayRequestError(400, `Invalid URL: ${input}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GatewayRequestError(
      400,
      `Unsupported URL protocol: ${parsed.protocol}`,
    );
  }

  if (await isPrivateHost(parsed.hostname)) {
    throw new GatewayRequestError(
      400,
      `HTTP request blocked by SSRF guard: private or loopback host (${parsed.hostname}).`,
    );
  }

  return parsed;
}

function normalizeHttpRequestMethod(value: unknown): string {
  const normalized = String(value || 'GET')
    .trim()
    .toUpperCase();
  if (!normalized) return 'GET';
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new GatewayRequestError(400, `Invalid HTTP method: ${normalized}`);
  }
  return normalized;
}

function normalizeHeaderNameOrThrow(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(normalized)) {
    throw new GatewayRequestError(
      400,
      `Invalid HTTP header name: ${normalized}`,
    );
  }
  return normalized;
}

function normalizeHttpRequestHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') continue;
    const normalizedKey = normalizeHeaderNameOrThrow(key);
    headers[normalizedKey] = entry;
  }
  return headers;
}

function setHeaderValue(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const existing = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  if (existing && existing !== name) {
    delete headers[existing];
  }
  headers[existing || name] = value;
}

function normalizeHttpRequestSecretHeaders(
  value: unknown,
): Array<{ name: string; secretName: string; prefix: string }> {
  if (!Array.isArray(value)) return [];
  const headers: Array<{ name: string; secretName: string; prefix: string }> =
    [];
  for (const entry of value) {
    const typed = entry as ApiHttpRequestSecretHeaderBody;
    const name =
      typeof typed?.name === 'string'
        ? normalizeHeaderNameOrThrow(typed.name)
        : '';
    const secretName =
      typeof typed?.secretName === 'string' ? typed.secretName.trim() : '';
    if (!name || !isRuntimeSecretName(secretName)) continue;
    const prefix =
      typeof typed?.prefix === 'string' ? typed.prefix.trim() : 'Bearer';
    headers.push({
      name,
      secretName,
      prefix: !prefix || prefix.toLowerCase() === 'none' ? '' : prefix,
    });
  }
  return headers;
}

function withAuthPrefix(secret: string, prefix: string): string {
  return prefix ? `${prefix} ${secret}` : secret;
}

function resolveStoredSecretOrThrow(secretName: string): string {
  if (!isRuntimeSecretName(secretName)) {
    throw new GatewayRequestError(400, `Invalid secret name: ${secretName}`);
  }
  const value = readStoredRuntimeSecret(secretName);
  if (!value) {
    throw new GatewayRequestError(
      400,
      `Stored secret ${secretName} is not set.`,
    );
  }
  return value;
}

function replaceSecretPlaceholdersInString(value: string): string {
  return value.replace(
    HTTP_REQUEST_SECRET_PLACEHOLDER_RE,
    (_match, secretName) => resolveStoredSecretOrThrow(secretName),
  );
}

function replaceSecretPlaceholders(value: unknown): unknown {
  if (typeof value === 'string') {
    return replaceSecretPlaceholdersInString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceSecretPlaceholders(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceSecretPlaceholders(entry),
      ]),
    );
  }
  return value;
}

const BOUND_DOMAIN_SUFFIX = '_BOUND_DOMAIN';

/**
 * Return the exact lowercase hostname for domain binding.
 *
 * We bind to the exact hostname rather than a naive "last two labels"
 * heuristic, because multi-tenant / public-suffix domains (e.g.
 * `something.github.io`, `service.co.uk`) would allow exfiltration to
 * attacker-controlled sibling subdomains under a broad suffix.
 */
function extractBaseDomain(hostname: string): string {
  return hostname.toLowerCase();
}

/**
 * Check whether a target URL is allowed for a given bearer secret.
 *
 * When a token is captured via OAuth, the gateway stores a domain binding
 * as `{SECRET_NAME}_BOUND_DOMAIN`.  If a binding exists, the target URL's
 * hostname must match (exact or subdomain).  If no binding exists, any URL
 * is allowed (backward-compatible).
 */
function assertBearerDomainBinding(secretName: string, targetUrl: URL): void {
  const bindingKey = `${secretName}${BOUND_DOMAIN_SUFFIX}`;
  const boundDomain = readStoredRuntimeSecret(bindingKey);
  if (!boundDomain) return; // no binding → unrestricted

  const targetHost = targetUrl.hostname.toLowerCase();
  const allowed = boundDomain.toLowerCase();
  if (targetHost === allowed || targetHost.endsWith(`.${allowed}`)) {
    return;
  }

  throw new GatewayRequestError(
    403,
    `Bearer secret ${secretName} is bound to *.${allowed} — ` +
      `request to ${targetHost} is blocked.`,
  );
}

function normalizeCaptureResponseFields(
  value: unknown,
): CaptureFieldRule[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const rules: CaptureFieldRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const jsonPath =
      typeof entry.jsonPath === 'string' ? entry.jsonPath.trim() : '';
    const secretName =
      typeof entry.secretName === 'string' ? entry.secretName.trim() : '';
    if (!jsonPath || !secretName) continue;
    if (!isRuntimeSecretName(secretName)) {
      throw new GatewayRequestError(
        400,
        `Invalid secret name in captureResponseFields: ${secretName}`,
      );
    }
    rules.push({ jsonPath, secretName });
  }
  return rules;
}

function extractBindingDomainFromResponse(
  responseJson: Record<string, unknown>,
  requestUrl: URL,
): string {
  const instanceUrl = responseJson.instance_url;
  if (typeof instanceUrl !== 'string' || !instanceUrl.trim()) {
    return extractBaseDomain(requestUrl.hostname);
  }
  try {
    const parsed = new URL(instanceUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return extractBaseDomain(requestUrl.hostname);
    }
    return extractBaseDomain(parsed.hostname);
  } catch {
    return extractBaseDomain(requestUrl.hostname);
  }
}

/**
 * Auto-detect an OAuth2 token response (RFC 6749 S5.1) by checking for
 * `access_token` in the JSON body.  When detected, capture all matching
 * fields into the secret store and return the mapping.  The original
 * response body is **never** forwarded to the caller.
 *
 * For every captured secret that looks like a token (contains "token" in the
 * jsonPath), a domain binding is stored so that `bearerSecretName` only works
 * against the resource host. OAuth APIs such as Salesforce issue tokens from a
 * login host but return an `instance_url` resource host; bind to that resource
 * host when present and fall back to the OAuth endpoint hostname otherwise.
 */
function captureOAuthResponse(
  responseJson: unknown,
  rules: CaptureFieldRule[],
  requestUrl: URL,
): Record<string, string> | null {
  if (!responseJson || typeof responseJson !== 'object') return null;
  const obj = responseJson as Record<string, unknown>;
  if (typeof obj.access_token !== 'string' || !obj.access_token.trim()) {
    return null;
  }

  const baseDomain = extractBindingDomainFromResponse(obj, requestUrl);
  const secrets: Record<string, string> = {};
  const captured: Record<string, string> = {};

  for (const rule of rules) {
    const value = obj[rule.jsonPath];
    if (typeof value === 'string' && value.trim()) {
      secrets[rule.secretName] = value.trim();
      captured[rule.jsonPath] = rule.secretName;

      // Bind token secrets to the OAuth endpoint's domain so they
      // cannot be exfiltrated to an attacker-controlled URL.
      if (rule.jsonPath.includes('token')) {
        secrets[`${rule.secretName}${BOUND_DOMAIN_SUFFIX}`] = baseDomain;
      }
    }
  }

  if (Object.keys(secrets).length === 0) {
    return null;
  }

  saveNamedRuntimeSecrets(secrets);
  return captured;
}

function resolveHttpRequestRuleAssignments(
  url: string,
  config: RuntimeConfig,
): Array<{ header: string; value: string }> {
  const matching = config.tools.httpRequest.authRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => url.startsWith(rule.urlPrefix))
    .sort(
      (left, right) =>
        right.rule.urlPrefix.length - left.rule.urlPrefix.length ||
        left.index - right.index,
    );

  const assignments = new Map<string, { header: string; value: string }>();
  for (const { rule, index } of matching) {
    const key = rule.header.toLowerCase();
    if (assignments.has(key)) continue;
    const secret = resolveSecretInput(rule.secret, {
      path: `tools.httpRequest.authRules[${index}].secret`,
      required: true,
    });
    assignments.set(key, {
      header: rule.header,
      value: withAuthPrefix(String(secret || ''), rule.prefix),
    });
  }
  return Array.from(assignments.values());
}

export async function handleApiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiHttpRequestBody;
  const replacePlaceholders = body.replaceSecretPlaceholders !== false;
  const captureFields =
    body.captureResponseFields === undefined
      ? []
      : (normalizeCaptureResponseFields(body.captureResponseFields) ?? []);
  const rawUrl = replacePlaceholders
    ? replaceSecretPlaceholdersInString(String(body.url || ''))
    : body.url;
  const url = await assertHttpRequestUrl(rawUrl);
  const method = normalizeHttpRequestMethod(body.method);
  const timeoutMs =
    parsePositiveInteger(body.timeoutMs) ?? HTTP_REQUEST_TIMEOUT_MS;
  const maxResponseBytes =
    parsePositiveInteger(body.maxResponseBytes) ??
    HTTP_REQUEST_MAX_RESPONSE_BYTES;
  const config = getRuntimeConfig();

  const headers = normalizeHttpRequestHeaders(body.headers);
  for (const assignment of resolveHttpRequestRuleAssignments(
    url.toString(),
    config,
  )) {
    setHeaderValue(headers, assignment.header, assignment.value);
  }

  const bearerSecretName =
    typeof body.bearerSecretName === 'string'
      ? body.bearerSecretName.trim()
      : '';
  if (bearerSecretName) {
    assertBearerDomainBinding(bearerSecretName, url);
    setHeaderValue(
      headers,
      'Authorization',
      withAuthPrefix(resolveStoredSecretOrThrow(bearerSecretName), 'Bearer'),
    );
  }

  for (const secretHeader of normalizeHttpRequestSecretHeaders(
    body.secretHeaders,
  )) {
    assertBearerDomainBinding(secretHeader.secretName, url);
    setHeaderValue(
      headers,
      secretHeader.name,
      withAuthPrefix(
        resolveStoredSecretOrThrow(secretHeader.secretName),
        secretHeader.prefix,
      ),
    );
  }

  if (replacePlaceholders) {
    for (const [key, value] of Object.entries(headers)) {
      headers[key] = replaceSecretPlaceholdersInString(value);
    }
  }

  let payloadBody: string | undefined;
  if (body.json !== undefined) {
    const jsonValue = replacePlaceholders
      ? replaceSecretPlaceholders(body.json)
      : body.json;
    payloadBody = JSON.stringify(jsonValue);
    if (
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    ) {
      setHeaderValue(headers, 'Content-Type', 'application/json');
    }
  } else if (typeof body.body === 'string') {
    payloadBody = replacePlaceholders
      ? replaceSecretPlaceholdersInString(body.body)
      : body.body;
  } else if (body.body !== undefined) {
    throw new GatewayRequestError(
      400,
      '`body` must be a string when provided. Use `json` for structured payloads.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payloadBody,
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayRequestError(
      502,
      `Outbound HTTP request failed: ${message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (
    response.status >= REDIRECT_RESPONSE_STATUS_MIN &&
    response.status <= REDIRECT_RESPONSE_STATUS_MAX
  ) {
    throw new GatewayRequestError(
      400,
      'Outbound HTTP redirects are blocked by the SSRF guard.',
    );
  }

  const contentLength = Number.parseInt(
    String(response.headers.get('content-length') || ''),
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new GatewayRequestError(
      413,
      `Outbound response exceeded limit (${contentLength} bytes > ${maxResponseBytes}).`,
    );
  }

  const responseBuffer = await readHttpResponseBuffer(
    response,
    maxResponseBytes,
  );

  const responseText = responseBuffer.toString('utf-8');
  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseText) as unknown;
  } catch {
    responseJson = undefined;
  }

  // Auto-detect OAuth2 token responses: if the JSON body contains
  // `access_token`, store the tokens in the secret store and return only
  // a confirmation.  The original response body is never forwarded.
  const captured = captureOAuthResponse(responseJson, captureFields, url);
  if (captured) {
    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      captured,
    });
    return;
  }

  sendJson(res, 200, {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseText,
    ...(responseJson === undefined ? {} : { json: responseJson }),
  });
}
