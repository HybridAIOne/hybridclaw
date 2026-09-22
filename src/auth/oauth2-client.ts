/**
 * OAuth 2.1 client primitives shared by every flow HybridClaw drives as a
 * public client: authorization server discovery (RFC 8414), dynamic client
 * registration (RFC 7591), PKCE (RFC 7636) and the token endpoint.
 *
 * Consumers: the platform sign-in flow (`hybridai-oauth.ts`) and remote MCP
 * server authorization (`mcp/mcp-oauth.ts`).
 */
import { createHash, randomBytes } from 'node:crypto';

import { asStringArray, asTrimmedString } from '../utils/type-guards.js';

const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 20_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;

export const DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code';

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface AuthorizationServerMetadata {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  userinfoEndpoint?: string;
  scopesSupported?: string[];
}

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export async function fetchJson(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(init?.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * RFC 8414 §3.1: `/.well-known/<suffix>` candidates for an issuer, trying the
 * path-aware form first when the issuer has a path component.
 */
export function wellKnownCandidates(baseUrl: string, suffix: string): string[] {
  const parsed = new URL(baseUrl);
  const candidates: string[] = [];
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/') {
    candidates.push(`${parsed.origin}/.well-known/${suffix}${pathname}`);
  }
  candidates.push(`${parsed.origin}/.well-known/${suffix}`);
  return candidates;
}

/**
 * RFC 8414 / OIDC discovery. Returns null when the issuer publishes no usable
 * metadata; callers decide whether to fall back to conventional paths.
 */
export async function discoverAuthorizationServerMetadata(
  issuer: string,
): Promise<AuthorizationServerMetadata | null> {
  const candidates = [
    ...wellKnownCandidates(issuer, 'oauth-authorization-server'),
    ...wellKnownCandidates(issuer, 'openid-configuration'),
  ];
  for (const candidate of candidates) {
    const metadata = await fetchJson(candidate);
    if (!metadata) continue;
    const authorizationEndpoint = asTrimmedString(
      metadata.authorization_endpoint,
    );
    const tokenEndpoint = asTrimmedString(metadata.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) continue;
    return {
      issuer: asTrimmedString(metadata.issuer) || undefined,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint:
        asTrimmedString(metadata.registration_endpoint) || undefined,
      revocationEndpoint:
        asTrimmedString(metadata.revocation_endpoint) || undefined,
      deviceAuthorizationEndpoint:
        asTrimmedString(metadata.device_authorization_endpoint) || undefined,
      userinfoEndpoint:
        asTrimmedString(metadata.userinfo_endpoint) || undefined,
      scopesSupported: asStringArray(metadata.scopes_supported),
    };
  }
  return null;
}

/** RFC 7591 dynamic registration of a public client (no client secret). */
export async function registerPublicClient(input: {
  registrationEndpoint: string;
  redirectUri: string;
  clientName: string;
  /** Defaults to authorization_code + refresh_token. */
  grantTypes?: string[];
}): Promise<{ clientId: string; clientSecret?: string }> {
  let response: Response;
  try {
    response = await fetch(input.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: input.clientName,
        redirect_uris: [input.redirectUri],
        grant_types: input.grantTypes ?? [
          'authorization_code',
          'refresh_token',
        ],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `OAuth client registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const clientId = asTrimmedString(payload.client_id);
  if (!response.ok || !clientId) {
    const detail =
      asTrimmedString(payload.error_description) ||
      asTrimmedString(payload.error) ||
      `HTTP ${response.status}`;
    throw new Error(`OAuth client registration failed (${detail}).`);
  }
  return {
    clientId,
    clientSecret: asTrimmedString(payload.client_secret) || undefined,
  };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export class OAuthTokenRequestError extends Error {
  constructor(
    public readonly code: string,
    description?: string,
  ) {
    super(
      `OAuth token request failed: ${description ? `${code}: ${description}` : code}`,
    );
    this.name = 'OAuthTokenRequestError';
  }
}

export async function requestToken(
  tokenEndpoint: string,
  params: URLSearchParams,
): Promise<OAuthTokenSet> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `OAuth token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    throw new OAuthTokenRequestError(
      asTrimmedString(payload.error) || `HTTP ${response.status}`,
      asTrimmedString(payload.error_description) || undefined,
    );
  }
  const accessToken = asTrimmedString(payload.access_token);
  if (!accessToken) {
    throw new Error('OAuth token response did not include an access token.');
  }
  const expiresIn =
    typeof payload.expires_in === 'number' &&
    Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : null;
  return {
    accessToken,
    refreshToken: asTrimmedString(payload.refresh_token) || undefined,
    expiresAt: expiresIn === null ? undefined : Date.now() + expiresIn * 1000,
    scope: asTrimmedString(payload.scope) || undefined,
  };
}

/** RFC 7009 revocation; best-effort, returns false when the server refused. */
export async function revokeToken(input: {
  revocationEndpoint: string;
  token: string;
  tokenTypeHint: 'access_token' | 'refresh_token';
  clientId: string;
}): Promise<boolean> {
  try {
    const response = await fetch(input.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: input.token,
        token_type_hint: input.tokenTypeHint,
        client_id: input.clientId,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** RFC 8628 §3.1/3.2: ask the server for a device code and a user code. */
export async function requestDeviceAuthorization(input: {
  deviceAuthorizationEndpoint: string;
  clientId: string;
  scope?: string;
}): Promise<DeviceAuthorizationResponse> {
  const params = new URLSearchParams({ client_id: input.clientId });
  if (input.scope) params.set('scope', input.scope);
  let response: Response;
  try {
    response = await fetch(input.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `OAuth device authorization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const deviceCode = asTrimmedString(payload.device_code);
  const userCode = asTrimmedString(payload.user_code);
  const verificationUri = asTrimmedString(payload.verification_uri);
  if (!response.ok || !deviceCode || !userCode || !verificationUri) {
    const detail =
      asTrimmedString(payload.error_description) ||
      asTrimmedString(payload.error) ||
      `HTTP ${response.status}`;
    throw new Error(`OAuth device authorization failed (${detail}).`);
  }
  const expiresIn =
    typeof payload.expires_in === 'number' &&
    Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 300;
  const interval =
    typeof payload.interval === 'number' && Number.isFinite(payload.interval)
      ? payload.interval
      : 5;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete:
      asTrimmedString(payload.verification_uri_complete) || undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    intervalMs: Math.max(0, interval) * 1000,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('OAuth device sign-in canceled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('OAuth device sign-in canceled.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * RFC 8628 §3.4/3.5: poll the token endpoint until the user decides.
 * `authorization_pending` keeps polling, `slow_down` widens the interval,
 * `access_denied` / `expired_token` reject; transient transport errors keep
 * polling until the device code expires.
 */
export async function pollDeviceToken(input: {
  tokenEndpoint: string;
  clientId: string;
  device: DeviceAuthorizationResponse;
  signal?: AbortSignal;
}): Promise<OAuthTokenSet> {
  let intervalMs = input.device.intervalMs;
  const params = new URLSearchParams({
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: input.device.deviceCode,
    client_id: input.clientId,
  });
  while (true) {
    await sleep(intervalMs, input.signal);
    if (Date.now() >= input.device.expiresAt) {
      throw new Error('The sign-in code expired before it was approved.');
    }
    try {
      return await requestToken(input.tokenEndpoint, params);
    } catch (err) {
      if (!(err instanceof OAuthTokenRequestError)) {
        // Transport hiccup: keep polling; expiry above bounds the loop.
        continue;
      }
      if (err.code === 'authorization_pending') continue;
      if (err.code === 'slow_down') {
        intervalMs += SLOW_DOWN_INCREMENT_MS;
        continue;
      }
      if (err.code === 'access_denied') {
        throw new Error('The sign-in request was denied.');
      }
      if (err.code === 'expired_token') {
        throw new Error('The sign-in code expired before it was approved.');
      }
      throw err;
    }
  }
}
