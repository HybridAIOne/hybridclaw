import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

export const CODEX_AUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_AUTH_SCOPE = 'openid profile email offline_access';
export const CODEX_AUTH_PROVIDER = 'openai-codex';
export const CODEX_AUTH_METHOD = 'oauth';
export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_DEFAULT_CALLBACK_HOST = '127.0.0.1';
export const CODEX_DEFAULT_CALLBACK_PORT = 1455;
export const CODEX_DEFAULT_CALLBACK_REDIRECT_HOST = 'localhost';
export const CODEX_REFRESH_SKEW_MS = 2 * 60_000;
export const CODEX_LOCK_STALE_MS = 30_000;
export const CODEX_LOCK_TIMEOUT_MS = 15_000;
export const CODEX_DEVICE_CODE_POLL_MS = 5_000;
export const CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
export const CODEX_OPENAI_BETA_HEADER = 'responses=experimental';
export const CODEX_SIMPLIFIED_FLOW_PARAM = 'codex_cli_simplified_flow';
const CODEX_AUTH_FILE = 'codex-auth.json';
const CODEX_AUTH_FILE_MODE = 0o600;

export type CodexAuthSource =
  | 'device-code'
  | 'browser-pkce'
  | 'codex-cli-import';

export type CodexAuthErrorCode =
  | 'codex_auth_missing'
  | 'codex_auth_missing_access_token'
  | 'codex_auth_missing_refresh_token'
  | 'codex_refresh_failed'
  | 'codex_refresh_invalid_json'
  | 'codex_token_exchange_failed'
  | 'codex_device_code_timeout'
  | 'codex_account_id_missing';

export interface CodexStoredCredentials {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
  provider: typeof CODEX_AUTH_PROVIDER;
  authMethod: typeof CODEX_AUTH_METHOD;
  source: CodexAuthSource;
  lastRefresh: string;
}

export interface CodexAuthStore {
  version: 1;
  credentials: CodexStoredCredentials | null;
  updatedAt: string;
}

export interface CodexResolvedCredentials {
  provider: typeof CODEX_AUTH_PROVIDER;
  baseUrl: string;
  apiKey: string;
  accountId: string;
  headers: Record<string, string>;
}

export interface CodexAuthStatus {
  authenticated: boolean;
  path: string;
  source: CodexAuthSource | null;
  accountId: string | null;
  expiresAt: number | null;
  maskedAccessToken: string | null;
  reloginRequired: boolean;
}

export interface EnsureFreshCredentialsResult {
  credentials: CodexStoredCredentials;
  refreshed: boolean;
}

interface PkcePair {
  verifier: string;
  challenge: string;
}

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string | null;
  intervalMs: number;
}

interface DeviceCodePollResponse {
  done: boolean;
  authorizationCode: string | null;
  codeVerifier: string | null;
}

interface RawCodexAuthStore {
  version?: unknown;
  credentials?: Record<string, unknown> | null;
  updatedAt?: unknown;
}

export class CodexAuthError extends Error {
  code: CodexAuthErrorCode;
  reloginRequired: boolean;
  retryable: boolean;
  status?: number;

