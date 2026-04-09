import { spawn } from 'node:child_process';
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
import { promptForSecretInput } from '../utils/secret-prompt.js';

export interface HybridAIAuthStatus {
  authenticated: boolean;
  path: string;
  maskedApiKey: string | null;
  source: 'env' | 'runtime-secrets' | null;
}

export type HybridAILoginMethod = 'browser' | 'device-code' | 'env-import';

export interface HybridAILoginResult {
  path: string;
  apiKey: string;
  maskedApiKey: string;
  method: HybridAILoginMethod;
  validated: boolean;
}

interface ApiKeyValidationResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_BASE_URL = 'https://hybridai.one';
const DEFAULT_LOGIN_PATH = '/login?context=hybridclaw&next=/admin_api_keys';
const BOT_LIST_PATH = '/api/v1/bot-management/bots';
const API_KEY_RE = /\bhai-[A-Za-z0-9]{16,}\b/;

function readCurrentApiKey(): string {
  return (
    process.env.HYBRIDAI_API_KEY ||
    readStoredRuntimeSecret('HYBRIDAI_API_KEY') ||
    HYBRIDAI_API_KEY ||
    ''
  ).trim();
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

function getOpenCommand(url: string): { cmd: string; args: string[] } | null {
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  if (process.platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (process.platform === 'linux') return { cmd: 'xdg-open', args: [url] };
  return null;
}

async function tryOpenUrl(url: string): Promise<boolean> {
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

function saveApiKey(apiKey: string): string {
  const filePath = saveRuntimeSecrets({ HYBRIDAI_API_KEY: apiKey });
  refreshRuntimeSecretsFromEnv();
  return filePath;
}

async function loginWithApiKeyPrompt(options: {
  method: 'browser' | 'device-code';
  baseUrl?: string;
}): Promise<HybridAILoginResult> {
  requireInteractiveTerminal();

  const method = options.method;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || HYBRIDAI_BASE_URL || DEFAULT_BASE_URL,
  );
  const loginUrl = resolveUrl(baseUrl, DEFAULT_LOGIN_PATH);
  const createPromptInterface = () =>
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  let rl = createPromptInterface();

  try {
    if (method === 'browser') {
      console.log('HybridAI browser login');
      console.log(`Login page: ${loginUrl}`);
      if (
        await promptYesNo(rl, 'Open the login page in your browser now?', true)
      ) {
        const opened = await tryOpenUrl(loginUrl);
        if (!opened) {
          console.log('Could not auto-open browser. Open the link manually.');
        }
      }
    } else {
      console.log('HybridAI headless login');
      console.log(`Open this page to retrieve an API key: ${loginUrl}`);
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
      method,
      validated,
    };
  } finally {
    rl.close();
  }
}

export function clearHybridAICredentials(): string {
  const filePath = saveRuntimeSecrets({ HYBRIDAI_API_KEY: null });
  refreshRuntimeSecretsFromEnv();
  return filePath;
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
  method?: 'auto' | 'device-code' | 'browser' | 'import';
  baseUrl?: string;
}): Promise<HybridAILoginResult> {
  const method = options?.method || 'auto';
  const baseUrl = options?.baseUrl;

  if (method === 'import') {
    return importHybridAIEnvCredentials();
  }

  const selectedMethod =
    method === 'auto' ? selectDefaultHybridAILoginMethod() : method;
  return loginWithApiKeyPrompt({
    method: selectedMethod,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

export function getHybridAIAuthStatus(): HybridAIAuthStatus {
  const path = runtimeSecretsPath();
  const envApiKey = (process.env.HYBRIDAI_API_KEY || '').trim();
  const storedApiKey = readStoredRuntimeSecret('HYBRIDAI_API_KEY') || '';
  const apiKey = readCurrentApiKey();
  if (!apiKey) {
    return {
      authenticated: false,
      path,
      maskedApiKey: null,
      source: null,
    };
  }

  return {
    authenticated: true,
    path,
    maskedApiKey: maskToken(apiKey),
    source: envApiKey
      ? storedApiKey && storedApiKey === envApiKey
        ? 'runtime-secrets'
        : 'env'
      : storedApiKey
        ? 'runtime-secrets'
        : null,
  };
}
