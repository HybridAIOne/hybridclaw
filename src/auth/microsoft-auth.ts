import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';

const MICROSOFT_AUTHORITY_BASE_URL = 'https://login.microsoftonline.com';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TENANT_ID = 'organizations';

export const MICROSOFT_365_ACCOUNT_SECRET = 'MICROSOFT_365_ACCOUNT';
export const MICROSOFT_365_TENANT_ID_SECRET = 'MICROSOFT_365_TENANT_ID';
export const MICROSOFT_365_OAUTH_CLIENT_ID_SECRET = 'MICROSOFT_365_CLIENT_ID';
export const MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET =
  'MICROSOFT_365_CLIENT_SECRET';
export const MICROSOFT_365_OAUTH_REFRESH_TOKEN_SECRET =
  'MICROSOFT_365_REFRESH_TOKEN';
export const MICROSOFT_365_OAUTH_SCOPES_SECRET = 'MICROSOFT_365_SCOPES';
export const MICROSOFT_365_ACCESS_TOKEN_SECRET = 'MICROSOFT_365_ACCESS_TOKEN';

export const DEFAULT_MICROSOFT_365_OAUTH_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.Read',
  'Files.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Read.All',
  'Chat.Read',
];

export interface Microsoft365StoredAuth {
  account: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string[];
}

export interface Microsoft365LoginInput {
  account?: string;
  tenantId?: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  refreshToken?: string;
  redirectPort?: number;
}

export interface Microsoft365LoginResult {
  account: string;
  tenantId: string;
  scopes: string[];
  secretsPath: string;
  usedProvidedRefreshToken: boolean;
}

export type Microsoft365RuntimeTokenSource = 'microsoft-oauth';

interface MicrosoftTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

let cachedMicrosoft365AccessToken: {
  accessToken: string;
  expiresAtMs: number;
} | null = null;

