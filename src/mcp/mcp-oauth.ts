/**
 * OAuth 2.1 authorization for remote MCP servers (http/sse transports).
 *
 * Implements the MCP authorization spec on the gateway host:
 * - RFC 9728 protected resource metadata discovery
 * - RFC 8414 authorization server metadata discovery
 * - RFC 7591 dynamic client registration
 * - Authorization code flow with PKCE (S256) and RFC 8707 resource indicators
 *
 * Credentials are stored in the encrypted runtime secret store
 * (`~/.hybridclaw/credentials.json`) under one `MCP_OAUTH_*` entry per server
 * and injected as `Authorization` headers when MCP server configs are handed
 * to the container.
 */
import { createHash } from 'node:crypto';

import {
  type AuthorizationServerMetadata,
  asStringArray,
  asTrimmedString,
  discoverAuthorizationServerMetadata,
  fetchJson,
  generateOAuthState,
  generatePkcePair,
  type OAuthTokenSet,
  registerPublicClient,
  requestToken,
  wellKnownCandidates,
} from '../auth/oauth2-client.js';
import { logger } from '../logger.js';
import {
  readStoredRuntimeSecret,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import type { McpServerConfig } from '../types/models.js';
import { isRecord } from '../utils/type-guards.js';
import { supportsMcpOAuth } from './server-config.js';

const MCP_OAUTH_SECRET_PREFIX = 'MCP_OAUTH_';
const MAX_SECRET_NAME_LENGTH = 128;
const PENDING_FLOW_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const CLIENT_NAME = 'HybridClaw';

export type McpOAuthTokenSet = OAuthTokenSet;

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

const pendingFlows = new Map<string, PendingMcpOAuthFlow>();

/**
 * Map a server name to its runtime secret name. Hex encoding keeps the result
 * within the secret name charset without collisions (`my-server` vs
 * `my_server`); names beyond the 128-char secret name cap fall back to a
 * digest, whose `H_` marker cannot clash with hex output.
 */
function mcpOAuthSecretName(serverName: string): string {
  const hex = Buffer.from(serverName, 'utf-8').toString('hex').toUpperCase();
  const name = `${MCP_OAUTH_SECRET_PREFIX}${hex}`;
  if (name.length <= MAX_SECRET_NAME_LENGTH) return name;
  const digest = createHash('sha256')
    .update(serverName, 'utf-8')
    .digest('hex')
    .toUpperCase();
  return `${MCP_OAUTH_SECRET_PREFIX}H_${digest}`;
}

function readMcpOAuthRecordFromStore(
  serverName: string,
): McpOAuthRecord | null {
  const raw = readStoredRuntimeSecret(mcpOAuthSecretName(serverName));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as unknown as McpOAuthRecord) : null;
  } catch {
    return null;
  }
}

function writeMcpOAuthRecordToStore(
  serverName: string,
  record: McpOAuthRecord,
): void {
  saveNamedRuntimeSecrets({
    [mcpOAuthSecretName(serverName)]: JSON.stringify(record),
  });
}

function pruneExpiredFlows(): void {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > PENDING_FLOW_TTL_MS) {
      pendingFlows.delete(state);
    }
  }
}

function tokenExpiresSoon(tokens: McpOAuthTokenSet): boolean {
  return (
    typeof tokens.expiresAt === 'number' &&
    tokens.expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS
  );
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
  const discovered = await discoverAuthorizationServerMetadata(issuer);
  if (discovered) return discovered;
  const origin = new URL(issuer).origin;
  return {
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
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

  const existing = readMcpOAuthRecordFromStore(input.serverName);
  const canReuseClient =
    existing &&
    existing.serverUrl === serverUrl &&
    existing.redirectUri === input.redirectUri &&
    existing.authorizationEndpoint === authServer.authorizationEndpoint &&
    Boolean(existing.clientId);
  const client = canReuseClient
    ? { clientId: existing.clientId, clientSecret: existing.clientSecret }
    : authServer.registrationEndpoint
      ? await registerPublicClient({
          registrationEndpoint: authServer.registrationEndpoint,
          redirectUri: input.redirectUri,
          clientName: CLIENT_NAME,
        })
      : null;
  if (!client) {
    throw new Error(
      'The MCP authorization server does not support dynamic client registration. Configure the server with a static `Authorization` header instead.',
    );
  }

  const pkce = generatePkcePair();
  const state = generateOAuthState();
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

  writeMcpOAuthRecordToStore(flow.serverName, {
    ...flow.record,
    tokens,
    updatedAt: new Date().toISOString(),
  });
  return { serverName: flow.serverName };
}

export function getMcpOAuthRecord(serverName: string): McpOAuthRecord | null {
  return readMcpOAuthRecordFromStore(serverName);
}

export function clearMcpOAuth(serverName: string): boolean {
  const secretName = mcpOAuthSecretName(serverName);
  if (!readStoredRuntimeSecret(secretName)) return false;
  saveNamedRuntimeSecrets({ [secretName]: null });
  return true;
}

export function getMcpOAuthStatus(
  serverName: string,
  config: Pick<McpServerConfig, 'auth' | 'url'>,
): McpOAuthStatus {
  if (config.auth !== 'oauth') return { method: 'none' };
  const record = readMcpOAuthRecordFromStore(serverName);
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
): Promise<string | null> {
  const record = readMcpOAuthRecordFromStore(serverName);
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
    writeMcpOAuthRecordToStore(serverName, {
      ...record,
      tokens: {
        ...refreshed,
        refreshToken: refreshed.refreshToken || tokens.refreshToken,
      },
      updatedAt: new Date().toISOString(),
    });
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
        const accessToken = await ensureFreshMcpAccessToken(name);
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