  constructor(
    code: CodexAuthErrorCode,
    message: string,
    options?: {
      reloginRequired?: boolean;
      retryable?: boolean;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'CodexAuthError';
    this.code = code;
    this.reloginRequired = options?.reloginRequired === true;
    this.retryable = options?.retryable === true;
    this.status = options?.status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function nowIso(): string {
  return new Date().toISOString();
}

function defaultStore(): CodexAuthStore {
  return {
    version: 1,
    credentials: null,
    updatedAt: nowIso(),
  };
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generatePkcePair(): PkcePair {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(
    createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

function generateState(): string {
  return toBase64Url(randomBytes(32));
}

function getOpenCommand(url: string): { cmd: string; args: string[] } | null {
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  if (process.platform === 'win32')
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (process.platform === 'linux') return { cmd: 'xdg-open', args: [url] };
  return null;
}

async function openUrl(url: string): Promise<boolean> {
  const openCommand = getOpenCommand(url);
  if (!openCommand) return false;

  return new Promise((resolve) => {
    const child = spawn(openCommand.cmd, openCommand.args, {
      stdio: 'ignore',
      detached: true,
    });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 12) return `${trimmed.slice(0, 4)}...`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function codexAuthPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.hybridclaw', CODEX_AUTH_FILE);
}

export function codexAuthLockPath(homeDir: string = os.homedir()): string {
  return `${codexAuthPath(homeDir)}.lock`;
}

function ensurePrivateJsonFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, {
    encoding: 'utf-8',
    mode: CODEX_AUTH_FILE_MODE,
  });
  fs.chmodSync(filePath, CODEX_AUTH_FILE_MODE);
}

function parseStoreJson(filePath: string, raw: string): RawCodexAuthStore {
  try {
    return JSON.parse(raw) as RawCodexAuthStore;
  } catch (cause) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      `Stored Codex auth file is invalid JSON: ${filePath}`,
      { reloginRequired: true, cause },
    );
  }
}

function normalizeStoredCredentials(
  raw: Record<string, unknown>,
): CodexStoredCredentials {
  return {
    accessToken: normalizeString(raw.accessToken),
    refreshToken: normalizeString(raw.refreshToken),
    accountId: normalizeString(raw.accountId),
    expiresAt: normalizeTimestamp(raw.expiresAt),
    provider: CODEX_AUTH_PROVIDER,
    authMethod: CODEX_AUTH_METHOD,
    source: normalizeStoredSource(raw.source),
    lastRefresh: normalizeString(raw.lastRefresh) || nowIso(),
  };
}

function normalizeStoredSource(value: unknown): CodexAuthSource {
  const normalized = normalizeString(value);
  if (normalized === 'device-code') return normalized;
  if (normalized === 'browser-pkce') return normalized;
  if (normalized === 'codex-cli-import') return normalized;
  return 'browser-pkce';
}

export function loadCodexAuthStore(
  homeDir: string = os.homedir(),
): CodexAuthStore {
  const filePath = codexAuthPath(homeDir);
  if (!fs.existsSync(filePath)) return defaultStore();

  const parsed = parseStoreJson(filePath, fs.readFileSync(filePath, 'utf-8'));
  const rawCredentials = isRecord(parsed.credentials) ? parsed.credentials : null;

  return {
    version: 1,
    credentials: rawCredentials ? normalizeStoredCredentials(rawCredentials) : null,
    updatedAt: normalizeString(parsed.updatedAt) || nowIso(),
  };
}

export function saveCodexAuthStore(
  store: CodexAuthStore,
  homeDir: string = os.homedir(),
): string {
  const filePath = codexAuthPath(homeDir);
  ensurePrivateJsonFile(filePath, `${JSON.stringify(store, null, 2)}\n`);
  return filePath;
}

function saveCredentials(
  credentials: CodexStoredCredentials | null,
  homeDir: string = os.homedir(),
): string {
  return saveCodexAuthStore(
    {
      version: 1,
      credentials,
      updatedAt: nowIso(),
    },
    homeDir,
  );
}

export function clearCodexCredentials(homeDir: string = os.homedir()): string {
  return saveCredentials(null, homeDir);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      'Stored access token is not a valid JWT.',
      { reloginRequired: true },
    );
  }

  try {
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const decoded = Buffer.from(payload, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('JWT payload is not an object.');
    }
    return parsed;
  } catch (cause) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      'Stored access token payload could not be decoded.',
      { reloginRequired: true, cause },
    );
  }
}

export function extractExpiresAtFromJwt(jwt: string): number {
  const payload = decodeJwtPayload(jwt);
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      'Stored access token is missing an exp claim.',
      { reloginRequired: true },
    );
  }
  return Math.trunc(exp * 1000);
}

function readNestedString(
  record: Record<string, unknown>,
  key: string,
  nestedKey?: string,
): string {
  const direct = record[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (!nestedKey || !isRecord(direct)) return '';
  const nested = direct[nestedKey];
  return typeof nested === 'string' ? nested.trim() : '';
}

export function extractAccountIdFromJwt(jwt: string): string {
  const payload = decodeJwtPayload(jwt);
  const direct = normalizeString(payload.chatgpt_account_id);
  if (direct) return direct;

  const namespacedDirect = normalizeString(
    payload['https://api.openai.com/auth.chatgpt_account_id'],
  );
  if (namespacedDirect) return namespacedDirect;

  const nestedAuth = readNestedString(
    payload,
    'https://api.openai.com/auth',
    'chatgpt_account_id',
  );
  if (nestedAuth) return nestedAuth;

  const organizations = payload.organizations;
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = organizations[0];
    if (isRecord(first)) {
      const orgId = normalizeString(first.id);
      if (orgId) return orgId;
    }
  }

  throw new CodexAuthError(
    'codex_account_id_missing',
    'Could not extract a ChatGPT account ID from the stored token.',
    { reloginRequired: true },
  );
}

