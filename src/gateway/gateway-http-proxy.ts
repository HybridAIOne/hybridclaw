/**
 * Outbound HTTP proxy handler for the gateway.
 *
 * Handles `POST /api/http/request` — routes outbound HTTP calls with secret
 * placeholder resolution, bearer token injection, auth rule matching, and
 * explicit response-field capture.
 */

import { createHash, createHmac, createSign, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  buildConnector as buildUndiciConnector,
  Agent as UndiciAgent,
} from 'undici';

import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { resolveGoogleWorkspaceRuntimeEnv } from '../auth/google-auth.js';
import {
  HUBSPOT_ACCESS_TOKEN_SECRET,
  resolveHubSpotAccessToken,
} from '../auth/hubspot-auth.js';
import {
  MICROSOFT_365_ACCESS_TOKEN_SECRET,
  resolveMicrosoft365AccessToken,
} from '../auth/microsoft-auth.js';
import type {
  RuntimeConfig,
  RuntimeHttpRequestGoogleOAuthSecretRef,
  RuntimeHttpRequestMicrosoftOAuthSecretRef,
} from '../config/runtime-config.js';
import {
  getRuntimeConfig,
  isGoogleOAuthSecretRef,
  isMicrosoftOAuthSecretRef,
} from '../config/runtime-config.js';
import { readStoredRuntimeEnvValue } from '../config/runtime-env.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { sanitizeUploadedMediaFilename } from '../media/uploaded-media-cache.js';
import { evaluateNetworkPolicyAccess } from '../policy/network-policy.js';
import { readPolicyState } from '../policy/policy-store.js';
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
const HTTP_REQUEST_PLACEHOLDER_RE = /<(secret|env):([A-Z][A-Z0-9_]{0,127})>/g;
const REDIRECT_RESPONSE_STATUS_MIN = 300;
const REDIRECT_RESPONSE_STATUS_MAX = 399;
const GOOGLE_WORKSPACE_CLI_TOKEN_SECRET = 'GOOGLE_WORKSPACE_CLI_TOKEN';
const GOG_ACCESS_TOKEN_SECRET = 'GOG_ACCESS_TOKEN';
const GOOGLE_SERVICE_ACCOUNT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SERVICE_ACCOUNT_JWT_TTL_SECONDS = 3600;

type CaptureFieldRule = {
  jsonPath: string;
  secretName: string;
  bindDomain?: string;
};

type CaptureHeaderRule = {
  header: string;
  secretName: string;
  bindDomain?: string;
};

type ApiHttpRequestBody = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  bodyBase64?: unknown;
  form?: unknown;
  json?: unknown;
  bearerSecretName?: unknown;
  bearerSecretRef?: unknown;
  secretHeaders?: unknown;
  googleServiceAccount?: unknown;
  otcAkSk?: unknown;
  replaceSecretPlaceholders?: unknown;
  captureResponseFields?: unknown;
  captureResponseHeaders?: unknown;
  suppressResponseBody?: unknown;
  responseArtifact?: unknown;
  allowManualRedirect?: unknown;
  includeResponseCookies?: unknown;
  tlsCertificateSha256?: unknown;
  tlsCertificateSha256SecretName?: unknown;
  allowSelfSignedTls?: unknown;
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

type OtcAkSkAuthRule = {
  accessKeyIdSecretName: string;
  secretAccessKeySecretName: string;
  securityTokenSecretName?: string;
};

type HttpSecretResolver = (
  secretName: string,
  context: SecretResolveContext,
) => Promise<string> | string;

type UndiciConnector = ReturnType<typeof buildUndiciConnector>;
type UndiciConnectorOptions = Parameters<UndiciConnector>[0];
type UndiciConnectorCallback = Parameters<UndiciConnector>[1];

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

function formatOutboundHttpError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = error.message || error.name || String(error);
  const cause = formatErrorCause(error.cause);
  if (!cause || message.includes(cause)) {
    return message;
  }
  return `${message} (${cause})`;
}

function formatErrorCause(cause: unknown): string {
  if (cause == null) {
    return '';
  }
  if (cause instanceof Error) {
    const message = cause.message || cause.name || String(cause);
    const nestedCause = formatErrorCause(cause.cause);
    if (!nestedCause || message.includes(nestedCause)) {
      return message;
    }
    return `${message} (${nestedCause})`;
  }
  if (typeof cause === 'string') {
    return cause;
  }
  if (typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    const message =
      typeof record.message === 'string' ? record.message.trim() : '';
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    if (message) {
      return code && !message.includes(code) ? `${code} ${message}` : message;
    }
    return code;
  }
  return String(cause);
}

type PrivateHostCheck = {
  blocked: boolean;
  reason: 'private' | 'dns_failed';
};

type ResponseArtifactOptions = {
  filename: string;
  mimeType?: string;
};

function normalizeResponseArtifactOptions(
  value: unknown,
): ResponseArtifactOptions | null {
  if (value !== true && (typeof value !== 'object' || value === null)) {
    return null;
  }
  if (value === true) {
    return { filename: 'http-response' };
  }
  const record = value as Record<string, unknown>;
  const filename = String(record.filename || 'http-response').trim();
  const mimeType = String(record.mimeType || '').trim();
  return {
    filename: filename || 'http-response',
    ...(mimeType ? { mimeType } : {}),
  };
}

async function checkPrivateHost(hostname: string): Promise<PrivateHostCheck> {
  const host = hostname.trim().toLowerCase();
  if (!host) return { blocked: true, reason: 'private' };
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return { blocked: true, reason: 'private' };
  }
  if (net.isIP(host) > 0) {
    return { blocked: isPrivateIp(host), reason: 'private' };
  }
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0) return { blocked: false, reason: 'private' };
    return {
      blocked: resolved.some((entry) => isPrivateIp(entry.address)),
      reason: 'private',
    };
  } catch (error) {
    logger.warn(
      { host, error },
      'DNS lookup failed during SSRF host check; treating host as private/blocked',
    );
    return { blocked: true, reason: 'dns_failed' };
  }
}

