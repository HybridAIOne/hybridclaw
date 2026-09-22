import readline from 'node:readline/promises';

import {
  HYBRIDAI_API_KEY,
  HYBRIDAI_BASE_URL,
  MissingRequiredEnvVarError,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { tryOpenUrlInBrowser } from '../utils/open-url.js';
import { promptForSecretInput } from '../utils/secret-prompt.js';
import {
  clearHybridAIOAuthRecord,
  type HybridAIOAuthAccount,
  type HybridAISignInResult,
  isHybridAIAccessToken,
  readHybridAIOAuthRecord,
  revokeHybridAIOAuthSession,
  startHybridAIAuthorization,
  startHybridAIDeviceAuthorization,
  waitForHybridAIAuthorizationCode,
} from './hybridai-oauth.js';

export interface HybridAIAuthStatus {
  authenticated: boolean;
  path: string;
  maskedApiKey: string | null;
  source: 'env' | 'runtime-secrets' | null;
  /** `oauth` for a platform sign-in, `api-key` for a pasted/imported key. */
  method: 'oauth' | 'api-key' | null;
  account?: HybridAIOAuthAccount;
  accessExpiresAt?: number;
}

export type HybridAILoginMethod =
  | 'browser'
  | 'device-code'
  | 'api-key'
  | 'env-import';

export interface HybridAILoginResult {
  path: string;
  apiKey: string;
  maskedApiKey: string;
  method: HybridAILoginMethod;
  validated: boolean;
  account?: HybridAIOAuthAccount;
}

interface ApiKeyValidationResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_BASE_URL = 'https://hybridai.one';
const DEFAULT_LOGIN_PATH = '/login?context=hybridclaw&next=/admin_api_keys';
const BOT_LIST_PATH = '/api/v1/bot-management/bots';
const API_KEY_RE = /\bhai-[A-Za-z0-9]{16,}\b/;

function isDefaultHybridAIBaseUrl(): boolean {
  return normalizeBaseUrl(HYBRIDAI_BASE_URL) === DEFAULT_BASE_URL;
}

function resolveCurrentApiKey(): {
  apiKey: string;
  source: HybridAIAuthStatus['source'];
} {
  const envApiKey = (process.env.HYBRIDAI_API_KEY || '').trim();
  if (envApiKey) return { apiKey: envApiKey, source: 'env' };

  const localPlatformApiKey = (process.env.API_KEY || '').trim();
  if (!isDefaultHybridAIBaseUrl() && localPlatformApiKey) {
    return { apiKey: localPlatformApiKey, source: 'env' };
  }

  const storedApiKey = readStoredRuntimeSecret('HYBRIDAI_API_KEY') || '';
  if (storedApiKey) {
    return { apiKey: storedApiKey, source: 'runtime-secrets' };
  }

  const configuredApiKey = (HYBRIDAI_API_KEY || '').trim();
  if (configuredApiKey) return { apiKey: configuredApiKey, source: 'env' };

  return { apiKey: '', source: null };
}

function readCurrentApiKey(): string {
  return resolveCurrentApiKey().apiKey;
}

function maskToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function getHybridAIApiKey(): string {
  const apiKey = readCurrentApiKey();
  if (!apiKey) throw new MissingRequiredEnvVarError('HYBRIDAI_API_KEY');
  return apiKey;
}

/**
 * The HybridAI key when one is configured, otherwise null.
 *
 * For callers that treat "not signed in" as a capability being unavailable
 * rather than an error — feature discovery and optional backends — where
 * catching {@link getHybridAIApiKey}'s throw would be control flow.
 */
export function readHybridAIApiKey(): string | null {
  return readCurrentApiKey() || null;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function resolveUrl(baseUrl: string, routeOrUrl: string): string {
  const trimmed = routeOrUrl.trim();
  if (!trimmed) return baseUrl;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${baseUrl}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
}

function extractApiKeyFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const directMatch = trimmed.match(API_KEY_RE);
  if (directMatch?.[0]) return directMatch[0];

  try {
    const parsed = new URL(trimmed);
    const queryCandidates = [
      parsed.searchParams.get('api_key'),
      parsed.searchParams.get('token'),
      parsed.searchParams.get('key'),
    ];
    for (const candidate of queryCandidates) {
      if (!candidate) continue;
      const nestedMatch = candidate.match(API_KEY_RE);
      if (nestedMatch?.[0]) return nestedMatch[0];
      if (candidate.startsWith('hai-')) return candidate;
    }
  } catch {
    // Not a URL; fall through to raw string handling.
  }

  if (trimmed.startsWith('hai-')) return trimmed;
  return null;
}

function parseErrorMessage(payload: unknown, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload || fallback;
  if (typeof payload !== 'object') return fallback;

  const record = payload as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error;
  }
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim()) {
      return nested.message;
    }
  }

  return fallback;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function validateApiKey(
  baseUrl: string,
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  let response: Response;
  try {
    response = await fetch(resolveUrl(baseUrl, BOT_LIST_PATH), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not validate API key (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  const payload = await readResponsePayload(response);
  if (!response.ok) {
    return {
      ok: false,
      error: parseErrorMessage(
        payload,
        `Validation failed with HTTP ${response.status}.`,
      ),
    };
  }

  return { ok: true };
}

async function promptYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const raw = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
  if (!raw) return defaultYes;
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  return defaultYes;
}

function requireInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('HybridAI login requires an interactive terminal.');
  }
}