function assertStoredCredentials(
  store: CodexAuthStore,
): CodexStoredCredentials {
  if (!store.credentials) {
    throw new CodexAuthError(
      'codex_auth_missing',
      'No Codex credentials are stored.',
      { reloginRequired: true },
    );
  }
  if (!store.credentials.accessToken) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      'Stored Codex credentials are missing an access token.',
      { reloginRequired: true },
    );
  }
  if (!store.credentials.refreshToken) {
    throw new CodexAuthError(
      'codex_auth_missing_refresh_token',
      'Stored Codex credentials are missing a refresh token.',
      { reloginRequired: true },
    );
  }
  if (!store.credentials.accountId) {
    throw new CodexAuthError(
      'codex_account_id_missing',
      'Stored Codex credentials are missing an account ID.',
      { reloginRequired: true },
    );
  }
  if (!Number.isFinite(store.credentials.expiresAt) || store.credentials.expiresAt <= 0) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      'Stored Codex credentials are missing a valid expiry time.',
      { reloginRequired: true },
    );
  }
  return store.credentials;
}

function buildHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Chatgpt-Account-Id': accountId,
    'OpenAI-Beta': CODEX_OPENAI_BETA_HEADER,
    originator: 'hybridclaw',
  };
}

export function buildBrowserRedirectUri(
  port: number = CODEX_DEFAULT_CALLBACK_PORT,
): string {
  return `http://${CODEX_DEFAULT_CALLBACK_REDIRECT_HOST}:${port}/auth/callback`;
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  pkce: PkcePair;
  state: string;
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: CODEX_AUTH_SCOPE,
    code_challenge: params.pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    [CODEX_SIMPLIFIED_FLOW_PARAM]: 'true',
    state: params.state,
    originator: 'hybridclaw',
  });
  return `${CODEX_AUTH_ISSUER}/oauth/authorize?${query.toString()}`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseResponseError(
  payload: unknown,
  fallback: string,
): string {
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return fallback;

  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (isRecord(error)) {
    const nestedMessage = normalizeString(error.message);
    if (nestedMessage) return nestedMessage;
    const nestedCode = normalizeString(error.code);
    if (nestedCode) return nestedCode;
  }

  const message = normalizeString(payload.message);
  if (message) return message;
  const detail = normalizeString(payload.detail);
  if (detail) return detail;
  const code = normalizeString(payload.code);
  if (code) return code;
  return fallback;
}

function normalizeTokenResponse(
  payload: unknown,
  fallbackRefreshToken: string,
  source: CodexAuthSource,
): CodexStoredCredentials {
  if (!isRecord(payload)) {
    throw new CodexAuthError(
      'codex_refresh_invalid_json',
      'OAuth token response was not valid JSON.',
      { reloginRequired: true },
    );
  }

  const accessToken = normalizeString(payload.access_token);
  if (!accessToken) {
    throw new CodexAuthError(
      'codex_refresh_invalid_json',
      'OAuth token response did not include an access token.',
      { reloginRequired: true },
    );
  }

  const refreshToken =
    normalizeString(payload.refresh_token) || fallbackRefreshToken;
  if (!refreshToken) {
    throw new CodexAuthError(
      'codex_auth_missing_refresh_token',
      'OAuth token response did not include a refresh token.',
      { reloginRequired: true },
    );
  }

  const expiresAt = extractExpiresAtFromJwt(accessToken);
  const accountId =
    tryExtractAccountId(accessToken) ||
    tryExtractAccountId(normalizeString(payload.id_token));
  if (!accountId) {
    throw new CodexAuthError(
      'codex_account_id_missing',
      'OAuth token response did not contain a usable ChatGPT account ID.',
      { reloginRequired: true },
    );
  }

  return {
    accessToken,
    refreshToken,
    accountId,
    expiresAt,
    provider: CODEX_AUTH_PROVIDER,
    authMethod: CODEX_AUTH_METHOD,
    source,
    lastRefresh: nowIso(),
  };
}

