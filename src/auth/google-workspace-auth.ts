import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';

import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';

export const GOOGLE_WORKSPACE_PROVIDER = 'google-workspace';
export const GOOGLE_WORKSPACE_REDIRECT_URI = 'http://localhost:1';
export const GOOGLE_WORKSPACE_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_WORKSPACE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_WORKSPACE_REFRESH_SKEW_MS = 2 * 60_000;
export const GOOGLE_WORKSPACE_CLIENT_SECRET_KEY =
  'GOOGLE_WORKSPACE_CLIENT_SECRET_JSON';
export const GOOGLE_WORKSPACE_TOKEN_KEY = 'GOOGLE_WORKSPACE_TOKEN_JSON';
export const GOOGLE_WORKSPACE_PENDING_AUTH_KEY =
  'GOOGLE_WORKSPACE_PENDING_AUTH_JSON';
export const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents.readonly',
] as const;

type GoogleWorkspaceAuthErrorCode =
  | 'google_workspace_client_secret_missing'
  | 'google_workspace_client_secret_invalid'
  | 'google_workspace_pending_auth_missing'
  | 'google_workspace_pending_auth_invalid'
  | 'google_workspace_state_mismatch'
  | 'google_workspace_token_missing'
  | 'google_workspace_token_invalid'
  | 'google_workspace_token_exchange_failed'
  | 'google_workspace_refresh_failed';

interface StoredGoogleWorkspaceClientSecret {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

interface StoredGoogleWorkspaceToken {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  expiresAt: number;
  updatedAt: string;
}

interface StoredGoogleWorkspacePendingAuth {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  createdAt: string;
}

interface RawGoogleClientSecretSection {
  client_id?: unknown;
  client_secret?: unknown;
  auth_uri?: unknown;
  token_uri?: unknown;
}

interface RawGoogleClientSecretFile {
  installed?: RawGoogleClientSecretSection;
  web?: RawGoogleClientSecretSection;
}

export interface GoogleWorkspaceAuthStatus {
  authenticated: boolean;
  path: string;
  clientConfigured: boolean;
  pendingAuthorization: boolean;
  refreshTokenConfigured: boolean;
  reloginRequired: boolean;
  expiresAt: number | null;
  scopes: string[];
}

export interface SaveGoogleWorkspaceClientSecretResult {
  path: string;
  clientId: string;
}

export interface StartGoogleWorkspaceAuthResult {
  path: string;
  authUrl: string;
  redirectUri: string;
}

export interface ExchangeGoogleWorkspaceAuthCodeResult {
  path: string;
  expiresAt: number;
  scopes: string[];
}

export interface EnsureFreshGoogleWorkspaceAccessTokenResult {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  refreshed: boolean;
}

export class GoogleWorkspaceAuthError extends Error {
  code: GoogleWorkspaceAuthErrorCode;
  reloginRequired: boolean;

  constructor(
    code: GoogleWorkspaceAuthErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      reloginRequired?: boolean;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GoogleWorkspaceAuthError';
    this.code = code;
    this.reloginRequired = options?.reloginRequired === true;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeString(entry))
      .filter((entry) => entry.length > 0);
  }
  const raw = normalizeString(value);
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generatePkcePair(): {
  verifier: string;
  challenge: string;
} {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return toBase64Url(randomBytes(32));
}

function parseJsonSecret(
  key: string,
  raw: string | null,
): Record<string, unknown> | null {
  const normalized = raw?.trim() || '';
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (cause) {
    throw new GoogleWorkspaceAuthError(
      key === GOOGLE_WORKSPACE_CLIENT_SECRET_KEY
        ? 'google_workspace_client_secret_invalid'
        : key === GOOGLE_WORKSPACE_PENDING_AUTH_KEY
          ? 'google_workspace_pending_auth_invalid'
          : 'google_workspace_token_invalid',
      `Stored Google Workspace auth data for ${key} is not valid JSON.`,
      {
        cause,
        reloginRequired: key !== GOOGLE_WORKSPACE_CLIENT_SECRET_KEY,
      },
    );
  }

  throw new GoogleWorkspaceAuthError(
    key === GOOGLE_WORKSPACE_CLIENT_SECRET_KEY
      ? 'google_workspace_client_secret_invalid'
      : key === GOOGLE_WORKSPACE_PENDING_AUTH_KEY
        ? 'google_workspace_pending_auth_invalid'
        : 'google_workspace_token_invalid',
    `Stored Google Workspace auth data for ${key} has an invalid structure.`,
    {
      reloginRequired: key !== GOOGLE_WORKSPACE_CLIENT_SECRET_KEY,
    },
  );
}

function readStoredClientSecret(): StoredGoogleWorkspaceClientSecret | null {
  const parsed = parseJsonSecret(
    GOOGLE_WORKSPACE_CLIENT_SECRET_KEY,
    readStoredRuntimeSecret(GOOGLE_WORKSPACE_CLIENT_SECRET_KEY),
  );
  if (!parsed) return null;

  const clientId = normalizeString(parsed.clientId);
  const clientSecret = normalizeString(parsed.clientSecret);
  if (!clientId || !clientSecret) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_client_secret_invalid',
      'Stored Google Workspace client secret is missing required fields.',
    );
  }

  return {
    clientId,
    clientSecret,
    authUri: normalizeString(parsed.authUri) || GOOGLE_WORKSPACE_AUTH_URL,
    tokenUri: normalizeString(parsed.tokenUri) || GOOGLE_WORKSPACE_TOKEN_URL,
  };
}