/** Store a platform API key; any OAuth session it replaces is forgotten. */
function saveApiKey(apiKey: string): string {
  clearHybridAIOAuthRecord();
  const filePath = saveRuntimeSecrets({ HYBRIDAI_API_KEY: apiKey });
  refreshRuntimeSecretsFromEnv();
  return filePath;
}

function createPromptInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * OAuth sign-in. `browser` runs the authorization code + PKCE flow with a
 * loopback redirect and auto-opens the consent page. `device-code` (headless
 * shells) prefers the RFC 8628 device flow: a short code to type in at the
 * platform's `/device` page; platforms without it get the loopback flow with
 * a pasted redirect instead.
 */
async function loginWithOAuth(options: {
  method: 'browser' | 'device-code';
  baseUrl?: string;
}): Promise<HybridAILoginResult> {
  requireInteractiveTerminal();
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || HYBRIDAI_BASE_URL || DEFAULT_BASE_URL,
  );
  console.log('HybridAI sign-in');
  const signIn =
    options.method === 'device-code'
      ? await signInWithDeviceCode(baseUrl)
      : await signInWithLoopback(baseUrl, { autoOpen: true });

  if (signIn.account?.email) {
    console.log(`Signed in as ${signIn.account.email}.`);
  }
  const validation = await validateApiKey(baseUrl, signIn.accessToken);
  if (validation.ok) {
    console.log('Access token validated successfully.');
  } else {
    console.log(
      `Signed in, but the bot API rejected the token: ${validation.error || 'Unknown validation error.'}`,
    );
  }
  return {
    path: runtimeSecretsPath(),
    apiKey: signIn.accessToken,
    maskedApiKey: maskToken(signIn.accessToken),
    method: options.method,
    validated: validation.ok,
    account: signIn.account,
  };
}

async function signInWithDeviceCode(
  baseUrl: string,
): Promise<HybridAISignInResult> {
  const device = await startHybridAIDeviceAuthorization({ baseUrl });
  if (!device) return await signInWithLoopback(baseUrl, { autoOpen: false });
  console.log('On any device with a browser, open:');
  console.log(`  ${device.verificationUri}`);
  console.log(`and enter the code:  ${device.userCode}`);
  if (device.verificationUriComplete) {
    console.log(`(or open ${device.verificationUriComplete} directly)`);
  }
  console.log(
    `Waiting for approval (code valid for ${Math.max(1, Math.round((device.expiresAt - Date.now()) / 60_000))} min) ...`,
  );
  return await device.waitForSignIn();
}

async function signInWithLoopback(
  baseUrl: string,
  options: { autoOpen: boolean },
): Promise<HybridAISignInResult> {
  const rl = createPromptInterface();
  try {
    const authorization = await startHybridAIAuthorization({ baseUrl });
    if (
      options.autoOpen &&
      (await promptYesNo(
        rl,
        'Open the HybridAI sign-in page in your browser now?',
        true,
      ))
    ) {
      const opened = await tryOpenUrlInBrowser(authorization.authorizationUrl);
      if (!opened) {
        console.log('Could not auto-open browser. Open the link manually.');
      }
    }
    console.log('Sign-in page:');
    console.log(authorization.authorizationUrl);
    console.log(
      `Waiting for the browser to return to ${authorization.redirectUri} ...`,
    );
    const code = await waitForHybridAIAuthorizationCode(authorization, {
      rl,
      text: 'If the browser cannot reach this machine, paste the URL it was redirected to here: ',
    });
    return await authorization.complete(code);
  } finally {
    rl.close();
  }
}