function getUrlPort(url: URL): number {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function isPrivateHttpRequestAllowedByPolicy(params: {
  url: URL;
  method: string;
  agentId?: string;
}): boolean {
  const workspacePath = agentWorkspaceDir(params.agentId || DEFAULT_AGENT_ID);
  try {
    const state = readPolicyState(workspacePath);
    const evaluation = evaluateNetworkPolicyAccess({
      defaultAction: state.defaultAction,
      rules: state.rules,
      host: params.url.hostname,
      port: getUrlPort(params.url),
      method: params.method,
      path: params.url.pathname || '/',
      agentId: params.agentId,
    });
    return evaluation.decision === 'allow' && Boolean(evaluation.matchedRule);
  } catch (error) {
    logger.warn(
      { host: params.url.hostname, workspacePath, error },
      'Failed to evaluate network policy for private http_request target; blocking request',
    );
    return false;
  }
}

type HttpResponseReadResult = {
  buffer: Buffer;
  bytesRead: number;
  truncated: boolean;
};

function readDeclaredBodyBytes(response: Response): number | undefined {
  const contentLength = Number.parseInt(
    String(response.headers.get('content-length') || ''),
    10,
  );
  return Number.isFinite(contentLength) ? contentLength : undefined;
}

function responseHeadersObject(
  response: Response,
  includeResponseCookies: boolean,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = Object.fromEntries(
    response.headers.entries(),
  );
  if (!includeResponseCookies) {
    delete headers['set-cookie'];
    return headers;
  }

  const cookieHeaders =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
  const fallbackCookie = response.headers.get('set-cookie');
  if (cookieHeaders.length > 0) {
    headers['set-cookie'] = cookieHeaders;
  } else if (fallbackCookie) {
    headers['set-cookie'] = fallbackCookie;
  }
  return headers;
}

function sendSuppressedBodyResponse(
  res: ServerResponse,
  response: Response,
  bodyBytes: number,
  bodyTruncated: boolean,
  maxResponseBytes: number,
  includeResponseCookies: boolean,
): void {
  sendJson(res, 200, {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: responseHeadersObject(response, includeResponseCookies),
    bodySuppressed: true,
    bodyBytes,
    ...(bodyTruncated
      ? {
          bodyTruncated: true,
          maxResponseBytes,
        }
      : {}),
  });
}

async function saveHttpResponseArtifact(params: {
  body: Buffer;
  response: Response;
  options: ResponseArtifactOptions;
  agentId?: string;
}): Promise<{
  path: string;
  filename: string;
  mimeType: string;
  sha256: string;
}> {
  const workspaceDir = agentWorkspaceDir(params.agentId || DEFAULT_AGENT_ID);
  const artifactDir = path.join(workspaceDir, '.http-artifacts');
  await fs.promises.mkdir(artifactDir, { recursive: true, mode: 0o700 });

  const responseMimeType =
    params.options.mimeType ||
    String(params.response.headers.get('content-type') || '')
      .split(';')[0]
      .trim() ||
    'application/octet-stream';
  const filename = sanitizeUploadedMediaFilename(
    params.options.filename,
    responseMimeType,
  );
  const storedFilename = `${Date.now()}-${randomUUID().slice(0, 8)}-${filename}`;
  const hostPath = path.join(artifactDir, storedFilename);
  await fs.promises.writeFile(hostPath, params.body, { mode: 0o600 });

  return {
    path: `/workspace/.http-artifacts/${storedFilename}`,
    filename,
    mimeType: responseMimeType,
    sha256: sha256Hex(params.body),
  };
}

async function readHttpResponseBuffer(
  response: Response,
  maxResponseBytes: number,
): Promise<HttpResponseReadResult> {
  if (!response.body) {
    if (typeof response.arrayBuffer === 'function') {
      const buffered = Buffer.from(await response.arrayBuffer());
      if (buffered.length <= maxResponseBytes) {
        return {
          buffer: buffered,
          bytesRead: buffered.length,
          truncated: false,
        };
      }
      return {
        buffer: buffered.subarray(0, maxResponseBytes),
        bytesRead: buffered.length,
        truncated: true,
      };
    }
    return { buffer: Buffer.alloc(0), bytesRead: 0, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let bufferedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      bytesRead += value.byteLength;
      const remainingBytes = maxResponseBytes - bufferedBytes;
      if (value.byteLength > remainingBytes) {
        if (remainingBytes > 0) {
          chunks.push(Buffer.from(value.subarray(0, remainingBytes)));
          bufferedBytes += remainingBytes;
        }
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      bufferedBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    buffer: Buffer.concat(chunks),
    bytesRead,
    truncated,
  };
}

async function assertHttpRequestUrl(
  raw: unknown,
  context: { method: string; agentId?: string },
): Promise<URL> {
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

  const privateHostCheck = await checkPrivateHost(parsed.hostname);
  if (privateHostCheck.blocked) {
    const isAllowlisted = isPrivateHttpRequestAllowedByPolicy({
      url: parsed,
      method: context.method,
      agentId: context.agentId,
    });
    if (isAllowlisted) return parsed;
    if (privateHostCheck.reason === 'private') {
      throw new GatewayRequestError(
        400,
        `HTTP request blocked by SSRF guard: private or loopback host (${parsed.hostname}) is not allowlisted by workspace network policy for ${context.method} ${parsed.pathname || '/'} on port ${getUrlPort(parsed)}.`,
      );
    }
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

function isHubSpotApiHost(host?: string): boolean {
  const normalized = normalizeSecretString(host).toLowerCase();
  return (
    normalized === 'api.hubapi.com' ||
    normalized.endsWith('.api.hubapi.com') ||
    normalized === 'api.hubspot.com' ||
    normalized.endsWith('.api.hubspot.com')
  );
}

function isMicrosoftGraphHost(host?: string): boolean {
  return normalizeSecretString(host).toLowerCase() === 'graph.microsoft.com';
}

function requiresBearerDomainBinding(secretName: string): boolean {
  return (
    !isGoogleWorkspaceRuntimeTokenName(secretName) &&
    secretName !== HUBSPOT_ACCESS_TOKEN_SECRET &&
    secretName !== MICROSOFT_365_ACCESS_TOKEN_SECRET
  );
}

function isGoogleOAuthHttpAuthRuleSecret(
  value: unknown,
): value is RuntimeHttpRequestGoogleOAuthSecretRef {
  return isGoogleOAuthSecretRef(value);
}

function isMicrosoftOAuthHttpAuthRuleSecret(
  value: unknown,
): value is RuntimeHttpRequestMicrosoftOAuthSecretRef {
  return isMicrosoftOAuthSecretRef(value);
}

async function resolveOAuthTokenOrThrow(params: {
  secretName: string;
  context: SecretResolveContext;
  isAllowedHost: (host?: string) => boolean;
  allowedHostDescription: string;
  resolveToken: () => Promise<{
    accessToken: string;
    source: 'store' | 'google-oauth' | 'hubspot-oauth' | 'microsoft-oauth';
  } | null>;
  loginHint: string;
}): Promise<string> {
  if (!params.isAllowedHost(params.context.host)) {
    throw new GatewayRequestError(
      403,
      `${params.secretName} can only be injected into ${params.allowedHostDescription} requests.`,
    );
  }

  const resolved = await params.resolveToken();
  if (!resolved?.accessToken) {
    throw new GatewayRequestError(400, params.loginHint);
  }
  const token = normalizeSecretString(resolved.accessToken);
  if (!token) {
    throw new GatewayRequestError(400, params.loginHint);
  }

  const auditContext = {
    sessionId: params.context.sessionId,
    skillName: params.context.skillName,
    secretSource: resolved.source,
    secretId: params.secretName,
    sinkKind: 'http' as const,
    host: params.context.host,
    selector: params.context.selector,
  };
  recordSecretResolved(auditContext);
  recordSecretUnsafeEscaped({
    ...auditContext,
    reason: `inject ${params.secretName} into http sink`,
  });
  rememberResolvedSecretForLeakScan({
    sessionId: normalizeSecretSessionId(params.context.sessionId),
    secretId: params.secretName,
    value: token,
  });
  return token;
}

async function resolveGoogleOAuthTokenOrThrow(
  secretName: string,
  context: SecretResolveContext,
): Promise<string> {
  return await resolveOAuthTokenOrThrow({
    secretName,
    context,
    isAllowedHost: isGoogleApisHost,
    allowedHostDescription: 'googleapis.com',
    resolveToken: async () => {
      const runtimeEnv = await resolveGoogleWorkspaceRuntimeEnv();
      const accessToken = normalizeSecretString(runtimeEnv[secretName]);
      return accessToken
        ? {
            accessToken,
            source: 'google-oauth',
          }
        : null;
    },
    loginHint: `${secretName} is not available. Run \`hybridclaw auth login google\` and start a fresh agent runtime.`,
  });
}

async function resolveHubSpotOAuthTokenOrThrow(
  secretName: string,
  context: SecretResolveContext,
): Promise<string> {
  return await resolveOAuthTokenOrThrow({
    secretName,
    context,
    isAllowedHost: isHubSpotApiHost,
    allowedHostDescription: 'HubSpot API',
    resolveToken: resolveHubSpotAccessToken,
    loginHint: `${secretName} is not available. Store a HubSpot Service Key with \`hybridclaw secret set HUBSPOT_ACCESS_TOKEN <token>\` or in TUI with \`/secret set HUBSPOT_ACCESS_TOKEN <token>\`, or run \`hybridclaw auth login hubspot --access-token <token>\`.`,
  });
}

async function resolveMicrosoftOAuthTokenOrThrow(
  secretName: string,
  context: SecretResolveContext,
): Promise<string> {
  return await resolveOAuthTokenOrThrow({
    secretName,
    context,
    isAllowedHost: isMicrosoftGraphHost,
    allowedHostDescription: 'Microsoft Graph',
    resolveToken: resolveMicrosoft365AccessToken,
    loginHint: `${secretName} is not available. Run \`hybridclaw auth login microsoft365\` and retry the request.`,
  });
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
  if (secretName === HUBSPOT_ACCESS_TOKEN_SECRET) {
    return await resolveHubSpotOAuthTokenOrThrow(secretName, context);
  }
  if (secretName === MICROSOFT_365_ACCESS_TOKEN_SECRET) {
    return await resolveMicrosoftOAuthTokenOrThrow(secretName, context);
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

function isManagedConnectorTokenSecretName(secretName: string): boolean {
  return (
    isGoogleWorkspaceRuntimeTokenName(secretName) ||
    secretName === HUBSPOT_ACCESS_TOKEN_SECRET ||
    secretName === MICROSOFT_365_ACCESS_TOKEN_SECRET
  );
}

function resolveStoredProtocolSecretOrThrow(
  secretName: string,
  context: SecretResolveContext,
): string {
  if (!isRuntimeSecretName(secretName)) {
    throw new GatewayRequestError(400, `Invalid secret name: ${secretName}`);
  }
  if (isManagedConnectorTokenSecretName(secretName)) {
    throw new GatewayRequestError(
      400,
      `${secretName} is a managed connector token and cannot be reused as protocol signing material.`,
    );
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
  // lgtm[js/insufficient-password-hash] Google service account JWTs must be
  // signed with RSA-SHA256; this signs a short-lived assertion, not a password.
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

  const clientEmail = resolveStoredProtocolSecretOrThrow(
    rule.clientEmailSecretName,
    {
      ...context,
      selector: 'googleServiceAccount.clientEmail',
    },
  );
  const privateKey = resolveStoredProtocolSecretOrThrow(
    rule.privateKeySecretName,
    {
      ...context,
      selector: 'googleServiceAccount.privateKey',
    },
  );
  const subject = rule.subjectSecretName
    ? resolveStoredProtocolSecretOrThrow(rule.subjectSecretName, {
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

async function replaceHttpPlaceholdersInString(
  value: string,
  context: SecretResolveContext,
  resolveSecret: HttpSecretResolver = resolveHttpSecretOrThrow,
): Promise<string> {
  let next = '';
  let lastIndex = 0;
  for (const match of value.matchAll(HTTP_REQUEST_PLACEHOLDER_RE)) {
    const matchIndex = match.index ?? 0;
    next += value.slice(lastIndex, matchIndex);
    const kind = match[1] || '';
    const name = match[2] || '';
    if (kind === 'secret') {
      next += await resolveSecret(name, {
        ...context,
        selector: context.selector || '<secret-placeholder>',
      });
    } else {
      const envValue = readStoredRuntimeEnvValue(name);
      if (!envValue) {
        throw new GatewayRequestError(
          400,
          `Env store value ${name} is not configured.`,
        );
      }
      next += envValue;
    }
    lastIndex = matchIndex + match[0].length;
  }
  next += value.slice(lastIndex);
  return next;
}

async function replaceHttpPlaceholders(
  value: unknown,
  context: SecretResolveContext,
  resolveSecret: HttpSecretResolver = resolveHttpSecretOrThrow,
): Promise<unknown> {
  if (typeof value === 'string') {
    return await replaceHttpPlaceholdersInString(value, context, resolveSecret);
  }
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((entry) =>
        replaceHttpPlaceholders(entry, context, resolveSecret),
      ),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await replaceHttpPlaceholders(
            entry,
            {
              ...context,
              selector: context.selector || `json.${key}`,
            },
            resolveSecret,
          ),
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
 * target URL's hostname must match (exact or subdomain).
 */
function assertBearerDomainBinding(secretName: string, targetUrl: URL): void {
  if (!requiresBearerDomainBinding(secretName)) return;

  const bindingKey = `${secretName}${BOUND_DOMAIN_SUFFIX}`;
  const boundDomain = readStoredRuntimeSecret(bindingKey);
  const targetHost = targetUrl.hostname.toLowerCase();
  if (!boundDomain) {
    logger.warn(
      { secretName, targetHost, bindingKey },
      'Secret used without a domain binding; set the matching *_BOUND_DOMAIN runtime secret before unbound secret injection is removed',
    );
    return;
  }

  const allowed = boundDomain.toLowerCase();
  if (targetHost === allowed || targetHost.endsWith(`.${allowed}`)) {
    return;
  }

  throw new GatewayRequestError(
    403,
    `Secret ${secretName} is bound to *.${allowed} — ` +
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
    const rawBindDomain =
      typeof (entry as Record<string, unknown>).bindDomain === 'string'
        ? String((entry as Record<string, unknown>).bindDomain).trim()
        : '';
    let bindDomain: string | undefined;
    if (rawBindDomain) {
      if (!/^[A-Za-z0-9.-]{1,253}$/u.test(rawBindDomain)) {
        throw new GatewayRequestError(
          400,
          `Invalid bindDomain in captureResponseFields: ${rawBindDomain}`,
        );
      }
      bindDomain = extractBaseDomain(rawBindDomain.toLowerCase());
    }
    rules.push({ jsonPath, secretName, ...(bindDomain ? { bindDomain } : {}) });
  }
  return rules;
}

function normalizeCaptureResponseHeaders(
  value: unknown,
): CaptureHeaderRule[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const rules: CaptureHeaderRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const header =
      typeof entry.header === 'string' ? entry.header.trim().toLowerCase() : '';
    const secretName =
      typeof entry.secretName === 'string' ? entry.secretName.trim() : '';
    if (!header || !secretName) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(header)) {
      throw new GatewayRequestError(
        400,
        `Invalid header name in captureResponseHeaders: ${header}`,
      );
    }
    if (!isRuntimeSecretName(secretName)) {
      throw new GatewayRequestError(
        400,
        `Invalid secret name in captureResponseHeaders: ${secretName}`,
      );
    }
    if (isReservedNonSecretRuntimeName(secretName)) {
      throw new GatewayRequestError(
        400,
        `Reserved runtime config name cannot be used in captureResponseHeaders: ${secretName}`,
      );
    }
    const rawBindDomain =
      typeof (entry as Record<string, unknown>).bindDomain === 'string'
        ? String((entry as Record<string, unknown>).bindDomain).trim()
        : '';
    let bindDomain: string | undefined;
    if (rawBindDomain) {
      if (!/^[A-Za-z0-9.-]{1,253}$/u.test(rawBindDomain)) {
        throw new GatewayRequestError(
          400,
          `Invalid bindDomain in captureResponseHeaders: ${rawBindDomain}`,
        );
      }
      bindDomain = extractBaseDomain(rawBindDomain.toLowerCase());
    }
    rules.push({ header, secretName, ...(bindDomain ? { bindDomain } : {}) });
  }
  return rules;
}

function normalizeHttpRequestForm(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayRequestError(
      400,
      '`form` must be an object of string values.',
    );
  }
  const fields: [string, string][] = [];
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name) {
      throw new GatewayRequestError(
        400,
        '`form` field names must be non-empty.',
      );
    }
    if (typeof rawValue !== 'string') {
      throw new GatewayRequestError(
        400,
        '`form` values must be strings. Use `json` for structured payloads.',
      );
    }
    fields.push([name, rawValue]);
  }
  return fields;
}

async function buildHttpRequestFormBody(
  value: unknown,
  context: SecretResolveContext,
  replacePlaceholders: boolean,
  resolveSecret: HttpSecretResolver = resolveHttpSecretOrThrow,
): Promise<string> {
  const params = new URLSearchParams();
  for (const [name, rawValue] of normalizeHttpRequestForm(value)) {
    const resolvedValue = replacePlaceholders
      ? await replaceHttpPlaceholdersInString(
          rawValue,
          {
            ...context,
            selector: `form.${name}`,
          },
          resolveSecret,
        )
      : rawValue;
    params.append(name, resolvedValue);
  }
  return params.toString();
}

async function buildHttpRequestPayloadBody(params: {
  body: ApiHttpRequestBody;
  headers: Record<string, string>;
  context: SecretResolveContext;
  replacePlaceholders: boolean;
  resolveSecret: HttpSecretResolver;
}): Promise<BodyInit | undefined> {
  const { body } = params;
  const payloadSources = [
    body.json !== undefined,
    body.body !== undefined,
    body.bodyBase64 !== undefined,
    body.form !== undefined,
  ].filter(Boolean).length;
  if (payloadSources > 1) {
    throw new GatewayRequestError(
      400,
      'Use only one of `json`, `body`, `bodyBase64`, or `form`.',
    );
  }

  if (body.json !== undefined) {
    const jsonValue = params.replacePlaceholders
      ? await replaceHttpPlaceholders(
          body.json,
          {
            ...params.context,
            selector: 'json',
          },
          params.resolveSecret,
        )
      : body.json;
    if (
      !Object.keys(params.headers).some(
        (key) => key.toLowerCase() === 'content-type',
      )
    ) {
      setHeaderValue(params.headers, 'Content-Type', 'application/json');
    }
    return JSON.stringify(jsonValue);
  }

  if (typeof body.body === 'string') {
    return params.replacePlaceholders
      ? await replaceHttpPlaceholdersInString(
          body.body,
          {
            ...params.context,
            selector: 'body',
          },
          params.resolveSecret,
        )
      : body.body;
  }
  if (body.body !== undefined) {
    throw new GatewayRequestError(
      400,
      '`body` must be a string when provided. Use `json` for structured payloads.',
    );
  }

  if (body.form !== undefined) {
    const payloadBody = await buildHttpRequestFormBody(
      body.form,
      params.context,
      params.replacePlaceholders,
      params.resolveSecret,
    );
    if (
      !Object.keys(params.headers).some(
        (key) => key.toLowerCase() === 'content-type',
      )
    ) {
      setHeaderValue(
        params.headers,
        'Content-Type',
        'application/x-www-form-urlencoded',
      );
    }
    return payloadBody;
  }

  if (typeof body.bodyBase64 === 'string') {
    let payloadBuffer: Buffer;
    try {
      payloadBuffer = Buffer.from(body.bodyBase64, 'base64');
    } catch {
      throw new GatewayRequestError(400, '`bodyBase64` must be valid base64.');
    }
    if (payloadBuffer.toString('base64') !== body.bodyBase64.trim()) {
      throw new GatewayRequestError(400, '`bodyBase64` must be valid base64.');
    }
    return new Uint8Array(payloadBuffer);
  }
  if (body.bodyBase64 !== undefined) {
    throw new GatewayRequestError(
      400,
      '`bodyBase64` must be a base64 string when provided.',
    );
  }

  return undefined;
}

function verifyPinnedTlsCertificateFromSocket(
  socket: unknown,
  expectedSha256: string,
): void {
  const getPeerCertificate =
    typeof (socket as { getPeerCertificate?: unknown }).getPeerCertificate ===
    'function'
      ? (
          socket as {
            getPeerCertificate: (detailed: true) => { raw?: unknown };
          }
        ).getPeerCertificate
      : null;
  if (!getPeerCertificate) {
    throw new GatewayRequestError(
      502,
      'Pinned TLS certificate check failed: peer certificate was not available.',
    );
  }
  const cert = getPeerCertificate.call(socket, true);
  const raw = Buffer.isBuffer(cert.raw) ? cert.raw : null;
  if (!raw) {
    throw new GatewayRequestError(
      502,
      'Pinned TLS certificate check failed: peer certificate was not available.',
    );
  }
  const actual = sha256Hex(raw);
  if (actual !== expectedSha256) {
    throw new GatewayRequestError(
      502,
      'Pinned TLS certificate check failed: SHA-256 fingerprint mismatch.',
    );
  }
}

function createPinnedTlsDispatcher(
  expectedSha256: string,
  timeoutMs: number,
): UndiciAgent {
  const connector = buildUndiciConnector({
    rejectUnauthorized: false,
    timeout: Math.min(timeoutMs, 10_000),
  });
  const pinnedConnector: UndiciConnector = (
    options: UndiciConnectorOptions,
    callback: UndiciConnectorCallback,
  ): void => {
    connector(options, (error, socket) => {
      if (error) {
        callback(error, null);
        return;
      }
      try {
        verifyPinnedTlsCertificateFromSocket(socket, expectedSha256);
        callback(null, socket);
      } catch (pinError) {
        socket.destroy();
        callback(
          pinError instanceof Error ? pinError : new Error(String(pinError)),
          null,
        );
      }
    });
  };
  return new UndiciAgent({ connect: pinnedConnector });
}

function createSelfSignedTlsDispatcher(timeoutMs: number): UndiciAgent {
  return new UndiciAgent({
    connect: buildUndiciConnector({
      rejectUnauthorized: false,
      timeout: Math.min(timeoutMs, 10_000),
    }),
  });
}

function normalizeSha256Fingerprint(value: unknown, path: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const normalized = raw
    .replace(/^sha256:/iu, '')
    .replace(/:/g, '')
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new GatewayRequestError(
      400,
      `${path} must be a SHA-256 fingerprint as 64 hex characters, optionally colon-separated.`,
    );
  }
  return normalized;
}

async function resolveTlsCertificateSha256Pin(
  body: ApiHttpRequestBody,
  context: SecretResolveContext,
): Promise<string | null> {
  const direct = body.tlsCertificateSha256;
  const secretName =
    typeof body.tlsCertificateSha256SecretName === 'string'
      ? body.tlsCertificateSha256SecretName.trim()
      : '';
  if (direct !== undefined && secretName) {
    throw new GatewayRequestError(
      400,
      'Use only one of `tlsCertificateSha256` or `tlsCertificateSha256SecretName`.',
    );
  }
  if (direct !== undefined) {
    return normalizeSha256Fingerprint(direct, 'tlsCertificateSha256');
  }
  if (!secretName) return null;
  return normalizeSha256Fingerprint(
    await resolveHttpSecretOrThrow(secretName, {
      ...context,
      selector: 'tlsCertificateSha256',
    }),
    'tlsCertificateSha256SecretName',
  );
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

function normalizeOtcAkSkAuth(value: unknown): OtcAkSkAuthRule | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayRequestError(400, 'otcAkSk must be an object.');
  }
  const record = value as Record<string, unknown>;
  const accessKeyIdSecretName =
    typeof record.accessKeyIdSecretName === 'string'
      ? record.accessKeyIdSecretName.trim()
      : '';
  const secretAccessKeySecretName =
    typeof record.secretAccessKeySecretName === 'string'
      ? record.secretAccessKeySecretName.trim()
      : '';
  const securityTokenSecretName =
    typeof record.securityTokenSecretName === 'string'
      ? record.securityTokenSecretName.trim()
      : '';

  if (!accessKeyIdSecretName || !isRuntimeSecretName(accessKeyIdSecretName)) {
    throw new GatewayRequestError(
      400,
      'otcAkSk.accessKeyIdSecretName must be a valid secret name.',
    );
  }
  if (
    !secretAccessKeySecretName ||
    !isRuntimeSecretName(secretAccessKeySecretName)
  ) {
    throw new GatewayRequestError(
      400,
      'otcAkSk.secretAccessKeySecretName must be a valid secret name.',
    );
  }
  if (
    securityTokenSecretName &&
    !isRuntimeSecretName(securityTokenSecretName)
  ) {
    throw new GatewayRequestError(
      400,
      'otcAkSk.securityTokenSecretName must be a valid secret name.',
    );
  }
  return {
    accessKeyIdSecretName,
    secretAccessKeySecretName,
    ...(securityTokenSecretName ? { securityTokenSecretName } : {}),
  };
}

function assertOtcAkSkHost(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (
    host === 'otc.t-systems.com' ||
    host.endsWith('.otc.t-systems.com') ||
    host.endsWith('.sc.otc.t-systems.com')
  ) {
    return;
  }
  throw new GatewayRequestError(
    403,
    'otcAkSk can only be used for T Cloud Public / Open Telekom Cloud API hosts.',
  );
}

function encodeCanonicalQueryPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalizeOtcQuery(url: URL): string {
  return Array.from(url.searchParams.entries())
    .map(([key, value]) => [
      encodeCanonicalQueryPart(key),
      encodeCanonicalQueryPart(value),
    ])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function canonicalizeOtcPath(url: URL): string {
  const path = url.pathname || '/';
  const canonical = path
    .split('/')
    .map((segment) => encodeCanonicalQueryPart(decodePathSegment(segment)))
    .join('/');
  return canonical.endsWith('/') ? canonical : `${canonical}/`;
}

function sha256Hex(value: string | Uint8Array | undefined): string {
  // lgtm[js/insufficient-password-hash] SHA-256 is used here for protocol
  // request digests and artifact fingerprints, not for password storage.
  return createHash('sha256')
    .update(value ?? '')
    .digest('hex');
}

function hmacSha256Hex(secret: string, value: string): string {
  // lgtm[js/insufficient-password-hash] SDK-HMAC-SHA256 is the OTC
  // request-signing algorithm; the result is an API signature, not a password.
  return createHmac('sha256', secret).update(value).digest('hex');
}

function formatOtcSdkDate(now = new Date()): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function normalizeCanonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function assertOtcSecretIsNotPlaceholder(
  secretName: string,
  value: string,
): void {
  const normalized = value.trim().toLowerCase();
  const placeholders = new Set([
    'test-access-key',
    'test-secret-key',
    '<your-real-access-key-id>',
    '<your-real-secret-access-key>',
    'your-real-access-key-id',
    'your-real-secret-access-key',
  ]);
  if (placeholders.has(normalized)) {
    throw new GatewayRequestError(
      400,
      `${secretName} contains a placeholder value. Replace it with the real T Cloud Public / Open Telekom Cloud credential before retrying.`,
    );
  }
}

async function applyOtcAkSkSigning(params: {
  rule: OtcAkSkAuthRule;
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | undefined;
  context: SecretResolveContext;
}): Promise<void> {
  assertOtcAkSkHost(params.url);
  if (params.url.protocol !== 'https:') {
    throw new GatewayRequestError(
      400,
      'otcAkSk signing requires an HTTPS T Cloud Public / Open Telekom Cloud URL.',
    );
  }
  if (hasHeaderValue(params.headers, 'Authorization')) {
    throw new GatewayRequestError(
      400,
      'otcAkSk cannot be combined with an explicit Authorization header.',
    );
  }

  const accessKeyId = resolveStoredProtocolSecretOrThrow(
    params.rule.accessKeyIdSecretName,
    {
      ...params.context,
      selector: 'otcAkSk.accessKeyId',
    },
  );
  assertOtcSecretIsNotPlaceholder(
    params.rule.accessKeyIdSecretName,
    accessKeyId,
  );
  const secretAccessKey = resolveStoredProtocolSecretOrThrow(
    params.rule.secretAccessKeySecretName,
    {
      ...params.context,
      selector: 'otcAkSk.secretAccessKey',
    },
  );
  assertOtcSecretIsNotPlaceholder(
    params.rule.secretAccessKeySecretName,
    secretAccessKey,
  );
  const securityToken = params.rule.securityTokenSecretName
    ? resolveStoredProtocolSecretOrThrow(params.rule.securityTokenSecretName, {
        ...params.context,
        selector: 'otcAkSk.securityToken',
      })
    : '';

  const sdkDate = formatOtcSdkDate();
  const bodyHash = sha256Hex(
    typeof params.body === 'string' || params.body instanceof Uint8Array
      ? params.body
      : undefined,
  );
  setHeaderValue(params.headers, 'X-Sdk-Date', sdkDate);
  if (securityToken) {
    setHeaderValue(params.headers, 'X-Security-Token', securityToken);
  }

  const signedHeaderNames = ['host', 'x-sdk-date'];
  if (securityToken) signedHeaderNames.push('x-security-token');
  const headerValues = new Map<string, string>();
  for (const [name, value] of Object.entries(params.headers)) {
    headerValues.set(name.toLowerCase(), normalizeCanonicalHeaderValue(value));
  }
  headerValues.set('host', params.url.host);
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headerValues.get(name) || ''}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalizeOtcPath(params.url),
    canonicalizeOtcQuery(params.url),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');
  const algorithm = 'SDK-HMAC-SHA256';
  const stringToSign = [algorithm, sdkDate, sha256Hex(canonicalRequest)].join(
    '\n',
  );
  const signature = hmacSha256Hex(secretAccessKey, stringToSign);
  setHeaderValue(
    params.headers,
    'Authorization',
    `${algorithm} Access=${accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
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

  const defaultBaseDomain = extractBindingDomainFromResponse(obj, requestUrl);
  const secrets: Record<string, string> = {};
  const captured: Record<string, string> = {};

  for (const rule of rules) {
    const value = normalizeCapturedValue(readJsonPath(obj, rule.jsonPath));
    if (value) {
      secrets[rule.secretName] = value;
      captured[rule.jsonPath] = rule.secretName;

      // Bind captured secrets by default so future token field names such
      // as "access" or "bearer" cannot silently become cross-host credentials.
      if (!UNBOUND_CAPTURE_JSON_PATHS.has(rule.jsonPath)) {
        secrets[`${rule.secretName}${BOUND_DOMAIN_SUFFIX}`] =
          rule.bindDomain || defaultBaseDomain;
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

function captureSecretResponseHeaders(
  responseHeaders: Headers,
  rules: CaptureHeaderRule[],
  requestUrl: URL,
): Record<string, string> | null {
  if (rules.length === 0) return null;
  const defaultBaseDomain = extractBaseDomain(requestUrl.hostname);
  const secrets: Record<string, string> = {};
  const captured: Record<string, string> = {};

  for (const rule of rules) {
    const value = normalizeCapturedValue(responseHeaders.get(rule.header));
    if (value) {
      secrets[rule.secretName] = value;
      captured[`headers.${rule.header}`] = rule.secretName;
      secrets[`${rule.secretName}${BOUND_DOMAIN_SUFFIX}`] =
        rule.bindDomain || defaultBaseDomain;
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

function normalizeCapturedValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function readJsonPath(value: unknown, jsonPath: string): unknown {
  let current = value;
  for (const segment of jsonPath.split('.')) {
    if (!segment) return undefined;
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
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

function resolveCaptureResponseHeaders(value: unknown): CaptureHeaderRule[] {
  if (value === undefined || value === null) return [];
  const headers = normalizeCaptureResponseHeaders(value);
  if (!headers) {
    throw new GatewayRequestError(
      400,
      '`captureResponseHeaders` must be an array when provided.',
    );
  }
  return headers;
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
  if (isMicrosoftOAuthHttpAuthRuleSecret(value)) {
    return {
      header: headerName,
      value: withAuthPrefix(
        await resolveMicrosoftOAuthTokenOrThrow(
          MICROSOFT_365_ACCESS_TOKEN_SECRET,
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
  const captureHeaders = resolveCaptureResponseHeaders(
    body.captureResponseHeaders,
  );
  const rawUrl = replacePlaceholders
    ? await replaceHttpPlaceholdersInString(String(body.url || ''), {
        ...baseSecretContext,
        selector: 'url',
      })
    : body.url;
  const method = normalizeHttpRequestMethod(body.method);
  const url = await assertHttpRequestUrl(rawUrl, {
    method,
    agentId: baseSecretContext.agentId,
  });
  const secretContext = {
    ...baseSecretContext,
    host: url.hostname,
  };
  const timeoutMs =
    parsePositiveInteger(body.timeoutMs) ?? HTTP_REQUEST_TIMEOUT_MS;
  const maxResponseBytes =
    parsePositiveInteger(body.maxResponseBytes) ??
    HTTP_REQUEST_MAX_RESPONSE_BYTES;
  const suppressResponseBody = body.suppressResponseBody === true;
  const responseArtifact = normalizeResponseArtifactOptions(
    body.responseArtifact,
  );
  const allowManualRedirect = body.allowManualRedirect === true;
  const includeResponseCookies = body.includeResponseCookies === true;
  const tlsCertificateSha256 = await resolveTlsCertificateSha256Pin(
    body,
    secretContext,
  );
  const allowSelfSignedTls = body.allowSelfSignedTls === true;
  if (allowSelfSignedTls && tlsCertificateSha256) {
    throw new GatewayRequestError(
      400,
      'Use only one of `allowSelfSignedTls`, `tlsCertificateSha256`, or `tlsCertificateSha256SecretName`.',
    );
  }
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
  const otcAkSk = normalizeOtcAkSkAuth(body.otcAkSk);
  const authModes = [
    bearerSecretName ? 'bearerSecretName' : '',
    body.bearerSecretRef !== undefined ? 'bearerSecretRef' : '',
    googleServiceAccount ? 'googleServiceAccount' : '',
    otcAkSk ? 'otcAkSk' : '',
  ].filter(Boolean);
  if (authModes.length > 1) {
    throw new GatewayRequestError(
      400,
      'Use only one of bearerSecretName, bearerSecretRef, googleServiceAccount, or otcAkSk.',
    );
  }
  if (bearerSecretName) {
    if (requiresBearerDomainBinding(bearerSecretName)) {
      assertBearerDomainBinding(bearerSecretName, url);
    }
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
      headers[key] = await replaceHttpPlaceholdersInString(value, {
        ...secretContext,
        selector: key,
      });
    }
  }

  let payloadBody: BodyInit | undefined;
  if (otcAkSk) {
    const otcPayloadBody = await buildHttpRequestPayloadBody({
      body,
      headers,
      context: secretContext,
      replacePlaceholders,
      resolveSecret: resolveStoredProtocolSecretOrThrow,
    });
    await applyOtcAkSkSigning({
      rule: otcAkSk,
      url,
      method,
      headers,
      body: otcPayloadBody,
      context: secretContext,
    });
    payloadBody = otcPayloadBody;
  } else {
    payloadBody = await buildHttpRequestPayloadBody({
      body,
      headers,
      context: secretContext,
      replacePlaceholders,
      resolveSecret: resolveHttpSecretOrThrow,
    });
  }

  if (
    (tlsCertificateSha256 || allowSelfSignedTls) &&
    url.protocol !== 'https:'
  ) {
    throw new GatewayRequestError(
      400,
      '`allowSelfSignedTls` and `tlsCertificateSha256` can only be used with https URLs.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = tlsCertificateSha256
    ? createPinnedTlsDispatcher(tlsCertificateSha256, timeoutMs)
    : allowSelfSignedTls
      ? createSelfSignedTlsDispatcher(timeoutMs)
      : undefined;
  let response: Response;
  try {
    const fetchOptions: RequestInit & { dispatcher?: UndiciAgent } = {
      method,
      headers,
      body: payloadBody,
      signal: controller.signal,
      redirect: 'manual',
    };
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }
    response = await fetch(url, fetchOptions);
  } catch (error) {
    await dispatcher?.close();
    throw new GatewayRequestError(
      502,
      `Outbound HTTP request failed: ${formatOutboundHttpError(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  try {
    if (
      !allowManualRedirect &&
      response.status >= REDIRECT_RESPONSE_STATUS_MIN &&
      response.status <= REDIRECT_RESPONSE_STATUS_MAX
    ) {
      await response.body?.cancel();
      throw new GatewayRequestError(
        400,
        'Outbound HTTP redirects are blocked by the SSRF guard.',
      );
    }

    const declaredBodyBytes = readDeclaredBodyBytes(response);

    if (
      suppressResponseBody &&
      !responseArtifact &&
      captureFields.length === 0 &&
      captureHeaders.length === 0
    ) {
      await response.body?.cancel();
      sendSuppressedBodyResponse(
        res,
        response,
        declaredBodyBytes ?? 0,
        false,
        maxResponseBytes,
        includeResponseCookies,
      );
      return;
    }

    const responseBody =
      declaredBodyBytes !== undefined && declaredBodyBytes > maxResponseBytes
        ? {
            buffer: Buffer.alloc(0),
            bytesRead: declaredBodyBytes,
            truncated: true,
          }
        : await readHttpResponseBuffer(response, maxResponseBytes);
    const bodyBytes =
      responseBody.truncated && declaredBodyBytes !== undefined
        ? declaredBodyBytes
        : responseBody.bytesRead;
    const bodyTruncated = responseBody.truncated;

    const responseText = responseBody.buffer.toString('utf-8');
    let responseJson: unknown;
    if (!bodyTruncated) {
      try {
        responseJson = JSON.parse(responseText) as unknown;
      } catch {
        responseJson = undefined;
      }
    }

    // Capture selected response fields/headers into the secret store and return only a
    // confirmation. The original response body is never forwarded on capture.
    const capturedFields = captureSecretResponseFields(
      responseJson,
      captureFields,
      url,
    );
    const capturedHeaders = captureSecretResponseHeaders(
      response.headers,
      captureHeaders,
      url,
    );
    const captured =
      capturedFields || capturedHeaders
        ? { ...(capturedFields || {}), ...(capturedHeaders || {}) }
        : null;
    if (captured) {
      sendJson(res, 200, {
        ok: response.ok,
        status: response.status,
        captured,
      });
      return;
    }

    if (responseArtifact) {
      if (bodyTruncated) {
        throw new GatewayRequestError(
          502,
          `Response artifact exceeds maxResponseBytes (${maxResponseBytes}).`,
        );
      }
      const artifact = await saveHttpResponseArtifact({
        body: responseBody.buffer,
        response,
        options: responseArtifact,
        agentId: baseSecretContext.agentId,
      });
      sendJson(res, 200, {
        success: true,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: responseHeadersObject(response, includeResponseCookies),
        artifact,
        artifacts: [artifact],
        bodySuppressed: true,
        bodyBytes,
      });
      return;
    }

    if (suppressResponseBody) {
      sendSuppressedBodyResponse(
        res,
        response,
        bodyBytes,
        bodyTruncated,
        maxResponseBytes,
        includeResponseCookies,
      );
      return;
    }

    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: responseHeadersObject(response, includeResponseCookies),
      body: responseText,
      ...(bodyTruncated
        ? {
            bodyTruncated: true,
            bodyBytes,
            maxResponseBytes,
          }
        : {}),
      ...(responseJson === undefined ? {} : { json: responseJson }),
    });
  } finally {
    await dispatcher?.close();
  }
}
