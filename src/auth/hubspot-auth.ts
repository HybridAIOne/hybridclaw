import { randomBytes } from 'node:crypto';
import http from 'node:http';

import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';

const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export const HUBSPOT_ACCOUNT_SECRET = 'HUBSPOT_ACCOUNT';
export const HUBSPOT_OAUTH_CLIENT_ID_SECRET = 'HUBSPOT_CLIENT_ID';
export const HUBSPOT_OAUTH_CLIENT_SECRET_SECRET = 'HUBSPOT_CLIENT_SECRET';
export const HUBSPOT_OAUTH_REFRESH_TOKEN_SECRET = 'HUBSPOT_REFRESH_TOKEN';
export const HUBSPOT_OAUTH_SCOPES_SECRET = 'HUBSPOT_SCOPES';
export const HUBSPOT_ACCESS_TOKEN_SECRET = 'HUBSPOT_ACCESS_TOKEN';

export const DEFAULT_HUBSPOT_OAUTH_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.objects.notes.read',
  'crm.objects.notes.write',
  'crm.objects.tasks.read',
  'crm.objects.tasks.write',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  'crm.schemas.deals.read',
  'oauth',
];

export interface HubSpotStoredAuth {
  account: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string[];
}

export interface HubSpotLoginInput {
  account?: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  refreshToken?: string;
  redirectPort?: number;
}

export interface HubSpotLoginResult {
  account: string;
  scopes: string[];
  secretsPath: string;
  usedProvidedRefreshToken: boolean;
}

interface HubSpotTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
  message?: unknown;
}

let cachedHubSpotAccessToken: {
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

export function parseHubSpotScopes(raw?: string): string[] {
  const value = String(raw || '').trim();
  if (!value) return [...DEFAULT_HUBSPOT_OAUTH_SCOPES];
  return normalizeScopes(value.split(/[,\s]+/));
}

function readSecretOrEnv(name: string): string {
  return (
    String(process.env[name] || '').trim() ||
    readStoredRuntimeSecret(name) ||
    ''
  );
}

export function readStoredHubSpotAuth(): HubSpotStoredAuth | null {
  const account = readSecretOrEnv(HUBSPOT_ACCOUNT_SECRET);
  const clientId = readSecretOrEnv(HUBSPOT_OAUTH_CLIENT_ID_SECRET);
  const clientSecret = readSecretOrEnv(HUBSPOT_OAUTH_CLIENT_SECRET_SECRET);
  const refreshToken = readSecretOrEnv(HUBSPOT_OAUTH_REFRESH_TOKEN_SECRET);
  const scopes = parseHubSpotScopes(
    readSecretOrEnv(HUBSPOT_OAUTH_SCOPES_SECRET),
  );
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

export function buildHubSpotAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(' '),
    state: input.state,
  });
  return `${HUBSPOT_AUTH_URL}?${query.toString()}`;
}

function formatTokenError(payload: HubSpotTokenResponse): string {
  const error = typeof payload.error === 'string' ? payload.error : 'unknown';
  const description =
    typeof payload.error_description === 'string'
      ? payload.error_description
      : typeof payload.message === 'string'
        ? payload.message
        : '';
  return description ? `${error}: ${description}` : error;
}

async function postHubSpotToken(
  params: URLSearchParams,
): Promise<HubSpotTokenResponse> {
  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const payload = (await response
    .json()
    .catch(() => ({}))) as HubSpotTokenResponse;
  if (!response.ok) {
    throw new Error(
      `HubSpot OAuth token request failed: ${formatTokenError(payload)}`,
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
  const payload = await postHubSpotToken(
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
    throw new Error('HubSpot OAuth response did not include a refresh token.');
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
          throw new Error('HubSpot OAuth callback state did not match.');
        }

        const error = requestUrl.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('HubSpot authorization was rejected.');
          throw new Error(`HubSpot OAuth authorization failed: ${error}`);
        }

        const code = requestUrl.searchParams.get('code') || '';
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing OAuth authorization code.');
          throw new Error('HubSpot OAuth callback did not include a code.');
        }

        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const redirectUri = `http://${LOOPBACK_HOST}:${port}/oauth2/callback`;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
          'HubSpot authorization complete. You can close this browser tab.',
        );
        settled = true;
        server.close();
        resolve({ code, redirectUri });
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
      const authorizeUrl = buildHubSpotAuthorizeUrl({
        clientId: input.clientId,
        redirectUri,
        state,
        scopes: input.scopes,
      });
      console.log('Open this HubSpot authorization URL in your browser:');
      console.log(authorizeUrl);
      console.log(`Waiting for OAuth callback on ${redirectUri} ...`);
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('Timed out waiting for HubSpot OAuth callback.'));
    }, timeoutMs).unref();
  });
}