function requireStoredClientSecret(): StoredGoogleWorkspaceClientSecret {
  const clientSecret = readStoredClientSecret();
  if (clientSecret) return clientSecret;
  throw new GoogleWorkspaceAuthError(
    'google_workspace_client_secret_missing',
    'Google Workspace client secret is not configured. Run `hybridclaw auth login google-workspace --client-secret <path>` first.',
  );
}

function readStoredToken(): StoredGoogleWorkspaceToken | null {
  const parsed = parseJsonSecret(
    GOOGLE_WORKSPACE_TOKEN_KEY,
    readStoredRuntimeSecret(GOOGLE_WORKSPACE_TOKEN_KEY),
  );
  if (!parsed) return null;

  const accessToken = normalizeString(parsed.accessToken);
  const refreshToken = normalizeString(parsed.refreshToken);
  const tokenType = normalizeString(parsed.tokenType) || 'Bearer';
  const expiresAt = normalizeTimestamp(parsed.expiresAt);
  const scopes = normalizeScopes(parsed.scopes);
  if (!accessToken && !refreshToken) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_token_invalid',
      'Stored Google Workspace token is missing both access and refresh tokens.',
      { reloginRequired: true },
    );
  }

  return {
    accessToken,
    refreshToken,
    tokenType,
    expiresAt,
    scopes,
    updatedAt: normalizeString(parsed.updatedAt) || nowIso(),
  };
}

function requireStoredPendingAuth(): StoredGoogleWorkspacePendingAuth {
  const parsed = parseJsonSecret(
    GOOGLE_WORKSPACE_PENDING_AUTH_KEY,
    readStoredRuntimeSecret(GOOGLE_WORKSPACE_PENDING_AUTH_KEY),
  );
  if (!parsed) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_pending_auth_missing',
      'No pending Google Workspace OAuth session was found. Run `hybridclaw auth login google-workspace --auth-url` first.',
    );
  }

  const state = normalizeString(parsed.state);
  const codeVerifier = normalizeString(parsed.codeVerifier);
  const redirectUri =
    normalizeString(parsed.redirectUri) || GOOGLE_WORKSPACE_REDIRECT_URI;
  const scopes = normalizeScopes(parsed.scopes);
  if (!state || !codeVerifier) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_pending_auth_invalid',
      'Stored Google Workspace OAuth session is missing PKCE state.',
    );
  }

  return {
    state,
    codeVerifier,
    redirectUri,
    scopes: scopes.length > 0 ? scopes : [...GOOGLE_WORKSPACE_SCOPES],
    createdAt: normalizeString(parsed.createdAt) || nowIso(),
  };
}

function buildTokenExpiresAt(expiresIn: unknown): number {
  const numeric =
    typeof expiresIn === 'number'
      ? expiresIn
      : typeof expiresIn === 'string'
        ? Number(expiresIn)
        : 0;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Date.now() + 60 * 60_000;
  }
  return Date.now() + numeric * 1_000;
}

function extractClientSecretSection(
  raw: RawGoogleClientSecretFile,
): RawGoogleClientSecretSection {
  return raw.installed || raw.web || {};
}

function parseGoogleClientSecretJson(
  raw: string,
): StoredGoogleWorkspaceClientSecret {
  let parsed: RawGoogleClientSecretFile;
  try {
    parsed = JSON.parse(raw) as RawGoogleClientSecretFile;
  } catch (cause) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_client_secret_invalid',
      'Google Workspace client secret file is not valid JSON.',
      { cause },
    );
  }

  const section = extractClientSecretSection(parsed);
  const clientId = normalizeString(section.client_id);
  const clientSecret = normalizeString(section.client_secret);
  if (!clientId || !clientSecret) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_client_secret_invalid',
      'Google Workspace client secret file is missing `client_id` or `client_secret`.',
    );
  }

  return {
    clientId,
    clientSecret,
    authUri: normalizeString(section.auth_uri) || GOOGLE_WORKSPACE_AUTH_URL,
    tokenUri: normalizeString(section.token_uri) || GOOGLE_WORKSPACE_TOKEN_URL,
  };
}

