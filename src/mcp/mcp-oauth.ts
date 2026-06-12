/**
 * OAuth 2.1 authorization for remote MCP servers (http/sse transports).
 *
 * Implements the MCP authorization spec on the gateway host:
 * - RFC 9728 protected resource metadata discovery
 * - RFC 8414 authorization server metadata discovery
 * - RFC 7591 dynamic client registration
 * - Authorization code flow with PKCE (S256) and RFC 8707 resource indicators
 *
 * Tokens are stored in `~/.hybridclaw/mcp-oauth.json` (0600) and injected as
 * `Authorization` headers when MCP server configs are handed to the container.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { logger } from '../logger.js';
import type { McpServerConfig } from '../types/models.js';
import { supportsMcpOAuth } from './server-config.js';

const MCP_OAUTH_FILE = 'mcp-oauth.json';
const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 20_000;
const PENDING_FLOW_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const CLIENT_NAME = 'HybridClaw';

export interface McpOAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface McpOAuthRecord {
  serverUrl: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
  tokens?: McpOAuthTokenSet;
  updatedAt: string;
}

export type McpOAuthConnectionState = 'connected' | 'expired' | 'unauthorized';

export interface McpOAuthStatus {
  method: 'oauth' | 'none';
  state?: McpOAuthConnectionState;
  expiresAt?: number | null;
  scope?: string;
}

export interface McpOAuthStartResult {
  serverName: string;
  authorizationUrl: string;
  state: string;
  expiresAt: number;
}

interface PendingMcpOAuthFlow {
  serverName: string;
  verifier: string;
  record: McpOAuthRecord;
  createdAt: number;
}

interface AuthorizationServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
}

const pendingFlows = new Map<string, PendingMcpOAuthFlow>();

function mcpOAuthStorePath(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, MCP_OAUTH_FILE);
}

function readStore(): Record<string, McpOAuthRecord> {
  try {
    const raw = fs.readFileSync(mcpOAuthStorePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, McpOAuthRecord>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, McpOAuthRecord>): void {
  const filePath = mcpOAuthStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort on platforms without chmod support
  }
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function pruneExpiredFlows(): void {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > PENDING_FLOW_TTL_MS) {
      pendingFlows.delete(state);
    }
  }
}

async function fetchJson(
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

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

function tokenExpiresSoon(tokens: McpOAuthTokenSet): boolean {
  return (
    typeof tokens.expiresAt === 'number' &&
    tokens.expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS
  );
}

function wellKnownCandidates(baseUrl: string, suffix: string): string[] {
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
 * RFC 9728: resolve the protected resource metadata for an MCP server URL.
 * Returns the resource identifier, its authorization server issuer, and any
 * advertised scopes. Falls back to treating the MCP origin as the issuer.
 */
export async function discoverProtectedResource(serverUrl: string): Promise<{
  resource: string;
  authorizationServer: string;
  scopes?: string[];
}> {
  for (const candidate of wellKnownCandidates(
    serverUrl,
    'oauth-protected-resource',
  )) {
    const metadata = await fetchJson(candidate);
    if (!metadata) continue;
    const servers = Array.isArray(metadata.authorization_servers)
      ? metadata.authorization_servers.filter(
          (entry): entry is string =>
            typeof entry === 'string' && Boolean(entry.trim()),
        )
      : [];
    return {
      resource: asTrimmedString(metadata.resource) || serverUrl,
      authorizationServer: servers[0] || new URL(serverUrl).origin,
      scopes: asStringArray(metadata.scopes_supported),
    };
  }
  return {
    resource: serverUrl,
    authorizationServer: new URL(serverUrl).origin,
  };
}

/**
 * RFC 8414 / OIDC discovery for the authorization server, with a static
 * fallback to conventional `/authorize`, `/token`, and `/register` paths.
 */
export async function discoverAuthorizationServer(
  issuer: string,
): Promise<AuthorizationServerMetadata> {
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
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint:
        asTrimmedString(metadata.registration_endpoint) || undefined,
      scopesSupported: asStringArray(metadata.scopes_supported),
    };
  }
  const origin = new URL(issuer).origin;
  return {
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
  };
}