export async function loginHubSpot(
  input: HubSpotLoginInput,
): Promise<HubSpotLoginResult> {
  const scopes = normalizeScopes(input.scopes);
  if (!input.clientId.trim())
    throw new Error('HubSpot OAuth client id is required.');
  if (!input.clientSecret.trim()) {
    throw new Error('HubSpot OAuth client secret is required.');
  }
  if (scopes.length === 0)
    throw new Error('At least one HubSpot OAuth scope is required.');

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

  const account = input.account?.trim() || '';
  const secretsPath = saveNamedRuntimeSecrets({
    [HUBSPOT_ACCOUNT_SECRET]: account,
    [HUBSPOT_OAUTH_CLIENT_ID_SECRET]: input.clientId,
    [HUBSPOT_OAUTH_CLIENT_SECRET_SECRET]: input.clientSecret,
    [HUBSPOT_OAUTH_REFRESH_TOKEN_SECRET]: refreshToken,
    [HUBSPOT_OAUTH_SCOPES_SECRET]: scopes.join(' '),
  });
  cachedHubSpotAccessToken = null;

  return {
    account,
    scopes,
    secretsPath,
    usedProvidedRefreshToken: Boolean(input.refreshToken?.trim()),
  };
}

export function clearHubSpotAuth(): string {
  cachedHubSpotAccessToken = null;
  return saveNamedRuntimeSecrets({
    [HUBSPOT_ACCOUNT_SECRET]: null,
    [HUBSPOT_OAUTH_CLIENT_ID_SECRET]: null,
    [HUBSPOT_OAUTH_CLIENT_SECRET_SECRET]: null,
    [HUBSPOT_OAUTH_REFRESH_TOKEN_SECRET]: null,
    [HUBSPOT_OAUTH_SCOPES_SECRET]: null,
  });
}

export function getHubSpotAuthStatus(): {
  authenticated: boolean;
  account: string;
  scopes: string[];
  path: string;
} {
  const stored = readStoredHubSpotAuth();
  return {
    authenticated: Boolean(stored),
    account: stored?.account || readSecretOrEnv(HUBSPOT_ACCOUNT_SECRET),
    scopes:
      stored?.scopes ||
      parseHubSpotScopes(readSecretOrEnv(HUBSPOT_OAUTH_SCOPES_SECRET)),
    path: runtimeSecretsPath(),
  };
}

export async function mintHubSpotAccessToken(): Promise<{
  accessToken: string;
  expiresIn: number | null;
} | null> {
  const stored = readStoredHubSpotAuth();
  if (!stored) return null;
  const now = Date.now();
  if (
    cachedHubSpotAccessToken &&
    cachedHubSpotAccessToken.expiresAtMs - now > 60_000
  ) {
    return {
      accessToken: cachedHubSpotAccessToken.accessToken,
      expiresIn: Math.max(
        0,
        Math.floor((cachedHubSpotAccessToken.expiresAtMs - now) / 1000),
      ),
    };
  }
  const payload = await postHubSpotToken(
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
      'HubSpot OAuth token response did not include an access token.',
    );
  }
  const accessToken = payload.access_token.trim();
  const expiresIn =
    typeof payload.expires_in === 'number' ? payload.expires_in : null;
  cachedHubSpotAccessToken = {
    accessToken,
    expiresAtMs: now + Math.max(60, expiresIn || 1800) * 1000,
  };
  return { accessToken, expiresIn };
}

export async function resolveHubSpotRuntimeEnv(): Promise<
  Record<string, string>
> {
  const existingToken = String(process.env.HUBSPOT_ACCESS_TOKEN || '').trim();
  if (existingToken) {
    return { HUBSPOT_ACCESS_TOKEN: existingToken };
  }

  const minted = await mintHubSpotAccessToken();
  if (!minted) return {};
  return { HUBSPOT_ACCESS_TOKEN: minted.accessToken };
}