function tryExtractAccountId(jwt: string): string {
  if (!jwt.trim()) return '';
  try {
    return extractAccountIdFromJwt(jwt);
  } catch {
    return '';
  }
}

async function exchangeAuthorizationCode(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  source: CodexAuthSource;
}): Promise<CodexStoredCredentials> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: CODEX_AUTH_CLIENT_ID,
    code_verifier: params.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(`${CODEX_AUTH_ISSUER}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (cause) {
    throw new CodexAuthError(
      'codex_token_exchange_failed',
      'Authorization code exchange failed.',
      { reloginRequired: true, retryable: true, cause },
    );
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new CodexAuthError(
      'codex_token_exchange_failed',
      `Authorization code exchange failed: ${parseResponseError(payload, `HTTP ${response.status}`)}`,
      { reloginRequired: true, status: response.status },
    );
  }

  return normalizeTokenResponse(payload, '', params.source);
}

async function refreshAccessToken(
  current: CodexStoredCredentials,
): Promise<CodexStoredCredentials> {
  const body = new URLSearchParams({
    client_id: CODEX_AUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  let response: Response;
  try {
    response = await fetch(`${CODEX_AUTH_ISSUER}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (cause) {
    throw new CodexAuthError(
      'codex_refresh_failed',
      'Failed to refresh Codex credentials.',
      { retryable: true, cause },
    );
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const reloginRequired =
      response.status === 401 || response.status === 403;
    throw new CodexAuthError(
      'codex_refresh_failed',
      `Failed to refresh Codex credentials: ${parseResponseError(payload, `HTTP ${response.status}`)}`,
      {
        reloginRequired,
        retryable: !reloginRequired,
        status: response.status,
      },
    );
  }

  return normalizeTokenResponse(payload, current.refreshToken, current.source);
}

async function acquireFileLock(
  homeDir: string,
): Promise<() => void> {
  const lockPath = codexAuthLockPath(homeDir);
  const startedAt = Date.now();
  let backoffMs = 100;

  while (Date.now() - startedAt < CODEX_LOCK_TIMEOUT_MS) {
    try {
      const fd = fs.openSync(lockPath, 'wx', CODEX_AUTH_FILE_MODE);
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: nowIso() }),
        'utf-8',
      );
      fs.closeSync(fd);

      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // best effort
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw new CodexAuthError(
          'codex_refresh_failed',
          `Failed to acquire Codex auth lock at ${lockPath}.`,
          { retryable: true, cause: err },
        );
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > CODEX_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 2_000);
    }
  }

  throw new CodexAuthError(
    'codex_refresh_failed',
    'Timed out waiting for the Codex auth refresh lock.',
    { retryable: true },
  );
}

function needsRefresh(credentials: CodexStoredCredentials): boolean {
  return credentials.expiresAt <= Date.now() + CODEX_REFRESH_SKEW_MS;
}

export async function ensureFreshCredentials(
  homeDir: string = os.homedir(),
): Promise<EnsureFreshCredentialsResult> {
  const initial = assertStoredCredentials(loadCodexAuthStore(homeDir));
  if (!needsRefresh(initial)) {
    return { credentials: initial, refreshed: false };
  }

  const releaseLock = await acquireFileLock(homeDir);
  try {
    const underLock = assertStoredCredentials(loadCodexAuthStore(homeDir));
    if (!needsRefresh(underLock)) {
      return { credentials: underLock, refreshed: false };
    }

    const refreshed = await refreshAccessToken(underLock);
    saveCredentials(refreshed, homeDir);
    return { credentials: refreshed, refreshed: true };
  } finally {
    releaseLock();
  }
}

export async function resolveCodexCredentials(): Promise<CodexResolvedCredentials> {
  const { credentials } = await ensureFreshCredentials();
  const baseUrl = (
    process.env.HYBRIDCLAW_CODEX_BASE_URL || CODEX_DEFAULT_BASE_URL
  )
    .trim()
    .replace(/\/+$/g, '');

  return {
    provider: CODEX_AUTH_PROVIDER,
    baseUrl,
    apiKey: credentials.accessToken,
    accountId: credentials.accountId,
    headers: buildHeaders(credentials.accessToken, credentials.accountId),
  };
}