/** Legacy path: paste a long-lived `hai-` platform API key. */
async function loginWithApiKeyPrompt(options: {
  baseUrl?: string;
}): Promise<HybridAILoginResult> {
  requireInteractiveTerminal();

  const baseUrl = normalizeBaseUrl(
    options.baseUrl || HYBRIDAI_BASE_URL || DEFAULT_BASE_URL,
  );
  const loginUrl = resolveUrl(baseUrl, DEFAULT_LOGIN_PATH);
  let rl = createPromptInterface();

  try {
    console.log('HybridAI API key login');
    console.log(`API keys page: ${loginUrl}`);
    if (
      await promptYesNo(rl, 'Open the API keys page in your browser now?', true)
    ) {
      const opened = await tryOpenUrlInBrowser(loginUrl);
      if (!opened) {
        console.log('Could not auto-open browser. Open the link manually.');
      }
    }

    let apiKey = '';
    let validated = false;
    while (true) {
      rl.close();
      const entered = await promptForSecretInput({
        prompt: 'Paste HybridAI API key or URL containing it: ',
        missingMessage: 'HybridAI login requires an interactive terminal.',
      });
      rl = createPromptInterface();
      apiKey = extractApiKeyFromInput(entered) || entered.trim();
      if (!apiKey) {
        console.log('Please enter a value.');
        continue;
      }

      const validation = await validateApiKey(baseUrl, apiKey);
      if (validation.ok) {
        validated = true;
        console.log('API key validated successfully.');
        break;
      }

      console.log(
        `Validation failed: ${validation.error || 'Unknown validation error.'}`,
      );
      if (await promptYesNo(rl, 'Try entering the key again?', true)) {
        continue;
      }
      if (await promptYesNo(rl, 'Save this key anyway?', false)) {
        break;
      }
    }

    const path = saveApiKey(apiKey);
    return {
      path,
      apiKey,
      maskedApiKey: maskToken(apiKey),
      method: 'api-key',
      validated,
    };
  } finally {
    rl.close();
  }
}

/** Forget the stored credential and OAuth session without contacting the platform. */
export function clearHybridAICredentials(): string {
  clearHybridAIOAuthRecord();
  const filePath = saveRuntimeSecrets({ HYBRIDAI_API_KEY: null });
  refreshRuntimeSecretsFromEnv();
  return filePath;
}

/** Sign out: revoke the OAuth session at the platform (best-effort), then forget it. */
export async function logoutHybridAI(): Promise<{
  path: string;
  revoked: boolean;
}> {
  const revoked = await revokeHybridAIOAuthSession();
  return { path: clearHybridAICredentials(), revoked };
}

export function importHybridAIEnvCredentials(): HybridAILoginResult {
  const apiKey = (process.env.HYBRIDAI_API_KEY || '').trim();
  if (!apiKey) throw new MissingRequiredEnvVarError('HYBRIDAI_API_KEY');

  const path = saveApiKey(apiKey);
  return {
    path,
    apiKey,
    maskedApiKey: maskToken(apiKey),
    method: 'env-import',
    validated: false,
  };
}

export function selectDefaultHybridAILoginMethod(): 'device-code' | 'browser' {
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
  return 'browser';
}

export async function loginHybridAIInteractive(options?: {
  method?: 'auto' | 'device-code' | 'browser' | 'api-key' | 'import';
  baseUrl?: string;
}): Promise<HybridAILoginResult> {
  const method = options?.method || 'auto';
  const baseUrl = options?.baseUrl;

  if (method === 'import') {
    return importHybridAIEnvCredentials();
  }
  if (method === 'api-key') {
    return loginWithApiKeyPrompt({ ...(baseUrl ? { baseUrl } : {}) });
  }

  const selectedMethod =
    method === 'auto' ? selectDefaultHybridAILoginMethod() : method;
  return loginWithOAuth({
    method: selectedMethod,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

export function getHybridAIAuthStatus(): HybridAIAuthStatus {
  const path = runtimeSecretsPath();
  const { apiKey, source } = resolveCurrentApiKey();
  if (!apiKey) {
    return {
      authenticated: false,
      path,
      maskedApiKey: null,
      source: null,
      method: null,
    };
  }

  const record =
    source === 'runtime-secrets' && isHybridAIAccessToken(apiKey)
      ? readHybridAIOAuthRecord()
      : null;
  return {
    authenticated: true,
    path,
    maskedApiKey: maskToken(apiKey),
    source,
    method: record ? 'oauth' : 'api-key',
    ...(record?.account ? { account: record.account } : {}),
    ...(typeof record?.accessExpiresAt === 'number'
      ? { accessExpiresAt: record.accessExpiresAt }
      : {}),
  };
}