/** RFC 7591 dynamic client registration. */
async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  let response: Response;
  try {
    response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `MCP OAuth client registration failed: ${err instanceof Error ? err.message : String(err)}`,
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
    throw new Error(
      `MCP OAuth client registration failed (${detail}). The authorization server may require a manually configured client id.`,
    );
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

async function requestToken(
  tokenEndpoint: string,
  params: URLSearchParams,
): Promise<McpOAuthTokenSet> {
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
      `MCP OAuth token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    const error = asTrimmedString(payload.error) || `HTTP ${response.status}`;
    const description = asTrimmedString(payload.error_description);
    throw new Error(
      `MCP OAuth token request failed: ${description ? `${error}: ${description}` : error}`,
    );
  }
  const accessToken = asTrimmedString(payload.access_token);
  if (!accessToken) {
    throw new Error(
      'MCP OAuth token response did not include an access token.',
    );
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

/**
 * Begin an authorization flow for a remote MCP server. Performs discovery and
 * (when needed) dynamic client registration, then returns the authorization
 * URL the user must open in a browser. The flow is completed by
 * `completeMcpOAuthFlow` when the authorization server redirects back.
 */
export async function startMcpOAuthFlow(input: {
  serverName: string;
  serverUrl: string;
  redirectUri: string;
  scope?: string;
}): Promise<McpOAuthStartResult> {
  pruneExpiredFlows();
  const serverUrl = input.serverUrl.trim();
  if (!/^https?:\/\//i.test(serverUrl)) {
    throw new Error('MCP OAuth requires an http(s) server URL.');
  }

  const resource = await discoverProtectedResource(serverUrl);
  const authServer = await discoverAuthorizationServer(
    resource.authorizationServer,
  );

  const requestedScope =
    input.scope?.trim() ||
    (resource.scopes?.length ? resource.scopes.join(' ') : '') ||
    (authServer.scopesSupported?.length
      ? authServer.scopesSupported.join(' ')
      : '');

  const existing = readStore()[input.serverName];
  const canReuseClient =
    existing &&
    existing.serverUrl === serverUrl &&
    existing.redirectUri === input.redirectUri &&
    existing.authorizationEndpoint === authServer.authorizationEndpoint &&
    Boolean(existing.clientId);
  const client = canReuseClient
    ? { clientId: existing.clientId, clientSecret: existing.clientSecret }
    : authServer.registrationEndpoint
      ? await registerClient(authServer.registrationEndpoint, input.redirectUri)
      : null;
  if (!client) {
    throw new Error(
      'The MCP authorization server does not support dynamic client registration. Configure the server with a static `Authorization` header instead.',
    );
  }

  const pkce = generatePkcePair();
  const state = randomBytes(32).toString('base64url');
  const record: McpOAuthRecord = {
    serverUrl,
    resource: resource.resource,
    authorizationEndpoint: authServer.authorizationEndpoint,
    tokenEndpoint: authServer.tokenEndpoint,
    registrationEndpoint: authServer.registrationEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: input.redirectUri,
    scope: requestedScope || undefined,
    tokens: undefined,
    updatedAt: new Date().toISOString(),
  };

  pendingFlows.set(state, {
    serverName: input.serverName,
    verifier: pkce.verifier,
    record,
    createdAt: Date.now(),
  });

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
    resource: resource.resource,
  });
  if (requestedScope) query.set('scope', requestedScope);
  const separator = authServer.authorizationEndpoint.includes('?') ? '&' : '?';
  return {
    serverName: input.serverName,
    authorizationUrl: `${authServer.authorizationEndpoint}${separator}${query.toString()}`,
    state,
    expiresAt: Date.now() + PENDING_FLOW_TTL_MS,
  };
}

/** Exchange the authorization code delivered to the redirect URI for tokens. */
export async function completeMcpOAuthFlow(input: {
  state: string;
  code: string;
}): Promise<{ serverName: string }> {
  pruneExpiredFlows();
  const flow = pendingFlows.get(input.state);
  if (!flow) {
    throw new Error(
      'Unknown or expired MCP OAuth state. Restart the login flow.',
    );
  }
  pendingFlows.delete(input.state);

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: flow.record.redirectUri,
    client_id: flow.record.clientId,
    code_verifier: flow.verifier,
    resource: flow.record.resource,
  });
  if (flow.record.clientSecret) {
    params.set('client_secret', flow.record.clientSecret);
  }
  const tokens = await requestToken(flow.record.tokenEndpoint, params);

  const store = readStore();
  store[flow.serverName] = {
    ...flow.record,
    tokens,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return { serverName: flow.serverName };
}

export function getMcpOAuthRecord(serverName: string): McpOAuthRecord | null {
  return readStore()[serverName] || null;
}

export function clearMcpOAuth(serverName: string): boolean {
  const store = readStore();
  if (!store[serverName]) return false;
  delete store[serverName];
  writeStore(store);
  return true;
}

export function getMcpOAuthStatus(
  serverName: string,
  config: Pick<McpServerConfig, 'auth' | 'url'>,
): McpOAuthStatus {
  if (config.auth !== 'oauth') return { method: 'none' };
  const record = readStore()[serverName];
  if (
    !record?.tokens?.accessToken ||
    (config.url && record.serverUrl !== config.url.trim())
  ) {
    return { method: 'oauth', state: 'unauthorized' };
  }
  const expiresAt = record.tokens.expiresAt ?? null;
  if (tokenExpiresSoon(record.tokens) && !record.tokens.refreshToken) {
    return { method: 'oauth', state: 'expired', expiresAt };
  }
  return {
    method: 'oauth',
    state: 'connected',
    expiresAt,
    scope: record.tokens.scope || record.scope,
  };
}

/**
 * Return a fresh access token for a server, refreshing via the stored refresh
 * token when the current one is missing or about to expire. Returns null when
 * the server has no usable credentials (the user must re-run the login flow).
 */
export async function ensureFreshMcpAccessToken(
  serverName: string,
  records: Record<string, McpOAuthRecord> = readStore(),
): Promise<string | null> {
  const record = records[serverName];
  const tokens = record?.tokens;
  if (!record || !tokens?.accessToken) return null;

  if (!tokenExpiresSoon(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: record.clientId,
    resource: record.resource,
  });
  if (record.clientSecret) params.set('client_secret', record.clientSecret);

  try {
    const refreshed = await requestToken(record.tokenEndpoint, params);
    const store = readStore();
    store[serverName] = {
      ...record,
      tokens: {
        ...refreshed,
        refreshToken: refreshed.refreshToken || tokens.refreshToken,
      },
      updatedAt: new Date().toISOString(),
    };
    writeStore(store);
    return refreshed.accessToken;
  } catch (err) {
    logger.warn(
      { serverName, err: err instanceof Error ? err.message : String(err) },
      'MCP OAuth token refresh failed',
    );
    return null;
  }
}

/**
 * Resolve the MCP server map handed to the container: for servers configured
 * with `auth: "oauth"`, inject a fresh `Authorization` header. Servers without
 * usable credentials are passed through unchanged and will surface as
 * unauthorized in `/mcp list` and the console.
 */
export async function resolveMcpServersForRuntime(
  servers: Record<string, McpServerConfig>,
): Promise<Record<string, McpServerConfig>> {
  const records = readStore();
  const entries = await Promise.all(
    Object.entries(servers).map(
      async ([name, config]): Promise<[string, McpServerConfig]> => {
        if (
          config.auth !== 'oauth' ||
          config.enabled === false ||
          !supportsMcpOAuth(config.transport)
        ) {
          return [name, config];
        }
        const accessToken = await ensureFreshMcpAccessToken(name, records);
        if (!accessToken) return [name, config];
        return [
          name,
          {
            ...config,
            headers: {
              ...config.headers,
              Authorization: `Bearer ${accessToken}`,
            },
          },
        ];
      },
    ),
  );
  return Object.fromEntries(entries);
}