function normalizeScopes(scopes: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const scope of scopes) {
    const trimmed = String(scope || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function parseMicrosoft365Scopes(raw?: string): string[] {
  const value = String(raw || '').trim();
  if (!value) return [...DEFAULT_MICROSOFT_365_OAUTH_SCOPES];
  return normalizeScopes(value.split(/[,\s]+/));
}

function readSecretOrEnv(name: string): string {
  return (
    String(process.env[name] || '').trim() ||
    readStoredRuntimeSecret(name) ||
    ''
  );
}

function normalizeTenantId(value: string | undefined): string {
  const tenantId = String(value || '').trim() || DEFAULT_TENANT_ID;
  if (!/^[A-Za-z0-9._-]+$/.test(tenantId)) {
    throw new Error(
      'Microsoft 365 tenant id must be a tenant id, verified domain, `common`, `organizations`, or `consumers`.',
    );
  }
  return tenantId;
}

function tokenUrlForTenant(tenantId: string): string {
  return `${MICROSOFT_AUTHORITY_BASE_URL}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

function authorizeUrlForTenant(tenantId: string): string {
  return `${MICROSOFT_AUTHORITY_BASE_URL}/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
}

export function readStoredMicrosoft365Auth(): Microsoft365StoredAuth | null {
  const account = readSecretOrEnv(MICROSOFT_365_ACCOUNT_SECRET);
  const tenantId = normalizeTenantId(
    readSecretOrEnv(MICROSOFT_365_TENANT_ID_SECRET),
  );
  const clientId = readSecretOrEnv(MICROSOFT_365_OAUTH_CLIENT_ID_SECRET);
  const clientSecret = readSecretOrEnv(
    MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET,
  );
  const refreshToken = readSecretOrEnv(
    MICROSOFT_365_OAUTH_REFRESH_TOKEN_SECRET,
  );
  const scopes = parseMicrosoft365Scopes(
    readSecretOrEnv(MICROSOFT_365_OAUTH_SCOPES_SECRET),
  );
  if (!clientId || !refreshToken) return null;
  return {
    account,
    tenantId,
    clientId,
    clientSecret,
    refreshToken,
    scopes,
  };
}

function makeState(): string {
  return randomBytes(24).toString('base64url');
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createMicrosoft365PkcePair(): {
  verifier: string;
  challenge: string;
} {
  return generatePkcePair();
}

export function buildMicrosoft365AuthorizeUrl(input: {
  tenantId?: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  codeChallenge: string;
}): string {
  const tenantId = normalizeTenantId(input.tenantId);
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: normalizeScopes(input.scopes).join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${authorizeUrlForTenant(tenantId)}?${query.toString()}`;
}

function formatTokenError(payload: MicrosoftTokenResponse): string {
  const error = typeof payload.error === 'string' ? payload.error : 'unknown';
  const description =
    typeof payload.error_description === 'string'
      ? payload.error_description
      : '';
  return description ? `${error}: ${description}` : error;
}

async function postMicrosoftToken(
  tenantId: string,
  params: URLSearchParams,
): Promise<MicrosoftTokenResponse> {
  const response = await fetch(tokenUrlForTenant(tenantId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const payload = (await response
    .json()
    .catch(() => ({}))) as MicrosoftTokenResponse;
  if (!response.ok) {
    throw new Error(
      `Microsoft 365 OAuth token request failed: ${formatTokenError(payload)}`,
    );
  }
  return payload;
}

export async function exchangeMicrosoft365AuthorizationCode(input: {
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  scopes: string[];
}): Promise<{ refreshToken: string }> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: input.codeVerifier,
    scope: normalizeScopes(input.scopes).join(' '),
  });
  if (input.clientSecret?.trim()) {
    params.set('client_secret', input.clientSecret.trim());
  }
  const payload = await postMicrosoftToken(input.tenantId, params);
  if (
    typeof payload.refresh_token !== 'string' ||
    !payload.refresh_token.trim()
  ) {
    throw new Error(
      'Microsoft 365 OAuth response did not include a refresh token. Make sure `offline_access` is included in the requested scopes.',
    );
  }
  return { refreshToken: payload.refresh_token.trim() };
}

async function waitForAuthorizationCode(input: {
  tenantId: string;
  clientId: string;
  scopes: string[];
  redirectPort?: number;
  timeoutMs?: number;
}): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
  const state = makeState();
  const pkce = generatePkcePair();
  const timeoutMs = input.timeoutMs || DEFAULT_CALLBACK_TIMEOUT_MS;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', `http://${LOOPBACK_HOST}`);
        if (requestUrl.pathname !== '/oauth2/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const returnedState = requestUrl.searchParams.get('state') || '';
        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid OAuth state. Return to HybridClaw and retry.');
          throw new Error('Microsoft 365 OAuth callback state did not match.');
        }

        const error = requestUrl.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Microsoft 365 authorization was rejected.');
          throw new Error(`Microsoft 365 OAuth authorization failed: ${error}`);
        }

        const code = requestUrl.searchParams.get('code') || '';
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing OAuth authorization code.');
          throw new Error(
            'Microsoft 365 OAuth callback did not include a code.',
          );
        }

        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const redirectUri = `http://${LOOPBACK_HOST}:${port}/oauth2/callback`;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
          'Microsoft 365 authorization complete. You can close this browser tab.',
        );
        settled = true;
        server.close();
        resolve({
          code,
          redirectUri,
          codeVerifier: pkce.verifier,
        });
      } catch (error) {
        settled = true;
        server.close();
        reject(error);
      }
    });

    server.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    server.listen(input.redirectPort || 0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const redirectUri = `http://${LOOPBACK_HOST}:${port}/oauth2/callback`;
      const authorizeUrl = buildMicrosoft365AuthorizeUrl({
        tenantId: input.tenantId,
        clientId: input.clientId,
        redirectUri,
        state,
        scopes: input.scopes,
        codeChallenge: pkce.challenge,
      });
      console.log('Open this Microsoft 365 authorization URL in your browser:');
      console.log(authorizeUrl);
      console.log(`Waiting for OAuth callback on ${redirectUri} ...`);
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('Timed out waiting for Microsoft 365 OAuth callback.'));
    }, timeoutMs).unref();
  });
}

