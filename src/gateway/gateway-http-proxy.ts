/**
 * Outbound HTTP proxy handler for the gateway.
 *
 * Handles `POST /api/http/request` — routes outbound HTTP calls with secret
 * placeholder resolution, bearer token injection, auth rule matching, and
 * explicit response-field capture.
 */

import { createSign } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';

import { resolveGoogleWorkspaceRuntimeEnv } from '../auth/google-auth.js';
import type {
  RuntimeConfig,
  RuntimeHttpRequestGoogleOAuthSecretRef,
} from '../config/runtime-config.js';
import {
  getRuntimeConfig,
  isGoogleOAuthSecretRef,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { logger } from '../logger.js';
import {
  isReservedNonSecretRuntimeName,
  isRuntimeSecretName,
  readStoredRuntimeSecret,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import {
  type SecretHandle,
  withSecretHeader,
} from '../security/secret-handles.js';
import { rememberResolvedSecretForLeakScan } from '../security/secret-leak-corpus.js';
import {
  normalizeSecretSessionId,
  normalizeSecretString,
} from '../security/secret-normalization.js';
import {
  parseSecretRefInput,
  resolveSecretHandleInput,
  resolveSecretInputUnsafe,
  type SecretRef,
} from '../security/secret-refs.js';

import {
  parsePositiveInteger,
  readJsonBody,
  sendJson,
} from './gateway-http-utils.js';
import {
  assertSecretResolveAllowed,
  recordSecretResolved,
  recordSecretUnsafeEscaped,
  resolveStoredSecretForInjection,
} from './gateway-secret-injection.js';

const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const HTTP_REQUEST_MAX_RESPONSE_BYTES = 1_000_000;
const HTTP_REQUEST_SECRET_PLACEHOLDER_RE = /<secret:([A-Z][A-Z0-9_]{0,127})>/g;
const REDIRECT_RESPONSE_STATUS_MIN = 300;
const REDIRECT_RESPONSE_STATUS_MAX = 399;
const GOOGLE_WORKSPACE_CLI_TOKEN_SECRET = 'GOOGLE_WORKSPACE_CLI_TOKEN';
const GOG_ACCESS_TOKEN_SECRET = 'GOG_ACCESS_TOKEN';
const GOOGLE_SERVICE_ACCOUNT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SERVICE_ACCOUNT_JWT_TTL_SECONDS = 3600;

type CaptureFieldRule = { jsonPath: string; secretName: string };

type ApiHttpRequestBody = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  json?: unknown;
  bearerSecretName?: unknown;
  bearerSecretRef?: unknown;
  secretHeaders?: unknown;
  googleServiceAccount?: unknown;
  replaceSecretPlaceholders?: unknown;
  captureResponseFields?: unknown;
  timeoutMs?: unknown;
  maxResponseBytes?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  skillName?: unknown;
};

type ApiHttpRequestSecretHeaderBody = {
  name?: unknown;
  secretName?: unknown;
  prefix?: unknown;
};

type GoogleServiceAccountAuthRule = {
  clientEmailSecretName: string;
  privateKeySecretName: string;
  scopes: string[];
  subjectSecretName?: string;
};

type SecretResolveContext = {
  sessionId?: string;
  agentId?: string;
  skillName?: string;
  host?: string;
  selector?: string;
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

function hasHeaderValue(
  headers: Record<string, string>,
  name: string,
): boolean {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

function parseBearerSecretRef(value: unknown): SecretRef {
  try {
    return parseSecretRefInput(value, 'bearerSecretRef');
  } catch {
    throw new GatewayRequestError(
      400,
      '`bearerSecretRef` must be a store SecretRef.',
    );
  }
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

function isGoogleWorkspaceRuntimeTokenName(secretName: string): boolean {
  return (
    secretName === GOOGLE_WORKSPACE_CLI_TOKEN_SECRET ||
    secretName === GOG_ACCESS_TOKEN_SECRET
  );
}

function isGoogleApisHost(host?: string): boolean {
  const normalized = normalizeSecretString(host).toLowerCase();
  return (
    normalized === 'googleapis.com' || normalized.endsWith('.googleapis.com')
  );
}

function isGoogleOAuthHttpAuthRuleSecret(
  value: unknown,
): value is RuntimeHttpRequestGoogleOAuthSecretRef {
  return isGoogleOAuthSecretRef(value);
}

async function resolveGoogleOAuthTokenOrThrow(
  secretName: string,
  context: SecretResolveContext,
): Promise<string> {
  if (!isGoogleApisHost(context.host)) {
    throw new GatewayRequestError(
      403,
      `${secretName} can only be injected into googleapis.com requests.`,
    );
  }

  const runtimeEnv = await resolveGoogleWorkspaceRuntimeEnv();
  const token = normalizeSecretString(runtimeEnv[secretName]);
  if (!token) {
    throw new GatewayRequestError(
      400,
      `${secretName} is not available. Run \`hybridclaw auth login google\` and start a fresh agent runtime.`,
    );
  }

  const auditContext = {
    sessionId: context.sessionId,
    skillName: context.skillName,
    secretSource: 'google-oauth' as const,
    secretId: secretName,
    sinkKind: 'http' as const,
    host: context.host,
    selector: context.selector,
  };
  recordSecretResolved(auditContext);
  recordSecretUnsafeEscaped({
    ...auditContext,
    reason: `inject ${secretName} into http sink`,
  });
  rememberResolvedSecretForLeakScan({
    sessionId: normalizeSecretSessionId(context.sessionId),
    secretId: secretName,
    value: token,
  });
  return token;
}

async function resolveHttpSecretOrThrow(
  secretName: string,
  context: SecretResolveContext,
): Promise<string> {
  if (!isRuntimeSecretName(secretName)) {
    throw new GatewayRequestError(400, `Invalid secret name: ${secretName}`);
  }
  if (isGoogleWorkspaceRuntimeTokenName(secretName)) {
    return await resolveGoogleOAuthTokenOrThrow(secretName, context);
  }
  return resolveStoredSecretForInjection({
    secretName,
    sessionId: context.sessionId,
    agentId: context.agentId,
    skillName: context.skillName,
    sinkKind: 'http',
    host: context.host,
    selector: context.selector,
  });
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signGoogleServiceAccountJwt(params: {
  clientEmail: string;
  privateKey: string;
  scopes: string[];
  subject?: string;
}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: params.clientEmail,
    scope: params.scopes.join(' '),
    aud: GOOGLE_SERVICE_ACCOUNT_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + GOOGLE_SERVICE_ACCOUNT_JWT_TTL_SECONDS,
  };
  if (params.subject) payload.sub = params.subject;

  const signingInput = [
    base64UrlJson({ alg: 'RS256', typ: 'JWT' }),
    base64UrlJson(payload),
  ].join('.');
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(params.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function acquireGoogleServiceAccountAccessToken(
  rule: GoogleServiceAccountAuthRule,
  context: SecretResolveContext,
): Promise<string> {
  if (!isGoogleApisHost(context.host)) {
    throw new GatewayRequestError(
      403,
      'Google service-account auth can only be used for googleapis.com requests.',
    );
  }

  const clientEmail = await resolveHttpSecretOrThrow(
    rule.clientEmailSecretName,
    {
      ...context,
      selector: 'googleServiceAccount.clientEmail',
    },
  );
  const privateKey = await resolveHttpSecretOrThrow(rule.privateKeySecretName, {
    ...context,
    selector: 'googleServiceAccount.privateKey',
  });
  const subject = rule.subjectSecretName
    ? await resolveHttpSecretOrThrow(rule.subjectSecretName, {
        ...context,
        selector: 'googleServiceAccount.subject',
      })
    : '';
  const assertion = signGoogleServiceAccountJwt({
    clientEmail,
    privateKey,
    scopes: rule.scopes,
    subject,
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_SERVICE_ACCOUNT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
  } catch (error) {
    throw new GatewayRequestError(
      502,
      `Google service-account token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const responseText = await response.text();
  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseText) as unknown;
  } catch {
    responseJson = undefined;
  }
  if (!response.ok) {
    throw new GatewayRequestError(
      502,
      `Google service-account token exchange returned ${response.status}: ${responseText}`,
    );
  }
  const accessToken =
    responseJson &&
    typeof responseJson === 'object' &&
    typeof (responseJson as Record<string, unknown>).access_token === 'string'
      ? String((responseJson as Record<string, unknown>).access_token).trim()
      : '';
  if (!accessToken) {
    throw new GatewayRequestError(
      502,
      'Google service-account token exchange did not return access_token.',
    );
  }

  rememberResolvedSecretForLeakScan({
    sessionId: normalizeSecretSessionId(context.sessionId),
    secretId: 'GOOGLE_SERVICE_ACCOUNT_ACCESS_TOKEN',
    value: accessToken,
  });
  return accessToken;
}

async function replaceSecretPlaceholdersInString(
  value: string,
  context: SecretResolveContext,
): Promise<string> {
  let next = '';
  let lastIndex = 0;
  for (const match of value.matchAll(HTTP_REQUEST_SECRET_PLACEHOLDER_RE)) {
    const matchIndex = match.index ?? 0;
    next += value.slice(lastIndex, matchIndex);
    next += await resolveHttpSecretOrThrow(match[1] || '', {
      ...context,
      selector: context.selector || '<secret-placeholder>',
    });
    lastIndex = matchIndex + match[0].length;
  }
  next += value.slice(lastIndex);
  return next;
}

async function replaceSecretPlaceholders(
  value: unknown,
  context: SecretResolveContext,
): Promise<unknown> {
  if (typeof value === 'string') {
    return await replaceSecretPlaceholdersInString(value, context);
  }
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((entry) => replaceSecretPlaceholders(entry, context)),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await replaceSecretPlaceholders(entry, {
            ...context,
            selector: context.selector || `json.${key}`,
          }),
        ]),
      ),
    );
  }
  return value;
}

const BOUND_DOMAIN_SUFFIX = '_BOUND_DOMAIN';
const UNBOUND_CAPTURE_JSON_PATHS = new Set(['instance_url']);

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
 * When a captured value is stored as a bearer secret, the gateway stores a
 * domain binding as `{SECRET_NAME}_BOUND_DOMAIN`. If a binding exists, the
 * target URL's hostname must match (exact or subdomain). If no binding exists,
 * any URL is allowed for backward compatibility.
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
    if (isReservedNonSecretRuntimeName(secretName)) {
      throw new GatewayRequestError(
        400,
        `Reserved runtime config name cannot be used in captureResponseFields: ${secretName}`,
      );
    }
    rules.push({ jsonPath, secretName });
  }
  return rules;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeGoogleServiceAccountAuth(
  value: unknown,
): GoogleServiceAccountAuthRule | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayRequestError(
      400,
      'googleServiceAccount must be an object.',
    );
  }
  const record = value as Record<string, unknown>;
  const clientEmailSecretName =
    typeof record.clientEmailSecretName === 'string'
      ? record.clientEmailSecretName.trim()
      : '';
  const privateKeySecretName =
    typeof record.privateKeySecretName === 'string'
      ? record.privateKeySecretName.trim()
      : '';
  const subjectSecretName =
    typeof record.subjectSecretName === 'string'
      ? record.subjectSecretName.trim()
      : '';
  const scopes = normalizeStringArray(record.scopes);

  if (!clientEmailSecretName || !isRuntimeSecretName(clientEmailSecretName)) {
    throw new GatewayRequestError(
      400,
      'googleServiceAccount.clientEmailSecretName must be a valid secret name.',
    );
  }
  if (!privateKeySecretName || !isRuntimeSecretName(privateKeySecretName)) {
    throw new GatewayRequestError(
      400,
      'googleServiceAccount.privateKeySecretName must be a valid secret name.',
    );
  }
  if (subjectSecretName && !isRuntimeSecretName(subjectSecretName)) {
    throw new GatewayRequestError(
      400,
      'googleServiceAccount.subjectSecretName must be a valid secret name.',
    );
  }
  if (scopes.length === 0) {
    throw new GatewayRequestError(
      400,
      'googleServiceAccount.scopes must include at least one scope.',
    );
  }

  return {
    clientEmailSecretName,
    privateKeySecretName,
    scopes,
    ...(subjectSecretName ? { subjectSecretName } : {}),
  };
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
 * Capture selected string fields into the secret store and return only the
 * capture mapping. The original response body is never forwarded to the
 * caller when a capture succeeds.
 *
 * Captured values are domain-bound by default so future `bearerSecretName`
 * injection only works against the resource host. If the response includes an
 * `instance_url` string, bind captured values to that host; otherwise bind to
 * the request host. Non-credential metadata captures must be explicitly
 * exempted.
 */
function captureSecretResponseFields(
  responseJson: unknown,
  rules: CaptureFieldRule[],
  requestUrl: URL,
): Record<string, string> | null {
  if (rules.length === 0) return null;
  if (!responseJson || typeof responseJson !== 'object') return null;
  const obj = responseJson as Record<string, unknown>;

  const baseDomain = extractBindingDomainFromResponse(obj, requestUrl);
  const secrets: Record<string, string> = {};
  const captured: Record<string, string> = {};

  for (const rule of rules) {
    const value = obj[rule.jsonPath];
    if (typeof value === 'string' && value.trim()) {
      secrets[rule.secretName] = value.trim();
      captured[rule.jsonPath] = rule.secretName;

      // Bind captured secrets by default so future token field names such
      // as "access" or "bearer" cannot silently become cross-host credentials.
      if (!UNBOUND_CAPTURE_JSON_PATHS.has(rule.jsonPath)) {
        secrets[`${rule.secretName}${BOUND_DOMAIN_SUFFIX}`] = baseDomain;
      }
    }
  }

  if (Object.keys(secrets).length === 0) {
    return null;
  }

  try {
    saveNamedRuntimeSecrets(secrets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayRequestError(400, message);
  }
  return captured;
}

function resolveCaptureResponseFields(value: unknown): CaptureFieldRule[] {
  if (value === undefined || value === null) return [];
  const fields = normalizeCaptureResponseFields(value);
  if (!fields) {
    throw new GatewayRequestError(
      400,
      '`captureResponseFields` must be an array when provided.',
    );
  }
  return fields;
}

function matchesHttpRequestAuthRulePrefix(
  url: string,
  urlPrefix: string,
): boolean {
  if (url.startsWith(urlPrefix)) return true;
  if (urlPrefix.endsWith('/') && url === urlPrefix.slice(0, -1)) {
    return true;
  }
  return false;
}

async function resolveHttpRequestRuleAssignments(
  url: string,
  config: RuntimeConfig,
  context: SecretResolveContext,
): Promise<Array<{ header: string; value: string }>> {
  const matching = config.tools.httpRequest.authRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => matchesHttpRequestAuthRulePrefix(url, rule.urlPrefix))
    .sort(
      (left, right) =>
        right.rule.urlPrefix.length - left.rule.urlPrefix.length ||
        left.index - right.index,
    );

  const assignments = new Map<string, { header: string; value: string }>();
  for (const { rule, index } of matching) {
    const key = rule.header.toLowerCase();
    if (assignments.has(key)) continue;
    const secret = await resolveHttpRuleSecret(
      rule.secret,
      {
        ...context,
        selector: rule.header,
      },
      `tools.httpRequest.authRules[${index}].secret`,
      rule.header,
      rule.prefix,
    );
    assignments.set(key, secret);
  }
  return Array.from(assignments.values());
}

async function resolveHttpRuleSecret(
  value: unknown,
  context: SecretResolveContext,
  path: string,
  headerName: string,
  prefix: string,
): Promise<{ header: string; value: string }> {
  if (isGoogleOAuthHttpAuthRuleSecret(value)) {
    return {
      header: headerName,
      value: withAuthPrefix(
        await resolveGoogleOAuthTokenOrThrow(
          GOOGLE_WORKSPACE_CLI_TOKEN_SECRET,
          context,
        ),
        prefix,
      ),
    };
  }

  const handle = resolveSecretHandleInput(value, {
    path,
    required: true,
    sinkKind: 'http',
  });
  if (!handle) {
    return {
      header: headerName,
      value: withAuthPrefix(
        String(
          resolveSecretInputUnsafe(value, {
            path,
            required: true,
            reason: `resolve plaintext HTTP auth rule ${path}`,
            audit: makeHttpSecretAuditCallback(context),
          }) || '',
        ),
        prefix,
      ),
    };
  }
  return consumeSecretHandleForHttp(handle, context, headerName, prefix);
}

function consumeSecretHandleForHttp(
  handle: SecretHandle,
  context: SecretResolveContext,
  headerName: string,
  prefix: string,
): { header: string; value: string } {
  assertSecretResolveAllowed({
    sessionId: context.sessionId,
    agentId: context.agentId,
    skillName: context.skillName,
    secretSource: handle.ref.source,
    secretId: handle.ref.id,
    sinkKind: 'http',
    host: context.host,
    selector: context.selector,
  });
  recordSecretResolved({
    sessionId: context.sessionId,
    skillName: context.skillName,
    secretSource: handle.ref.source,
    secretId: handle.ref.id,
    sinkKind: 'http',
    host: context.host,
    selector: context.selector,
  });
  const header = withSecretHeader(handle, headerName, {
    prefix,
    audit: makeHttpSecretAuditCallback(context),
    onCleartext: (value) =>
      rememberResolvedSecretForLeakScan({
        sessionId: normalizeSecretSessionId(context.sessionId),
        secretId: handle.ref.id,
        value,
      }),
  });
  return { header: header.name, value: header.value };
}

function makeHttpSecretAuditCallback(context: SecretResolveContext) {
  return (escapedHandle: SecretHandle, reason: string): void => {
    recordSecretUnsafeEscaped({
      sessionId: context.sessionId,
      skillName: context.skillName,
      secretSource: escapedHandle.ref.source,
      secretId: escapedHandle.ref.id,
      sinkKind: 'http',
      host: context.host,
      selector: context.selector,
      reason,
    });
  };
}

export async function handleApiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiHttpRequestBody;
  const replacePlaceholders = body.replaceSecretPlaceholders !== false;
  const baseSecretContext: SecretResolveContext = {
    sessionId: normalizeSecretString(body.sessionId),
    agentId: normalizeSecretString(body.agentId),
    skillName: normalizeSecretString(body.skillName),
  };
  const captureFields = resolveCaptureResponseFields(
    body.captureResponseFields,
  );
  const rawUrl = replacePlaceholders
    ? await replaceSecretPlaceholdersInString(String(body.url || ''), {
        ...baseSecretContext,
        selector: 'url',
      })
    : body.url;
  const url = await assertHttpRequestUrl(rawUrl);
  const secretContext = {
    ...baseSecretContext,
    host: url.hostname,
  };
  const method = normalizeHttpRequestMethod(body.method);
  const timeoutMs =
    parsePositiveInteger(body.timeoutMs) ?? HTTP_REQUEST_TIMEOUT_MS;
  const maxResponseBytes =
    parsePositiveInteger(body.maxResponseBytes) ??
    HTTP_REQUEST_MAX_RESPONSE_BYTES;
  const config = getRuntimeConfig();

  const headers = normalizeHttpRequestHeaders(body.headers);
  for (const assignment of await resolveHttpRequestRuleAssignments(
    url.toString(),
    config,
    secretContext,
  )) {
    setHeaderValue(headers, assignment.header, assignment.value);
  }

  const bearerSecretName =
    typeof body.bearerSecretName === 'string'
      ? body.bearerSecretName.trim()
      : '';
  const googleServiceAccount = normalizeGoogleServiceAccountAuth(
    body.googleServiceAccount,
  );
  const authModes = [
    bearerSecretName ? 'bearerSecretName' : '',
    body.bearerSecretRef !== undefined ? 'bearerSecretRef' : '',
    googleServiceAccount ? 'googleServiceAccount' : '',
  ].filter(Boolean);
  if (authModes.length > 1) {
    throw new GatewayRequestError(
      400,
      'Use only one of bearerSecretName, bearerSecretRef, or googleServiceAccount.',
    );
  }
  if (bearerSecretName) {
    assertBearerDomainBinding(bearerSecretName, url);
    setHeaderValue(
      headers,
      'Authorization',
      withAuthPrefix(
        await resolveHttpSecretOrThrow(bearerSecretName, {
          ...secretContext,
          selector: 'Authorization',
        }),
        'Bearer',
      ),
    );
  }
  if (body.bearerSecretRef !== undefined) {
    const bearerSecretRef = parseBearerSecretRef(body.bearerSecretRef);
    // SecretRefs cross the F13 rail here: resolveHttpRuleSecret enforces the
    // host/selector policy and injects the handle into the outbound header.
    const assignment = await resolveHttpRuleSecret(
      bearerSecretRef,
      {
        ...secretContext,
        selector: 'Authorization',
      },
      'bearerSecretRef',
      'Authorization',
      'Bearer',
    );
    if (hasHeaderValue(headers, assignment.header)) {
      logger.warn(
        {
          host: secretContext.host,
          header: assignment.header,
        },
        'bearerSecretRef overriding existing outbound HTTP auth header',
      );
    }
    setHeaderValue(headers, assignment.header, assignment.value);
  }
  if (googleServiceAccount) {
    setHeaderValue(
      headers,
      'Authorization',
      withAuthPrefix(
        await acquireGoogleServiceAccountAccessToken(
          googleServiceAccount,
          secretContext,
        ),
        'Bearer',
      ),
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
        await resolveHttpSecretOrThrow(secretHeader.secretName, {
          ...secretContext,
          selector: secretHeader.name,
        }),
        secretHeader.prefix,
      ),
    );
  }

  if (replacePlaceholders) {
    for (const [key, value] of Object.entries(headers)) {
      headers[key] = await replaceSecretPlaceholdersInString(value, {
        ...secretContext,
        selector: key,
      });
    }
  }

  let payloadBody: string | undefined;
  if (body.json !== undefined) {
    const jsonValue = replacePlaceholders
      ? await replaceSecretPlaceholders(body.json, {
          ...secretContext,
          selector: 'json',
        })
      : body.json;
    payloadBody = JSON.stringify(jsonValue);
    if (
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    ) {
      setHeaderValue(headers, 'Content-Type', 'application/json');
    }
  } else if (typeof body.body === 'string') {
    payloadBody = replacePlaceholders
      ? await replaceSecretPlaceholdersInString(body.body, {
          ...secretContext,
          selector: 'body',
        })
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

  // Capture selected response fields into the secret store and return only a
  // confirmation. The original response body is never forwarded on capture.
  const captured = captureSecretResponseFields(
    responseJson,
    captureFields,
    url,
  );
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