function normalizeDeviceCodeResponse(payload: unknown): DeviceCodeResponse {
  if (!isRecord(payload)) {
    throw new CodexAuthError(
      'codex_token_exchange_failed',
      'Device code response was not valid JSON.',
      { reloginRequired: true },
    );
  }

  const deviceCode =
    normalizeString(payload.device_auth_id) ||
    normalizeString(payload.deviceAuthId) ||
    normalizeString(payload.device_code) ||
    normalizeString(payload.deviceCode);
  const userCode =
    normalizeString(payload.user_code) || normalizeString(payload.userCode);
  const verificationUrl =
    normalizeString(payload.verification_uri) ||
    normalizeString(payload.verification_url) ||
    normalizeString(payload.verificationUrl);
  const verificationUrlComplete =
    normalizeString(payload.verification_uri_complete) ||
    normalizeString(payload.verificationUrlComplete) ||
    null;
  const intervalSeconds =
    Number(payload.interval) ||
    Number(payload.interval_seconds) ||
    Number(payload.intervalSeconds) ||
    CODEX_DEVICE_CODE_POLL_MS / 1000;

  if (!deviceCode || !userCode || !verificationUrl) {
    throw new CodexAuthError(
      'codex_token_exchange_failed',
      'Device code response was missing required fields.',
      { reloginRequired: true },
    );
  }

  return {
    deviceCode,
    userCode,
    verificationUrl,
    verificationUrlComplete,
    intervalMs: Math.max(1_000, Math.trunc(intervalSeconds * 1000)),
  };
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  let response: Response;
  try {
    response = await fetch(
      `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: CODEX_AUTH_CLIENT_ID,
        }),
      },
    );
  } catch (cause) {
    throw new CodexAuthError(
      'codex_token_exchange_failed',
      'Failed to start the device code login flow.',
      { reloginRequired: true, retryable: true, cause },
    );
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new CodexAuthError(
      'codex_token_exchange_failed',
      `Device code login failed: ${parseResponseError(payload, `HTTP ${response.status}`)}`,
      { reloginRequired: true, status: response.status },
    );
  }

  return normalizeDeviceCodeResponse(payload);
}

function normalizeDeviceCodePoll(payload: unknown): DeviceCodePollResponse {
  if (!isRecord(payload)) {
    return { done: false, authorizationCode: null, codeVerifier: null };
  }

  const authCode =
    normalizeString(payload.code) ||
    normalizeString(payload.authorization_code) ||
    normalizeString(payload.authorizationCode) ||
    normalizeString(payload.auth_code);
  const codeVerifier =
    normalizeString(payload.code_verifier) ||
    normalizeString(payload.codeVerifier);
  if (authCode) {
    return {
      done: true,
      authorizationCode: authCode,
      codeVerifier: codeVerifier || null,
    };
  }

  const status =
    normalizeString(payload.status) ||
    normalizeString(payload.error) ||
    normalizeString(payload.code);
  if (
    status === 'authorization_pending' ||
    status === 'pending' ||
    status === 'slow_down' ||
    status === 'expired_token'
  ) {
    return { done: false, authorizationCode: null, codeVerifier: null };
  }

  return { done: false, authorizationCode: null, codeVerifier: null };
}

async function pollDeviceAuthorizationCode(
  deviceCode: string,
  userCode: string,
  intervalMs: number,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const deadline = Date.now() + CODEX_DEVICE_CODE_TIMEOUT_MS;
  let nextDelay = Math.max(CODEX_DEVICE_CODE_POLL_MS, intervalMs);

  while (Date.now() < deadline) {
    await sleep(nextDelay);

    let response: Response;
    try {
      response = await fetch(
        `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            device_auth_id: deviceCode,
            user_code: userCode,
          }),
        },
      );
    } catch {
      nextDelay = Math.min(nextDelay * 2, 10_000);
      continue;
    }

    const payload = await readJsonResponse(response);
    if (response.ok) {
      const parsed = normalizeDeviceCodePoll(payload);
      if (parsed.done && parsed.authorizationCode && parsed.codeVerifier) {
        return {
          authorizationCode: parsed.authorizationCode,
          codeVerifier: parsed.codeVerifier,
        };
      }
      if (parsed.done && parsed.authorizationCode && !parsed.codeVerifier) {
        throw new CodexAuthError(
          'codex_token_exchange_failed',
          'Device code polling succeeded without a code verifier.',
          { reloginRequired: true },
        );
      }
      continue;
    }

    const errorCode =
      isRecord(payload) &&
      (normalizeString(payload.error) ||
        normalizeString(payload.code) ||
        normalizeString(payload.status));
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 428
    ) {
      if (
        errorCode === 'authorization_pending' ||
        errorCode === 'pending' ||
        errorCode === 'slow_down'
      ) {
        if (errorCode === 'slow_down') {
          nextDelay = Math.min(nextDelay + 5_000, 15_000);
        }
        continue;
      }
    }

    throw new CodexAuthError(
      'codex_token_exchange_failed',
      `Device code polling failed: ${parseResponseError(payload, `HTTP ${response.status}`)}`,
      { reloginRequired: true, status: response.status },
    );
  }

  throw new CodexAuthError(
    'codex_device_code_timeout',
    'Timed out waiting for device code approval.',
    { reloginRequired: true },
  );
}