export async function loginMicrosoft365(
  input: Microsoft365LoginInput,
): Promise<Microsoft365LoginResult> {
  const tenantId = normalizeTenantId(input.tenantId);
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret?.trim() || '';
  const scopes = normalizeScopes(input.scopes);
  if (!clientId) throw new Error('Microsoft 365 OAuth client id is required.');
  if (scopes.length === 0) {
    throw new Error('At least one Microsoft 365 OAuth scope is required.');
  }

  let refreshToken = input.refreshToken?.trim() || '';
  if (!refreshToken) {
    const authorization = await waitForAuthorizationCode({
      tenantId,
      clientId,
      scopes,
      redirectPort: input.redirectPort,
    });
    const exchanged = await exchangeMicrosoft365AuthorizationCode({
      tenantId,
      clientId,
      clientSecret,
      code: authorization.code,
      redirectUri: authorization.redirectUri,
      codeVerifier: authorization.codeVerifier,
      scopes,
    });
    refreshToken = exchanged.refreshToken;
  }

  const account = input.account?.trim() || '';
  const secretsPath = saveNamedRuntimeSecrets({
    [MICROSOFT_365_ACCOUNT_SECRET]: account,
    [MICROSOFT_365_TENANT_ID_SECRET]: tenantId,
    [MICROSOFT_365_OAUTH_CLIENT_ID_SECRET]: clientId,
    [MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET]: clientSecret || null,
    [MICROSOFT_365_OAUTH_REFRESH_TOKEN_SECRET]: refreshToken,
    [MICROSOFT_365_OAUTH_SCOPES_SECRET]: scopes.join(' '),
    [MICROSOFT_365_ACCESS_TOKEN_SECRET]: null,
  });
  cachedMicrosoft365AccessToken = null;

  return {
    account,
    tenantId,
    scopes,
    secretsPath,
    usedProvidedRefreshToken: Boolean(input.refreshToken?.trim()),
  };
}

export function clearMicrosoft365Auth(): string {
  cachedMicrosoft365AccessToken = null;
  return saveNamedRuntimeSecrets({
    [MICROSOFT_365_ACCOUNT_SECRET]: null,
    [MICROSOFT_365_TENANT_ID_SECRET]: null,
    [MICROSOFT_365_OAUTH_CLIENT_ID_SECRET]: null,
    [MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET]: null,
    [MICROSOFT_365_OAUTH_REFRESH_TOKEN_SECRET]: null,
    [MICROSOFT_365_OAUTH_SCOPES_SECRET]: null,
    [MICROSOFT_365_ACCESS_TOKEN_SECRET]: null,
  });
}

export function getMicrosoft365AuthStatus(): {
  authenticated: boolean;
  account: string;
  tenantId: string;
  scopes: string[];
  path: string;
  clientSecretConfigured: boolean;
} {
  const stored = readStoredMicrosoft365Auth();
  return {
    authenticated: Boolean(stored),
    account: stored?.account || readSecretOrEnv(MICROSOFT_365_ACCOUNT_SECRET),
    tenantId:
      stored?.tenantId ||
      normalizeTenantId(readSecretOrEnv(MICROSOFT_365_TENANT_ID_SECRET)),
    scopes:
      stored?.scopes ||
      parseMicrosoft365Scopes(
        readSecretOrEnv(MICROSOFT_365_OAUTH_SCOPES_SECRET),
      ),
    path: runtimeSecretsPath(),
    clientSecretConfigured: Boolean(stored?.clientSecret),
  };
}

export async function mintMicrosoft365AccessToken(): Promise<{
  accessToken: string;
  expiresIn: number | null;
} | null> {
  const stored = readStoredMicrosoft365Auth();
  if (!stored) return null;
  const now = Date.now();
  if (
    cachedMicrosoft365AccessToken &&
    cachedMicrosoft365AccessToken.expiresAtMs - now > 60_000
  ) {
    return {
      accessToken: cachedMicrosoft365AccessToken.accessToken,
      expiresIn: Math.max(
        0,
        Math.floor((cachedMicrosoft365AccessToken.expiresAtMs - now) / 1000),
      ),
    };
  }

  const params = new URLSearchParams({
    client_id: stored.clientId,
    refresh_token: stored.refreshToken,
    grant_type: 'refresh_token',
    scope: stored.scopes.join(' '),
  });
  if (stored.clientSecret) {
    params.set('client_secret', stored.clientSecret);
  }
  const payload = await postMicrosoftToken(stored.tenantId, params);
  if (
    typeof payload.access_token !== 'string' ||
    !payload.access_token.trim()
  ) {
    throw new Error(
      'Microsoft 365 OAuth token response did not include an access token.',
    );
  }
  const accessToken = payload.access_token.trim();
  const expiresIn =
    typeof payload.expires_in === 'number' ? payload.expires_in : null;
  cachedMicrosoft365AccessToken = {
    accessToken,
    expiresAtMs: now + Math.max(60, expiresIn || 3600) * 1000,
  };
  return { accessToken, expiresIn };
}

export async function resolveMicrosoft365AccessToken(): Promise<{
  accessToken: string;
  source: Microsoft365RuntimeTokenSource;
} | null> {
  const minted = await mintMicrosoft365AccessToken();
  if (!minted) return null;
  return {
    accessToken: minted.accessToken,
    source: 'microsoft-oauth',
  };
}
