import { randomBytes } from 'node:crypto';
import http from 'node:http';

import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export const GOOGLE_ACCOUNT_SECRET = 'GOOGLE_ACCOUNT';
export const GOOGLE_OAUTH_CLIENT_ID_SECRET = 'GOOGLE_OAUTH_CLIENT_ID';
export const GOOGLE_OAUTH_CLIENT_SECRET_SECRET = 'GOOGLE_OAUTH_CLIENT_SECRET';
export const GOOGLE_OAUTH_REFRESH_TOKEN_SECRET = 'GOOGLE_OAUTH_REFRESH_TOKEN';
export const GOOGLE_OAUTH_SCOPES_SECRET = 'GOOGLE_OAUTH_SCOPES';

export const DEFAULT_GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
];

export interface GoogleStoredAuth {
  account: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string[];
}

export interface GoogleLoginInput {
  account: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  refreshToken?: string;
  redirectPort?: number;
}

export interface GoogleLoginResult {
  account: string;
  scopes: string[];
  secretsPath: string;
  usedProvidedRefreshToken: boolean;
}

interface GoogleTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

let cachedGogAccessToken: {
  accessToken: string;
  account: string;
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

export function parseGoogleScopes(raw?: string): string[] {
  const value = String(raw || '').trim();
  if (!value) return [...DEFAULT_GOOGLE_OAUTH_SCOPES];
  return normalizeScopes(value.split(/[,\s]+/));
}

function readSecretOrEnv(name: string): string {
  return (
    String(process.env[name] || '').trim() ||
    readStoredRuntimeSecret(name) ||
    ''
  );
}

export function readStoredGoogleAuth(): GoogleStoredAuth | null {
  const account = readSecretOrEnv(GOOGLE_ACCOUNT_SECRET);
  const clientId = readSecretOrEnv(GOOGLE_OAUTH_CLIENT_ID_SECRET);
  const clientSecret = readSecretOrEnv(GOOGLE_OAUTH_CLIENT_SECRET_SECRET);
  const refreshToken = readSecretOrEnv(GOOGLE_OAUTH_REFRESH_TOKEN_SECRET);
  const scopes = parseGoogleScopes(readSecretOrEnv(GOOGLE_OAUTH_SCOPES_SECRET));
  if (!clientId || !clientSecret || !refreshToken) return null;
  return {
    account,
    clientId,
    clientSecret,
    refreshToken,
    scopes,
  };
}

function makeState(): string {
  return randomBytes(24).toString('base64url');
}

function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: input.state,
  });
  return `${GOOGLE_AUTH_URL}?${query.toString()}`;
}

function formatTokenError(payload: GoogleTokenResponse): string {
  const error = typeof payload.error === 'string' ? payload.error : 'unknown';
  const description =
    typeof payload.error_description === 'string'
      ? payload.error_description
      : '';
  return description ? `${error}: ${description}` : error;
}

async function postGoogleToken(
  params: URLSearchParams,
): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const payload = (await response
    .json()
    .catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok) {
    throw new Error(
      `Google OAuth token request failed: ${formatTokenError(payload)}`,
    );
  }
  return payload;
}

async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ refreshToken: string }> {
  const payload = await postGoogleToken(
    new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
  );
  if (
    typeof payload.refresh_token !== 'string' ||
    !payload.refresh_token.trim()
  ) {
    throw new Error(
      'Google OAuth response did not include a refresh token. Re-run with consent enabled or revoke the old grant and try again.',
    );
  }
  return { refreshToken: payload.refresh_token.trim() };
}

async function waitForAuthorizationCode(input: {
  clientId: string;
  scopes: string[];
  redirectPort?: number;
  timeoutMs?: number;
}): Promise<{ code: string; redirectUri: string }> {
  const state = makeState();
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
          throw new Error('Google OAuth callback state did not match.');
        }

        const error = requestUrl.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Google authorization was rejected.');
          throw new Error(`Google OAuth authorization failed: ${error}`);
        }

        const code = requestUrl.searchParams.get('code') || '';
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing OAuth authorization code.');
          throw new Error('Google OAuth callback did not include a code.');
        }

        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const redirectUri = `http://${LOOPBACK_HOST}:${port}/oauth2/callback`;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
          'Google authorization complete. You can close this browser tab.',
        );
        settled = true;
        server.close();
        resolve({
          code,
          redirectUri,
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
      const authorizeUrl = buildAuthorizeUrl({
        clientId: input.clientId,
        redirectUri,
        state,
        scopes: input.scopes,
      });
      console.log('Open this Google authorization URL in your browser:');
      console.log(authorizeUrl);
      console.log(`Waiting for OAuth callback on ${redirectUri} ...`);
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('Timed out waiting for Google OAuth callback.'));
    }, timeoutMs).unref();
  });
}