function parseTokenResponsePayload(
  payload: unknown,
  fallbackMessage: string,
): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fallbackMessage;
  }

  const record = payload as Record<string, unknown>;
  const error = normalizeString(record.error);
  const description =
    normalizeString(record.error_description) ||
    normalizeString(record.errorDescription) ||
    normalizeString(record.message);
  if (error && description) return `${error}: ${description}`;
  if (description) return description;
  if (error) return error;
  return fallbackMessage;
}

function buildAuthUrl(params: {
  clientId: string;
  authUri: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: string[];
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    include_granted_scopes: 'true',
    state: params.state,
  });
  return `${params.authUri}?${query.toString()}`;
}

function extractCodeAndState(codeOrUrl: string): {
  code: string;
  state: string | null;
} {
  const trimmed = codeOrUrl.trim();
  if (!trimmed) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_pending_auth_missing',
      'Google Workspace authorization code cannot be empty.',
    );
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return {
      code: trimmed,
      state: null,
    };
  }

  const parsed = new URL(trimmed);
  const code = normalizeString(parsed.searchParams.get('code'));
  if (!code) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_pending_auth_invalid',
      'Google Workspace redirect URL does not contain a `code` parameter.',
    );
  }

  return {
    code,
    state: normalizeString(parsed.searchParams.get('state')) || null,
  };
}

async function exchangeTokenRequest(
  tokenUri: string,
  body: URLSearchParams,
  errorCode:
    | 'google_workspace_token_exchange_failed'
    | 'google_workspace_refresh_failed',
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(tokenUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (cause) {
    throw new GoogleWorkspaceAuthError(
      errorCode,
      `Google Workspace token request failed: ${cause instanceof Error ? cause.message : String(cause)}.`,
      {
        cause,
        reloginRequired: errorCode === 'google_workspace_refresh_failed',
      },
    );
  }

  let payload: unknown = null;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new GoogleWorkspaceAuthError(
      errorCode,
      parseTokenResponsePayload(
        payload,
        `Google Workspace token request failed with HTTP ${response.status}.`,
      ),
      {
        reloginRequired: errorCode === 'google_workspace_refresh_failed',
      },
    );
  }

  return payload as Record<string, unknown>;
}

export function saveGoogleWorkspaceClientSecretFile(
  filePath: string,
): SaveGoogleWorkspaceClientSecretResult {
  const resolved = filePath.trim();
  if (!resolved) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_client_secret_missing',
      'Google Workspace client secret path cannot be empty.',
    );
  }
  const raw = fs.readFileSync(resolved, 'utf-8');
  const clientSecret = parseGoogleClientSecretJson(raw);
  const path = saveNamedRuntimeSecrets({
    [GOOGLE_WORKSPACE_CLIENT_SECRET_KEY]: JSON.stringify(clientSecret),
  });
  return {
    path,
    clientId: clientSecret.clientId,
  };
}

export function startGoogleWorkspaceAuth(): StartGoogleWorkspaceAuthResult {
  const clientSecret = requireStoredClientSecret();
  const pkce = generatePkcePair();
  const state = generateState();
  const pending: StoredGoogleWorkspacePendingAuth = {
    state,
    codeVerifier: pkce.verifier,
    redirectUri: GOOGLE_WORKSPACE_REDIRECT_URI,
    scopes: [...GOOGLE_WORKSPACE_SCOPES],
    createdAt: nowIso(),
  };
  const path = saveNamedRuntimeSecrets({
    [GOOGLE_WORKSPACE_PENDING_AUTH_KEY]: JSON.stringify(pending),
  });

  return {
    path,
    authUrl: buildAuthUrl({
      clientId: clientSecret.clientId,
      authUri: clientSecret.authUri,
      redirectUri: pending.redirectUri,
      state,
      challenge: pkce.challenge,
      scopes: pending.scopes,
    }),
    redirectUri: pending.redirectUri,
  };
}