export async function loginWithDeviceCode(
  homeDir: string = os.homedir(),
): Promise<{ credentials: CodexStoredCredentials; path: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Device code login requires an interactive terminal.');
  }

  const device = await requestDeviceCode();

  console.log('OpenAI Codex device login');
  console.log(`Code: ${device.userCode}`);
  console.log(
    `Verify: ${device.verificationUrlComplete || device.verificationUrl}`,
  );

  const deviceGrant = await pollDeviceAuthorizationCode(
    device.deviceCode,
    device.userCode,
    device.intervalMs,
  );
  const credentials = await exchangeAuthorizationCode({
    code: deviceGrant.authorizationCode,
    redirectUri: `${CODEX_AUTH_ISSUER}/deviceauth/callback`,
    codeVerifier: deviceGrant.codeVerifier,
    source: 'device-code',
  });

  const filePath = saveCredentials(credentials, homeDir);
  return { credentials, path: filePath };
}

function createSuccessHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>HybridClaw Codex Login</title></head>',
    '<body style="font-family: sans-serif; padding: 24px;">',
    '<h1>HybridClaw Codex login complete</h1>',
    '<p>You can return to the terminal.</p>',
    '</body>',
    '</html>',
  ].join('');
}

async function waitForBrowserCallback(
  state: string,
  port: number,
  manualPrompt: Promise<string>,
): Promise<string> {
  const successHtml = createSuccessHtml();
  let server: http.Server | null = null;

  const callbackPromise = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${CODEX_DEFAULT_CALLBACK_HOST}:${port}`);
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const returnedState = url.searchParams.get('state') || '';
      if (returnedState !== state) {
        res.statusCode = 400;
        res.end('State mismatch');
        reject(
          new CodexAuthError(
            'codex_token_exchange_failed',
            'Browser callback state mismatch.',
            { reloginRequired: true },
          ),
        );
        server?.close();
        return;
      }

      const errorCode = url.searchParams.get('error') || '';
      if (errorCode) {
        res.statusCode = 400;
        res.end('Authorization failed');
        reject(
          new CodexAuthError(
            'codex_token_exchange_failed',
            `Browser authorization failed: ${errorCode}`,
            { reloginRequired: true },
          ),
        );
        server?.close();
        return;
      }

      const code = url.searchParams.get('code') || '';
      if (!code) {
        res.statusCode = 400;
        res.end('Missing code');
        reject(
          new CodexAuthError(
            'codex_token_exchange_failed',
            'Browser callback did not include an authorization code.',
            { reloginRequired: true },
          ),
        );
        server?.close();
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(successHtml);
      resolve(code);
      server?.close();
    });

    server.once('error', (cause) => {
      reject(
        new CodexAuthError(
          'codex_token_exchange_failed',
          `Could not bind local Codex login callback on ${CODEX_DEFAULT_CALLBACK_HOST}:${port}.`,
          { reloginRequired: true, cause },
        ),
      );
    });

    server.listen(port, CODEX_DEFAULT_CALLBACK_HOST);
  });

  try {
    const manualUrl = await Promise.race([
      callbackPromise,
      (async () => {
        const pasted = (await manualPrompt).trim();
        if (!pasted) {
          return new Promise<string>(() => {});
        }

        let parsed: URL;
        try {
          parsed = new URL(pasted);
        } catch (cause) {
          throw new CodexAuthError(
            'codex_token_exchange_failed',
            'Pasted callback URL was not valid.',
            { reloginRequired: true, cause },
          );
        }

        if ((parsed.searchParams.get('state') || '') !== state) {
          throw new CodexAuthError(
            'codex_token_exchange_failed',
            'Pasted callback URL had a mismatched state parameter.',
            { reloginRequired: true },
          );
        }

        const code = parsed.searchParams.get('code') || '';
        if (!code) {
          throw new CodexAuthError(
            'codex_token_exchange_failed',
            'Pasted callback URL did not contain an authorization code.',
            { reloginRequired: true },
          );
        }
        return code;
      })(),
    ]);

    return manualUrl;
  } finally {
    const activeServer = server as http.Server | null;
    if (activeServer) activeServer.close();
  }
}

export async function loginWithBrowserPkce(
  homeDir: string = os.homedir(),
): Promise<{ credentials: CodexStoredCredentials; path: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Browser login requires an interactive terminal.');
  }

  const redirectUri = buildBrowserRedirectUri(CODEX_DEFAULT_CALLBACK_PORT);
  const pkce = generatePkcePair();
  const state = generateState();
  const authUrl = buildAuthUrl({
    clientId: CODEX_AUTH_CLIENT_ID,
    redirectUri,
    pkce,
    state,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('OpenAI Codex browser login');
    console.log(`Callback: ${redirectUri}`);
    console.log(`Auth URL: ${authUrl}`);

    const opened = await openUrl(authUrl);
    if (!opened) {
      console.log('Could not open a browser automatically. Open the URL above.');
    }

    const code = await waitForBrowserCallback(
      state,
      CODEX_DEFAULT_CALLBACK_PORT,
      rl.question(
        'Paste the final callback URL here if the browser flow does not return automatically, or press Enter to keep waiting: ',
      ),
    );

    const credentials = await exchangeAuthorizationCode({
      code,
      redirectUri,
      codeVerifier: pkce.verifier,
      source: 'browser-pkce',
    });
    const filePath = saveCredentials(credentials, homeDir);
    return { credentials, path: filePath };
  } finally {
    rl.close();
  }
}

function resolveCodexCliAuthPath(): string {
  const codexHome = (process.env.CODEX_HOME || '').trim();
  const baseDir = codexHome || path.join(os.homedir(), '.codex');
  return path.join(baseDir, 'auth.json');
}

function readImportedTokenData(filePath: string): {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  lastRefresh: string;
} {
  if (!fs.existsSync(filePath)) {
    throw new CodexAuthError(
      'codex_auth_missing',
      `Codex CLI auth file not found at ${filePath}.`,
      { reloginRequired: true },
    );
  }

  const raw = parseStoreJson(filePath, fs.readFileSync(filePath, 'utf-8'));
  const tokens = isRecord(raw.credentials)
    ? raw.credentials
    : isRecord((raw as Record<string, unknown>).tokens)
      ? ((raw as Record<string, unknown>).tokens as Record<string, unknown>)
      : null;

  if (!tokens) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      `Codex CLI auth file at ${filePath} does not contain tokens.`,
      { reloginRequired: true },
    );
  }

  const accessToken =
    normalizeString(tokens.access_token) ||
    normalizeString(tokens.accessToken) ||
    normalizeString(tokens.access_token_jwt);
  const refreshToken =
    normalizeString(tokens.refresh_token) ||
    normalizeString(tokens.refreshToken);
  const accountId =
    normalizeString(tokens.account_id) ||
    normalizeString(tokens.accountId) ||
    tryExtractAccountId(accessToken);
  const lastRefresh =
    normalizeString((raw as Record<string, unknown>).last_refresh) ||
    normalizeString((raw as Record<string, unknown>).lastRefresh) ||
    nowIso();

  if (!accessToken) {
    throw new CodexAuthError(
      'codex_auth_missing_access_token',
      `Codex CLI auth file at ${filePath} does not contain an access token.`,
      { reloginRequired: true },
    );
  }
  if (!refreshToken) {
    throw new CodexAuthError(
      'codex_auth_missing_refresh_token',
      `Codex CLI auth file at ${filePath} does not contain a refresh token.`,
      { reloginRequired: true },
    );
  }
  if (!accountId) {
    throw new CodexAuthError(
      'codex_account_id_missing',
      `Codex CLI auth file at ${filePath} does not contain an account ID.`,
      { reloginRequired: true },
    );
  }

  return {
    accessToken,
    refreshToken,
    accountId,
    lastRefresh,
  };
}

export async function importCodexCliCredentials(
  homeDir: string = os.homedir(),
): Promise<{ credentials: CodexStoredCredentials; path: string; importedFrom: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Codex CLI import requires an interactive terminal.');
  }

  const importPath = resolveCodexCliAuthPath();
  const imported = readImportedTokenData(importPath);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(`Importing Codex CLI credentials from ${importPath}`);
    console.log(`Account: ${imported.accountId}`);
    const answer = (
      await rl.question(
        'Copy these credentials into HybridClaw without modifying the Codex CLI store? [y/N] ',
      )
    )
      .trim()
      .toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Codex CLI credential import cancelled.');
    }

    const credentials: CodexStoredCredentials = {
      accessToken: imported.accessToken,
      refreshToken: imported.refreshToken,
      accountId: imported.accountId,
      expiresAt: extractExpiresAtFromJwt(imported.accessToken),
      provider: CODEX_AUTH_PROVIDER,
      authMethod: CODEX_AUTH_METHOD,
      source: 'codex-cli-import',
      lastRefresh: imported.lastRefresh,
    };
    const filePath = saveCredentials(credentials, homeDir);
    return { credentials, path: filePath, importedFrom: importPath };
  } finally {
    rl.close();
  }
}

export function selectDefaultCodexLoginMethod():
  | 'device-code'
  | 'browser-pkce' {
  if (
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.CI ||
    process.env.CONTAINER ||
    process.env.DOCKER_CONTAINER ||
    process.env.KUBERNETES_SERVICE_HOST
  ) {
    return 'device-code';
  }
  if (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return 'device-code';
  }
  return 'browser-pkce';
}

export async function loginCodexInteractive(options?: {
  method?: 'auto' | 'device-code' | 'browser-pkce' | 'codex-cli-import';
  homeDir?: string;
}): Promise<{
  credentials: CodexStoredCredentials;
  path: string;
  method: CodexAuthSource;
  importedFrom?: string;
}> {
  const method = options?.method || 'auto';
  const homeDir = options?.homeDir || os.homedir();

  if (method === 'codex-cli-import') {
    const result = await importCodexCliCredentials(homeDir);
    return {
      credentials: result.credentials,
      path: result.path,
      method: 'codex-cli-import',
      importedFrom: result.importedFrom,
    };
  }

  const selectedMethod =
    method === 'auto' ? selectDefaultCodexLoginMethod() : method;
  if (selectedMethod === 'device-code') {
    const result = await loginWithDeviceCode(homeDir);
    return {
      credentials: result.credentials,
      path: result.path,
      method: 'device-code',
    };
  }

  const result = await loginWithBrowserPkce(homeDir);
  return {
    credentials: result.credentials,
    path: result.path,
    method: 'browser-pkce',
  };
}

export function getCodexAuthStatus(
  homeDir: string = os.homedir(),
): CodexAuthStatus {
  const filePath = codexAuthPath(homeDir);
  try {
    const store = loadCodexAuthStore(homeDir);
    if (!store.credentials) {
      return {
        authenticated: false,
        path: filePath,
        source: null,
        accountId: null,
        expiresAt: null,
        maskedAccessToken: null,
        reloginRequired: true,
      };
    }

    return {
      authenticated: true,
      path: filePath,
      source: store.credentials.source,
      accountId: store.credentials.accountId,
      expiresAt: store.credentials.expiresAt,
      maskedAccessToken: maskToken(store.credentials.accessToken),
      reloginRequired: false,
    };
  } catch (error) {
    if (error instanceof CodexAuthError) {
      return {
        authenticated: false,
        path: filePath,
        source: null,
        accountId: null,
        expiresAt: null,
        maskedAccessToken: null,
        reloginRequired: error.reloginRequired,
      };
    }
    throw error;
  }
}