export async function loginGoogle(
  input: GoogleLoginInput,
): Promise<GoogleLoginResult> {
  const scopes = normalizeScopes(input.scopes);
  if (!input.account.trim())
    throw new Error('Google account email is required.');
  if (!input.clientId.trim())
    throw new Error('Google OAuth client id is required.');
  if (!input.clientSecret.trim()) {
    throw new Error('Google OAuth client secret is required.');
  }
  if (scopes.length === 0)
    throw new Error('At least one Google OAuth scope is required.');

  let refreshToken = input.refreshToken?.trim() || '';
  if (!refreshToken) {
    const authorization = await waitForAuthorizationCode({
      clientId: input.clientId,
      scopes,
      redirectPort: input.redirectPort,
    });
    const exchanged = await exchangeAuthorizationCode({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      code: authorization.code,
      redirectUri: authorization.redirectUri,
    });
    refreshToken = exchanged.refreshToken;
  }

  const secretsPath = saveNamedRuntimeSecrets({
    [GOOGLE_ACCOUNT_SECRET]: input.account,
    [GOOGLE_OAUTH_CLIENT_ID_SECRET]: input.clientId,
    [GOOGLE_OAUTH_CLIENT_SECRET_SECRET]: input.clientSecret,
    [GOOGLE_OAUTH_REFRESH_TOKEN_SECRET]: refreshToken,
    [GOOGLE_OAUTH_SCOPES_SECRET]: scopes.join(' '),
  });
  cachedGogAccessToken = null;

  return {
    account: input.account,
    scopes,
    secretsPath,
    usedProvidedRefreshToken: Boolean(input.refreshToken?.trim()),
  };
}

export function clearGoogleAuth(): string {
  cachedGogAccessToken = null;
  return saveNamedRuntimeSecrets({
    [GOOGLE_ACCOUNT_SECRET]: null,
    [GOOGLE_OAUTH_CLIENT_ID_SECRET]: null,
    [GOOGLE_OAUTH_CLIENT_SECRET_SECRET]: null,
    [GOOGLE_OAUTH_REFRESH_TOKEN_SECRET]: null,
    [GOOGLE_OAUTH_SCOPES_SECRET]: null,
  });
}

export function getGoogleAuthStatus(): {
  authenticated: boolean;
  account: string;
  scopes: string[];
  path: string;
} {
  const stored = readStoredGoogleAuth();
  return {
    authenticated: Boolean(stored),
    account: stored?.account || readSecretOrEnv(GOOGLE_ACCOUNT_SECRET),
    scopes:
      stored?.scopes ||
      parseGoogleScopes(readSecretOrEnv(GOOGLE_OAUTH_SCOPES_SECRET)),
    path: runtimeSecretsPath(),
  };
}

export async function mintGoogleAccessToken(): Promise<{
  accessToken: string;
  expiresIn: number | null;
  account: string;
} | null> {
  const stored = readStoredGoogleAuth();
  if (!stored) return null;
  const now = Date.now();
  if (cachedGogAccessToken && cachedGogAccessToken.expiresAtMs - now > 60_000) {
    return {
      accessToken: cachedGogAccessToken.accessToken,
      expiresIn: Math.max(
        0,
        Math.floor((cachedGogAccessToken.expiresAtMs - now) / 1000),
      ),
      account: cachedGogAccessToken.account,
    };
  }
  const payload = await postGoogleToken(
    new URLSearchParams({
      client_id: stored.clientId,
      client_secret: stored.clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token',
    }),
  );
  if (
    typeof payload.access_token !== 'string' ||
    !payload.access_token.trim()
  ) {
    throw new Error(
      'Google OAuth token response did not include an access token.',
    );
  }
  const accessToken = payload.access_token.trim();
  const expiresIn =
    typeof payload.expires_in === 'number' ? payload.expires_in : null;
  cachedGogAccessToken = {
    accessToken,
    account: stored.account,
    expiresAtMs: now + Math.max(60, expiresIn || 3600) * 1000,
  };
  return { accessToken, expiresIn, account: stored.account };
}

function buildGoogleWorkspaceRuntimeEnv(input: {
  gogAccessToken?: string;
  gwsAccessToken?: string;
  account?: string;
}): Record<string, string> {
  const gwsAccessToken = String(input.gwsAccessToken || '').trim();
  const gogAccessToken = String(input.gogAccessToken || '').trim();
  const accessToken = gwsAccessToken || gogAccessToken;
  if (!accessToken) return {};

  const account = String(input.account || '').trim();
  return {
    GOG_ACCESS_TOKEN: gogAccessToken || accessToken,
    GOOGLE_WORKSPACE_CLI_TOKEN: gwsAccessToken || accessToken,
    ...(account ? { GOG_ACCOUNT: account } : {}),
  };
}

export async function resolveGoogleWorkspaceRuntimeEnv(): Promise<
  Record<string, string>
> {
  const existingGogAccessToken = String(
    process.env.GOG_ACCESS_TOKEN || '',
  ).trim();
  const existingGwsAccessToken = String(
    process.env.GOOGLE_WORKSPACE_CLI_TOKEN || '',
  ).trim();
  const existingAccount =
    String(process.env.GOG_ACCOUNT || '').trim() ||
    readSecretOrEnv(GOOGLE_ACCOUNT_SECRET);
  if (existingGogAccessToken || existingGwsAccessToken) {
    return buildGoogleWorkspaceRuntimeEnv({
      gogAccessToken: existingGogAccessToken,
      gwsAccessToken: existingGwsAccessToken,
      account: existingAccount,
    });
  }

  const minted = await mintGoogleAccessToken();
  if (!minted) return {};
  return buildGoogleWorkspaceRuntimeEnv({
    gogAccessToken: minted.accessToken,
    gwsAccessToken: minted.accessToken,
    account: minted.account,
  });
}

export const resolveGogRuntimeEnv = resolveGoogleWorkspaceRuntimeEnv;