export async function exchangeGoogleWorkspaceAuthCode(
  codeOrUrl: string,
): Promise<ExchangeGoogleWorkspaceAuthCodeResult> {
  const clientSecret = requireStoredClientSecret();
  const pending = requireStoredPendingAuth();
  const existingToken = readStoredToken();
  const { code, state } = extractCodeAndState(codeOrUrl);
  if (state && state !== pending.state) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_state_mismatch',
      'Google Workspace authorization response state mismatch. Run `hybridclaw auth login google-workspace --auth-url` again.',
    );
  }

  const payload = await exchangeTokenRequest(
    clientSecret.tokenUri,
    new URLSearchParams({
      client_id: clientSecret.clientId,
      client_secret: clientSecret.clientSecret,
      code,
      code_verifier: pending.codeVerifier,
      redirect_uri: pending.redirectUri,
      grant_type: 'authorization_code',
    }),
    'google_workspace_token_exchange_failed',
  );

  const accessToken = normalizeString(payload.access_token);
  const refreshToken =
    normalizeString(payload.refresh_token) || existingToken?.refreshToken || '';
  if (!accessToken || !refreshToken) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_token_exchange_failed',
      'Google Workspace token exchange did not return a usable access and refresh token.',
      { reloginRequired: true },
    );
  }

  const scopes = normalizeScopes(payload.scope);
  const nextToken: StoredGoogleWorkspaceToken = {
    accessToken,
    refreshToken,
    tokenType: normalizeString(payload.token_type) || 'Bearer',
    scopes: scopes.length > 0 ? scopes : pending.scopes,
    expiresAt: buildTokenExpiresAt(payload.expires_in),
    updatedAt: nowIso(),
  };
  const path = saveNamedRuntimeSecrets({
    [GOOGLE_WORKSPACE_TOKEN_KEY]: JSON.stringify(nextToken),
    [GOOGLE_WORKSPACE_PENDING_AUTH_KEY]: null,
  });

  return {
    path,
    expiresAt: nextToken.expiresAt,
    scopes: nextToken.scopes,
  };
}

export async function ensureFreshGoogleWorkspaceAccessToken(): Promise<EnsureFreshGoogleWorkspaceAccessTokenResult> {
  const token = readStoredToken();
  if (!token || (!token.accessToken && !token.refreshToken)) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_token_missing',
      'Google Workspace OAuth token is not configured. Run `hybridclaw auth login google-workspace` first.',
      { reloginRequired: true },
    );
  }

  if (
    token.accessToken &&
    token.expiresAt > Date.now() + GOOGLE_WORKSPACE_REFRESH_SKEW_MS
  ) {
    return {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
      refreshed: false,
    };
  }

  if (!token.refreshToken) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_refresh_failed',
      'Google Workspace refresh token is missing. Re-run `hybridclaw auth login google-workspace`.',
      { reloginRequired: true },
    );
  }

  const clientSecret = requireStoredClientSecret();
  const payload = await exchangeTokenRequest(
    clientSecret.tokenUri,
    new URLSearchParams({
      client_id: clientSecret.clientId,
      client_secret: clientSecret.clientSecret,
      refresh_token: token.refreshToken,
      grant_type: 'refresh_token',
    }),
    'google_workspace_refresh_failed',
  );

  const accessToken = normalizeString(payload.access_token);
  if (!accessToken) {
    throw new GoogleWorkspaceAuthError(
      'google_workspace_refresh_failed',
      'Google Workspace refresh did not return a new access token.',
      { reloginRequired: true },
    );
  }

  const refreshedToken: StoredGoogleWorkspaceToken = {
    accessToken,
    refreshToken: normalizeString(payload.refresh_token) || token.refreshToken,
    tokenType:
      normalizeString(payload.token_type) || token.tokenType || 'Bearer',
    scopes: normalizeScopes(payload.scope).length
      ? normalizeScopes(payload.scope)
      : token.scopes,
    expiresAt: buildTokenExpiresAt(payload.expires_in),
    updatedAt: nowIso(),
  };
  saveNamedRuntimeSecrets({
    [GOOGLE_WORKSPACE_TOKEN_KEY]: JSON.stringify(refreshedToken),
  });

  return {
    accessToken: refreshedToken.accessToken,
    expiresAt: refreshedToken.expiresAt,
    scopes: refreshedToken.scopes,
    refreshed: true,
  };
}

export function getGoogleWorkspaceAuthStatus(): GoogleWorkspaceAuthStatus {
  const clientConfigured = readStoredClientSecret() != null;
  const token = readStoredToken();
  const pendingAuthorization =
    readStoredRuntimeSecret(GOOGLE_WORKSPACE_PENDING_AUTH_KEY) != null;
  const expiresAt = token?.expiresAt || 0;
  const expiresSoon =
    expiresAt > 0 && expiresAt <= Date.now() + GOOGLE_WORKSPACE_REFRESH_SKEW_MS;

  return {
    authenticated: Boolean(token?.accessToken || token?.refreshToken),
    path: runtimeSecretsPath(),
    clientConfigured,
    pendingAuthorization,
    refreshTokenConfigured: Boolean(token?.refreshToken),
    reloginRequired:
      Boolean(token) &&
      expiresSoon &&
      (!token?.refreshToken || !clientConfigured),
    expiresAt: expiresAt || null,
    scopes: token?.scopes || [],
  };
}

export function clearGoogleWorkspaceCredentials(): string {
  return saveNamedRuntimeSecrets({
    [GOOGLE_WORKSPACE_TOKEN_KEY]: null,
    [GOOGLE_WORKSPACE_PENDING_AUTH_KEY]: null,
  });
}
