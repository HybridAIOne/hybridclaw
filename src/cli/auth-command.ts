import fs from 'node:fs';
import readline from 'node:readline/promises';

import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  runtimeConfigPath,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import type { LocalBackendType } from '../providers/local-types.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import {
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { normalizeArgs } from './common.js';
import {
  isHelpRequest,
  printAuthUsage,
  printCodexUsage,
  printHybridAIUsage,
  printLocalUsage,
  printMSTeamsUsage,
  printOpenRouterUsage,
  printWhatsAppUsage,
} from './help.js';

type HybridAIAuthApi = typeof import('../auth/hybridai-auth.js');
type CodexAuthApi = typeof import('../auth/codex-auth.js');
type WhatsAppAuthApi = typeof import('../channels/whatsapp/auth.js');
type OnboardingApi = typeof import('../onboarding.js');

let hybridAIAuthApi: HybridAIAuthApi | null = null;
let hybridAIAuthApiPromise: Promise<HybridAIAuthApi> | null = null;
let codexAuthApi: CodexAuthApi | null = null;
let codexAuthApiPromise: Promise<CodexAuthApi> | null = null;
let whatsAppAuthApi: WhatsAppAuthApi | null = null;
let whatsAppAuthApiPromise: Promise<WhatsAppAuthApi> | null = null;
let onboardingApi: OnboardingApi | null = null;
let onboardingApiPromise: Promise<OnboardingApi> | null = null;

async function ensureHybridAIAuthApi(): Promise<HybridAIAuthApi> {
  if (hybridAIAuthApi) return hybridAIAuthApi;
  if (!hybridAIAuthApiPromise) {
    hybridAIAuthApiPromise = import('../auth/hybridai-auth.js').then((api) => {
      hybridAIAuthApi = api;
      return api;
    });
  }
  return hybridAIAuthApiPromise;
}

function getHybridAIAuthApi(): HybridAIAuthApi {
  if (!hybridAIAuthApi) {
    throw new Error(
      'HybridAI auth API accessed before it was initialized. Call ensureHybridAIAuthApi() first.',
    );
  }
  return hybridAIAuthApi;
}

async function ensureCodexAuthApi(): Promise<CodexAuthApi> {
  if (codexAuthApi) return codexAuthApi;
  if (!codexAuthApiPromise) {
    codexAuthApiPromise = import('../auth/codex-auth.js').then((api) => {
      codexAuthApi = api;
      return api;
    });
  }
  return codexAuthApiPromise;
}

function getCodexAuthApi(): CodexAuthApi {
  if (!codexAuthApi) {
    throw new Error(
      'Codex auth API accessed before it was initialized. Call ensureCodexAuthApi() first.',
    );
  }
  return codexAuthApi;
}

async function ensureWhatsAppAuthApi(): Promise<WhatsAppAuthApi> {
  if (whatsAppAuthApi) return whatsAppAuthApi;
  if (!whatsAppAuthApiPromise) {
    whatsAppAuthApiPromise = import('../channels/whatsapp/auth.js').then(
      (api) => {
        whatsAppAuthApi = api;
        return api;
      },
    );
  }
  return whatsAppAuthApiPromise;
}

function getWhatsAppAuthApi(): WhatsAppAuthApi {
  if (!whatsAppAuthApi) {
    throw new Error(
      'WhatsApp auth API accessed before it was initialized. Call ensureWhatsAppAuthApi() first.',
    );
  }
  return whatsAppAuthApi;
}

async function ensureOnboardingApi(): Promise<OnboardingApi> {
  if (onboardingApi) return onboardingApi;
  if (!onboardingApiPromise) {
    onboardingApiPromise = import('../onboarding.js').then((api) => {
      onboardingApi = api;
      return api;
    });
  }
  return onboardingApiPromise;
}

function parseCodexLoginMethod(
  args: string[],
): 'auto' | 'device-code' | 'browser-pkce' | 'codex-cli-import' {
  const flags = new Set(args.map((arg) => arg.trim().toLowerCase()));
  const requested = [
    flags.has('--device-code') ? 'device-code' : null,
    flags.has('--browser') ? 'browser-pkce' : null,
    flags.has('--import') ? 'codex-cli-import' : null,
  ].filter(Boolean) as Array<
    'device-code' | 'browser-pkce' | 'codex-cli-import'
  >;

  if (requested.length > 1) {
    throw new Error(
      'Use only one of `--device-code`, `--browser`, or `--import`.',
    );
  }
  return requested[0] || 'auto';
}

interface ParsedHybridAILoginArgs {
  method: 'auto' | 'device-code' | 'browser' | 'import';
  baseUrl?: string;
}

function extractBaseUrlArg(args: string[]): {
  baseUrl?: string;
  remaining: string[];
} {
  let baseUrl: string | undefined;
  const remaining: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--base-url') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--base-url`.');
      baseUrl = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
      continue;
    }
    remaining.push(arg);
  }

  return { baseUrl, remaining };
}

function parseHybridAILoginArgs(args: string[]): ParsedHybridAILoginArgs {
  const { baseUrl, remaining } = extractBaseUrlArg(args);
  for (const arg of remaining) {
    if (arg.startsWith('-')) {
      const normalized = arg.trim().toLowerCase();
      if (
        normalized !== '--device-code' &&
        normalized !== '--browser' &&
        normalized !== '--import'
      ) {
        throw new Error(`Unknown flag: ${arg}`);
      }
    }
  }

  const flags = new Set(remaining.map((arg) => arg.trim().toLowerCase()));
  const requested = [
    flags.has('--device-code') ? 'device-code' : null,
    flags.has('--browser') ? 'browser' : null,
    flags.has('--import') ? 'import' : null,
  ].filter(Boolean) as Array<'device-code' | 'browser' | 'import'>;

  if (requested.length > 1) {
    throw new Error(
      'Use only one of `--device-code`, `--browser`, or `--import`.',
    );
  }
  return {
    method: requested[0] || 'auto',
    ...(baseUrl ? { baseUrl } : {}),
  };
}

interface ParsedOpenRouterLoginArgs {
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  setDefault: boolean;
}

function parseOpenRouterLoginArgs(args: string[]): ParsedOpenRouterLoginArgs {
  const positional: string[] = [];
  const { baseUrl, remaining } = extractBaseUrlArg(args);
  let apiKey: string | undefined;
  let setDefault = true;

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index] || '';
    if (arg === '--no-default') {
      setDefault = false;
      continue;
    }
    if (arg === '--set-default') {
      setDefault = true;
      continue;
    }
    if (arg === '--api-key') {
      const next = remaining[index + 1];
      if (!next) throw new Error('Missing value for `--api-key`.');
      apiKey = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  return {
    modelId: positional.length > 0 ? positional.join(' ') : undefined,
    baseUrl,
    apiKey,
    setDefault,
  };
}

function normalizeOpenRouterModelId(rawModelId: string): string {
  const trimmed = rawModelId.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('openrouter/')) {
    return trimmed;
  }
  return `openrouter/${trimmed}`;
}

function normalizeOpenRouterBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/g, '');
  if (!trimmed) return 'https://openrouter.ai/api/v1';
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

async function promptForOpenRouterApiKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing OpenRouter API key. Pass `--api-key <key>`, set `OPENROUTER_API_KEY`, or run this command in an interactive terminal to paste it.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await rl.question('Paste OpenRouter API key: ')).trim();
  } finally {
    rl.close();
  }
}

async function resolveOpenRouterApiKey(
  explicitApiKey: string | undefined,
): Promise<string> {
  const configuredApiKey =
    explicitApiKey?.trim() || process.env.OPENROUTER_API_KEY?.trim() || '';
  if (configuredApiKey) return configuredApiKey;

  const promptedApiKey = await promptForOpenRouterApiKey();
  if (promptedApiKey) return promptedApiKey;

  throw new Error(
    'OpenRouter API key cannot be empty. Pass `--api-key <key>`, set `OPENROUTER_API_KEY`, or paste it when prompted.',
  );
}

async function configureOpenRouter(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseOpenRouterLoginArgs(args);
  const currentConfig = getRuntimeConfig();
  const configuredModel =
    parsed.modelId ||
    currentConfig.openrouter.models[0] ||
    'openrouter/anthropic/claude-sonnet-4';
  const fullModelName = normalizeOpenRouterModelId(configuredModel);
  if (!fullModelName) {
    throw new Error('OpenRouter model ID cannot be empty.');
  }

  const apiKey = await resolveOpenRouterApiKey(parsed.apiKey);

  const normalizedBaseUrl = normalizeOpenRouterBaseUrl(
    parsed.baseUrl || currentConfig.openrouter.baseUrl,
  );
  const secretsPath = saveRuntimeSecrets({ OPENROUTER_API_KEY: apiKey });
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.openrouter.enabled = true;
    draft.openrouter.baseUrl = normalizedBaseUrl;
    draft.openrouter.models = Array.from(
      new Set([fullModelName, ...draft.openrouter.models]),
    );
    if (parsed.setDefault) {
      draft.hybridai.defaultModel = fullModelName;
    }
  });

  process.env.OPENROUTER_API_KEY = apiKey;
  console.log(`Saved OpenRouter credentials to ${secretsPath}.`);
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Provider: openrouter`);
  console.log(`Base URL: ${nextConfig.openrouter.baseUrl}`);
  console.log(`Configured model: ${fullModelName}`);
  if (parsed.setDefault) {
    console.log(`Default model: ${fullModelName}`);
  } else {
    console.log(
      `Default model unchanged: ${formatModelForDisplay(nextConfig.hybridai.defaultModel)}`,
    );
  }
  console.log('Next:');
  console.log('  hybridclaw gateway restart --foreground');
  console.log('  hybridclaw gateway status');
  console.log('  hybridclaw tui');
  console.log(`  /model set ${fullModelName}`);
}

type UnifiedProvider =
  | 'hybridai'
  | 'codex'
  | 'openrouter'
  | 'local'
  | 'msteams';

function normalizeUnifiedProvider(
  rawProvider: string | undefined,
): UnifiedProvider | null {
  const normalized = String(rawProvider || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    normalized === 'hybridai' ||
    normalized === 'hybrid-ai' ||
    normalized === 'hybrid'
  ) {
    return 'hybridai';
  }
  if (normalized === 'codex' || normalized === 'openai-codex') {
    return 'codex';
  }
  if (normalized === 'openrouter' || normalized === 'or') {
    return 'openrouter';
  }
  if (normalized === 'local') {
    return 'local';
  }
  if (
    normalized === 'msteams' ||
    normalized === 'teams' ||
    normalized === 'ms-teams'
  ) {
    return 'msteams';
  }
  return null;
}

function parseUnifiedProviderArgs(args: string[]): {
  provider: UnifiedProvider | null;
  remaining: string[];
} {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    return {
      provider: null,
      remaining: [],
    };
  }

  const first = normalized[0] || '';
  if (first === '--provider') {
    const rawProvider = normalized[1];
    if (!rawProvider) {
      throw new Error('Missing value for `--provider`.');
    }
    const provider = normalizeUnifiedProvider(rawProvider);
    if (!provider) {
      throw new Error(
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
      );
    }
    return {
      provider,
      remaining: normalized.slice(2),
    };
  }

  if (first.startsWith('--provider=')) {
    const rawProvider = first.slice('--provider='.length);
    const provider = normalizeUnifiedProvider(rawProvider);
    if (!provider) {
      throw new Error(
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
      );
    }
    return {
      provider,
      remaining: normalized.slice(1),
    };
  }

  return {
    provider: normalizeUnifiedProvider(first),
    remaining:
      normalizeUnifiedProvider(first) == null
        ? normalized
        : normalized.slice(1),
  };
}

function readStoredRuntimeSecret(
  secretKey: 'OPENROUTER_API_KEY' | 'MSTEAMS_APP_PASSWORD',
): string | null {
  const filePath = runtimeSecretsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[secretKey];
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized || null;
  } catch {
    return null;
  }
}

function maskSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}…${normalized.slice(-1)}`;
  }
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

function isLocalProviderModel(modelName: string): boolean {
  return /^(ollama|lmstudio|vllm)\//i.test(modelName.trim());
}

function printOpenRouterStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedApiKey = readStoredRuntimeSecret('OPENROUTER_API_KEY');
  const envApiKey = process.env.OPENROUTER_API_KEY?.trim() || '';
  const source = envApiKey
    ? storedApiKey && envApiKey === storedApiKey
      ? 'runtime-secrets'
      : 'env'
    : storedApiKey
      ? 'runtime-secrets'
      : null;
  const apiKey = envApiKey || storedApiKey || '';

  console.log(`Path: ${runtimeSecretsPath()}`);
  console.log(`Authenticated: ${apiKey ? 'yes' : 'no'}`);
  if (source) {
    console.log(`Source: ${source}`);
  }
  if (apiKey) {
    console.log(`API key: ${maskSecret(apiKey)}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.openrouter.enabled ? 'yes' : 'no'}`);
  console.log(`Base URL: ${config.openrouter.baseUrl}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  console.log(
    `Models: ${config.openrouter.models.length > 0 ? config.openrouter.models.join(', ') : '(none configured)'}`,
  );
}

function clearOpenRouterCredentials(): void {
  const filePath = saveRuntimeSecrets({ OPENROUTER_API_KEY: null });
  delete process.env.OPENROUTER_API_KEY;
  console.log(`Cleared OpenRouter credentials in ${filePath}.`);
  console.log(
    'If OPENROUTER_API_KEY is still exported in your shell, unset it separately.',
  );
}

function normalizeHybridAIBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/g, '');
  if (!trimmed) return 'https://hybridai.one';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      'Invalid HybridAI base URL. Expected an absolute http:// or https:// URL.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      'Invalid HybridAI base URL. Expected an absolute http:// or https:// URL.',
    );
  }
  return trimmed;
}

function printHybridAIStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const status = getHybridAIAuthApi().getHybridAIAuthStatus();

  console.log(`Path: ${status.path}`);
  console.log(`Authenticated: ${status.authenticated ? 'yes' : 'no'}`);
  if (status.authenticated) {
    console.log(`Source: ${status.source}`);
    console.log(`API key: ${status.maskedApiKey}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Base URL: ${config.hybridai.baseUrl}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
}

function configureHybridAIBaseUrl(args: string[]): void {
  ensureRuntimeConfigFile();
  const requested = args.join(' ').trim();
  const normalizedBaseUrl = normalizeHybridAIBaseUrl(requested);
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.hybridai.baseUrl = normalizedBaseUrl;
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Provider: hybridai`);
  console.log(`Base URL: ${nextConfig.hybridai.baseUrl}`);
  console.log('Next:');
  console.log('  hybridclaw gateway restart --foreground');
  console.log('  hybridclaw hybridai status');
  console.log('  hybridclaw tui');
}

function printMSTeamsStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedAppPassword = readStoredRuntimeSecret('MSTEAMS_APP_PASSWORD');
  const envAppId = process.env.MSTEAMS_APP_ID?.trim() || '';
  const envTenantId = process.env.MSTEAMS_TENANT_ID?.trim() || '';
  const envAppPassword = process.env.MSTEAMS_APP_PASSWORD?.trim() || '';
  const appPassword = envAppPassword || storedAppPassword || '';
  const source = envAppPassword
    ? storedAppPassword && envAppPassword === storedAppPassword
      ? 'runtime-secrets'
      : 'env'
    : storedAppPassword
      ? 'runtime-secrets'
      : null;
  const appId = envAppId || config.msteams.appId;
  const tenantId = envTenantId || config.msteams.tenantId;

  console.log(`Path: ${runtimeSecretsPath()}`);
  console.log(`Authenticated: ${appId && appPassword ? 'yes' : 'no'}`);
  if (source) {
    console.log(`Source: ${source}`);
  }
  if (appPassword) {
    console.log(`App password: ${maskSecret(appPassword)}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.msteams.enabled ? 'yes' : 'no'}`);
  console.log(`App ID: ${appId || '(not set)'}`);
  console.log(`Tenant ID: ${tenantId || '(not set)'}`);
  console.log(`Webhook path: ${config.msteams.webhook.path}`);
  console.log(`DM policy: ${config.msteams.dmPolicy}`);
  console.log(`Group policy: ${config.msteams.groupPolicy}`);
}

function clearMSTeamsCredentials(): void {
  ensureRuntimeConfigFile();
  const filePath = saveRuntimeSecrets({ MSTEAMS_APP_PASSWORD: null });
  delete process.env.MSTEAMS_APP_PASSWORD;
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.msteams.enabled = false;
    draft.msteams.appId = '';
    draft.msteams.tenantId = '';
  });

  console.log(`Cleared Microsoft Teams credentials in ${filePath}.`);
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(
    `Microsoft Teams integration: ${nextConfig.msteams.enabled ? 'enabled' : 'disabled'}`,
  );
  console.log(
    'If MSTEAMS_APP_ID, MSTEAMS_APP_PASSWORD, or MSTEAMS_TENANT_ID are still exported in your shell, unset them separately.',
  );
}

function clearLocalBackends(): void {
  ensureRuntimeConfigFile();
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.local.backends.ollama.enabled = false;
    draft.local.backends.lmstudio.enabled = false;
    draft.local.backends.vllm.enabled = false;
    draft.local.backends.vllm.apiKey = '';
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log('Disabled local backends: ollama, lmstudio, vllm.');
  if (isLocalProviderModel(nextConfig.hybridai.defaultModel)) {
    console.log(
      `Default model unchanged: ${formatModelForDisplay(nextConfig.hybridai.defaultModel)}`,
    );
    console.log(
      'Hint: default model still points at a local backend. Configure another provider before starting new sessions.',
    );
  } else {
    console.log(
      `Default model: ${formatModelForDisplay(nextConfig.hybridai.defaultModel)}`,
    );
  }
}

function printUnifiedProviderUsage(provider: UnifiedProvider): void {
  if (provider === 'hybridai') {
    printHybridAIUsage();
    return;
  }
  if (provider === 'codex') {
    printCodexUsage();
    return;
  }
  if (provider === 'openrouter') {
    printOpenRouterUsage();
    return;
  }
  if (provider === 'msteams') {
    printMSTeamsUsage();
    return;
  }
  printLocalUsage();
}

function isLocalBackendType(value: string): value is LocalBackendType {
  return value === 'ollama' || value === 'lmstudio' || value === 'vllm';
}

function normalizeLocalModelId(
  backend: LocalBackendType,
  rawModelId: string,
): string {
  const trimmed = rawModelId.trim();
  const ownPrefix = `${backend}/`;
  if (trimmed.toLowerCase().startsWith(ownPrefix)) {
    return trimmed.slice(ownPrefix.length).trim();
  }
  if (/^(ollama|lmstudio|vllm)\//i.test(trimmed)) {
    throw new Error(
      `Model "${trimmed}" already includes a different local provider prefix.`,
    );
  }
  return trimmed;
}

function normalizeLocalBaseUrl(
  backend: LocalBackendType,
  rawBaseUrl: string,
): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/g, '');
  if (!trimmed) {
    if (backend === 'ollama') return 'http://127.0.0.1:11434';
    if (backend === 'lmstudio') return 'http://127.0.0.1:1234/v1';
    return 'http://127.0.0.1:8000/v1';
  }
  if (backend === 'ollama') {
    return trimmed.replace(/\/v1$/i, '');
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

interface ParsedLocalConfigureArgs {
  backend: LocalBackendType;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  setDefault: boolean;
}

function parseLocalConfigureArgs(args: string[]): ParsedLocalConfigureArgs {
  const positional: string[] = [];
  const { baseUrl, remaining } = extractBaseUrlArg(args);
  let apiKey: string | undefined;
  let setDefault = true;

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index] || '';
    if (arg === '--no-default') {
      setDefault = false;
      continue;
    }
    if (arg === '--set-default') {
      setDefault = true;
      continue;
    }
    if (arg === '--api-key') {
      const next = remaining[index + 1];
      if (!next) throw new Error('Missing value for `--api-key`.');
      apiKey = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length < 2) {
    throw new Error(
      'Usage: `hybridclaw local configure <ollama|lmstudio|vllm> <model-id> [--base-url <url>] [--api-key <key>] [--no-default]`',
    );
  }

  const backendRaw = (positional[0] || '').trim().toLowerCase();
  if (!isLocalBackendType(backendRaw)) {
    throw new Error(
      `Unknown local backend "${positional[0]}". Use \`ollama\`, \`lmstudio\`, or \`vllm\`.`,
    );
  }

  if (backendRaw !== 'vllm' && apiKey !== undefined) {
    throw new Error('`--api-key` is only supported for the `vllm` backend.');
  }

  const modelId = normalizeLocalModelId(
    backendRaw,
    positional.slice(1).join(' '),
  );
  if (!modelId) {
    throw new Error('Model ID cannot be empty.');
  }

  return {
    backend: backendRaw,
    modelId,
    baseUrl,
    apiKey,
    setDefault,
  };
}

function printLocalStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  for (const backend of ['ollama', 'lmstudio', 'vllm'] as const) {
    const settings = config.local.backends[backend];
    console.log(
      `${backend}: ${settings.enabled ? 'enabled' : 'disabled'} (${settings.baseUrl})`,
    );
    if (backend === 'vllm') {
      console.log(
        `vllm api key: ${settings.apiKey ? 'configured' : 'not set'}`,
      );
    }
  }
}

function configureLocalBackend(args: string[]): void {
  ensureRuntimeConfigFile();
  const parsed = parseLocalConfigureArgs(args);
  const currentConfig = getRuntimeConfig();
  const currentBackend = currentConfig.local.backends[parsed.backend];
  const normalizedBaseUrl = normalizeLocalBaseUrl(
    parsed.backend,
    parsed.baseUrl || currentBackend.baseUrl,
  );
  const fullModelName = `${parsed.backend}/${parsed.modelId}`;
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.local.backends[parsed.backend].enabled = true;
    draft.local.backends[parsed.backend].baseUrl = normalizedBaseUrl;
    if (parsed.backend === 'vllm' && parsed.apiKey !== undefined) {
      draft.local.backends.vllm.apiKey = parsed.apiKey;
    }
    if (parsed.setDefault) {
      draft.hybridai.defaultModel = fullModelName;
    }
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Backend: ${parsed.backend}`);
  console.log(`Base URL: ${nextConfig.local.backends[parsed.backend].baseUrl}`);
  console.log(`Configured model: ${fullModelName}`);
  if (parsed.backend === 'vllm' && parsed.apiKey !== undefined) {
    console.log('vllm api key: configured');
  }
  if (parsed.setDefault) {
    console.log(`Default model: ${fullModelName}`);
  } else {
    console.log(
      `Default model unchanged: ${formatModelForDisplay(nextConfig.hybridai.defaultModel)}`,
    );
  }
  console.log('Next:');
  console.log('  hybridclaw gateway restart --foreground --sandbox=host');
  console.log('  hybridclaw gateway status');
  console.log('  hybridclaw tui');
  console.log(`  /model set ${fullModelName}`);
}

export async function handleLocalCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printLocalUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'status') {
    printLocalStatus();
    return;
  }
  if (sub === 'configure') {
    configureLocalBackend(normalized.slice(1));
    return;
  }

  throw new Error(`Unknown local subcommand: ${sub}`);
}

async function handleAuthLoginCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    const { ensureRuntimeCredentials } = await ensureOnboardingApi();
    await ensureRuntimeCredentials({
      commandName: 'hybridclaw auth login',
    });
    return;
  }
  if (isHelpRequest(normalized)) {
    printAuthUsage();
    return;
  }

  const parsed = parseUnifiedProviderArgs(normalized);
  if (!parsed.provider) {
    throw new Error(
      `Unknown auth login provider "${normalized[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
    );
  }
  if (isHelpRequest(parsed.remaining)) {
    printUnifiedProviderUsage(parsed.provider);
    return;
  }

  if (parsed.provider === 'hybridai') {
    await handleHybridAICommand(['login', ...parsed.remaining]);
    return;
  }
  if (parsed.provider === 'codex') {
    await handleCodexCommand(['login', ...parsed.remaining]);
    return;
  }
  if (parsed.provider === 'openrouter') {
    await configureOpenRouter(parsed.remaining);
    return;
  }
  if (parsed.provider === 'msteams') {
    await configureMSTeamsAuth(parsed.remaining);
    return;
  }
  configureLocalBackend(parsed.remaining);
}

export async function handleAuthCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    printAuthUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printAuthUsage();
    return;
  }
  if (sub === 'whatsapp') {
    await handleAuthWhatsAppCommand(normalized.slice(1));
    return;
  }
  if (sub === 'login') {
    if (normalized.length === 1) {
      const { ensureRuntimeCredentials } = await ensureOnboardingApi();
      await ensureRuntimeCredentials({
        commandName: 'hybridclaw auth login',
      });
      return;
    }
    await handleAuthLoginCommand(normalized.slice(1));
    return;
  }

  if (sub === 'status') {
    await handleProviderStatusCommand(
      normalized.slice(1),
      'hybridclaw auth status',
    );
    return;
  }

  if (sub === 'logout') {
    await handleProviderLogoutCommand(
      normalized.slice(1),
      'hybridclaw auth logout',
    );
    return;
  }

  throw new Error(
    `Unknown auth subcommand: ${sub}. Use \`login\`, \`status\`, \`logout\`, or \`whatsapp\`.`,
  );
}

async function handleAuthWhatsAppCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printWhatsAppUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub !== 'reset') {
    throw new Error(
      `Unknown auth whatsapp subcommand: ${sub}. Use \`hybridclaw auth whatsapp reset\`.`,
    );
  }
  if (normalized.length > 1) {
    throw new Error(
      'Unexpected arguments for `hybridclaw auth whatsapp reset`.',
    );
  }

  await ensureWhatsAppAuthApi();
  const status = await getWhatsAppAuthApi().getWhatsAppAuthStatus();
  await getWhatsAppAuthApi().resetWhatsAppAuthState();
  console.log(
    `Reset WhatsApp auth state at ${getWhatsAppAuthApi().WHATSAPP_AUTH_DIR}.`,
  );
  console.log(
    status.linked
      ? 'Linked device state cleared. Re-run `hybridclaw channels whatsapp setup` to pair again.'
      : 'No linked auth was present. You can run `hybridclaw channels whatsapp setup` when you are ready to pair.',
  );
}

type ProviderAction = 'status' | 'logout';

async function dispatchProviderAction(
  provider: UnifiedProvider,
  action: ProviderAction,
): Promise<void> {
  if (provider === 'hybridai') {
    await handleHybridAICommand([action]);
    return;
  }
  if (provider === 'codex') {
    await handleCodexCommand([action]);
    return;
  }
  if (provider === 'openrouter') {
    if (action === 'status') {
      printOpenRouterStatus();
      return;
    }
    clearOpenRouterCredentials();
    return;
  }
  if (provider === 'msteams') {
    if (action === 'status') {
      printMSTeamsStatus();
      return;
    }
    clearMSTeamsCredentials();
    return;
  }
  if (action === 'status') {
    printLocalStatus();
    return;
  }
  clearLocalBackends();
}

async function handleProviderActionCommand(
  args: string[],
  commandName: string,
  action: ProviderAction,
): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printAuthUsage();
    return;
  }

  const parsed = parseUnifiedProviderArgs(normalized);
  if (!parsed.provider) {
    throw new Error(
      `Unknown ${action} provider "${normalized[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
    );
  }
  if (parsed.remaining.length > 0) {
    if (isHelpRequest(parsed.remaining)) {
      printUnifiedProviderUsage(parsed.provider);
      return;
    }
    throw new Error(`Unexpected arguments for \`${commandName}\`.`);
  }

  await dispatchProviderAction(parsed.provider, action);
}

async function handleProviderStatusCommand(
  args: string[],
  commandName: string,
): Promise<void> {
  await handleProviderActionCommand(args, commandName, 'status');
}

async function handleProviderLogoutCommand(
  args: string[],
  commandName: string,
): Promise<void> {
  await handleProviderActionCommand(args, commandName, 'logout');
}

function parseMSTeamsLoginArgs(args: string[]): {
  appId: string | null;
  appPassword: string | null;
  tenantId: string | null;
} {
  let appId: string | null = null;
  let appPassword: string | null = null;
  let tenantId: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--app-id' || arg === '--client-id') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--app-id`.');
      appId = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--app-id=')) {
      appId = arg.slice('--app-id='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('--client-id=')) {
      appId = arg.slice('--client-id='.length).trim() || null;
      continue;
    }
    if (arg === '--app-password' || arg === '--client-secret') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--app-password`.');
      appPassword = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--app-password=')) {
      appPassword = arg.slice('--app-password='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('--client-secret=')) {
      appPassword = arg.slice('--client-secret='.length).trim() || null;
      continue;
    }
    if (arg === '--tenant-id') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--tenant-id`.');
      tenantId = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--tenant-id=')) {
      tenantId = arg.slice('--tenant-id='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]\`.`,
    );
  }

  return {
    appId,
    appPassword,
    tenantId,
  };
}

async function promptWithDefault(params: {
  rl: readline.Interface;
  question: string;
  defaultValue?: string;
  validate?: (value: string) => string | null;
  errorMessage?: string;
}): Promise<string> {
  while (true) {
    const suffix = params.defaultValue ? ` [${params.defaultValue}]` : '';
    const raw = (
      await params.rl.question(`${params.question}${suffix}: `)
    ).trim();
    const candidate = raw || params.defaultValue || '';
    const validated = params.validate ? params.validate(candidate) : candidate;
    if (validated) return validated;
    console.log(params.errorMessage || 'Please enter a valid value.');
  }
}

async function promptOptionalWithDefault(params: {
  rl: readline.Interface;
  question: string;
  defaultValue?: string;
}): Promise<string> {
  const suffix = params.defaultValue ? ` [${params.defaultValue}]` : '';
  const raw = (
    await params.rl.question(`${params.question}${suffix}: `)
  ).trim();
  return raw || params.defaultValue || '';
}

async function resolveInteractiveMSTeamsLogin(params: {
  appId: string;
  appPassword: string;
  tenantId: string;
}): Promise<{
  appId: string;
  appPassword: string;
  tenantId: string;
}> {
  let appId = params.appId;
  let appPassword = params.appPassword;

  if (appId && appPassword) {
    return {
      appId,
      appPassword,
      tenantId: params.tenantId,
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing Microsoft Teams credentials. Pass `--app-id <id>` and `--app-password <secret>` (or the `--client-id` / `--client-secret` aliases), set `MSTEAMS_APP_PASSWORD`, or run this command in an interactive terminal to be prompted.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    appId = await promptWithDefault({
      rl,
      question: 'Microsoft Teams app id',
      defaultValue: appId || undefined,
    });
    appPassword = await promptWithDefault({
      rl,
      question: 'Microsoft Teams app password',
      defaultValue: appPassword || undefined,
    });
    const tenantId = await promptOptionalWithDefault({
      rl,
      question: 'Microsoft Teams tenant id (optional)',
      defaultValue: params.tenantId || undefined,
    });
    return {
      appId,
      appPassword,
      tenantId,
    };
  } finally {
    rl.close();
  }
}

async function configureMSTeamsAuth(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseMSTeamsLoginArgs(args);
  const currentConfig = getRuntimeConfig().msteams;
  const resolved = await resolveInteractiveMSTeamsLogin({
    appId:
      parsed.appId || process.env.MSTEAMS_APP_ID?.trim() || currentConfig.appId,
    appPassword:
      parsed.appPassword ||
      process.env.MSTEAMS_APP_PASSWORD?.trim() ||
      readStoredRuntimeSecret('MSTEAMS_APP_PASSWORD') ||
      '',
    tenantId:
      parsed.tenantId ??
      process.env.MSTEAMS_TENANT_ID?.trim() ??
      currentConfig.tenantId,
  });

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.msteams.enabled = true;
    draft.msteams.appId = resolved.appId;
    draft.msteams.tenantId = resolved.tenantId;
  });
  const secretsPath = saveRuntimeSecrets({
    MSTEAMS_APP_PASSWORD: resolved.appPassword,
  });
  process.env.MSTEAMS_APP_PASSWORD = resolved.appPassword;

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Saved Microsoft Teams app password to ${secretsPath}.`);
  console.log('Microsoft Teams mode: enabled');
  console.log(`App ID: ${nextConfig.msteams.appId}`);
  console.log(`Tenant ID: ${nextConfig.msteams.tenantId || '(not set)'}`);
  console.log(`Webhook path: ${nextConfig.msteams.webhook.path}`);
  console.log(`DM policy: ${nextConfig.msteams.dmPolicy}`);
  console.log(`Group policy: ${nextConfig.msteams.groupPolicy}`);
  console.log(
    'Default Teams access is deny-by-default. Add allowed AAD object IDs or channel/team overrides before expecting replies.',
  );
  console.log('Next:');
  console.log('  Restart the gateway to pick up Teams settings:');
  console.log('    hybridclaw gateway restart --foreground');
  console.log('    hybridclaw gateway status');
  console.log(
    `  Expose ${nextConfig.msteams.webhook.path} on your public HTTPS endpoint and register it in the Teams bot channel`,
  );
}

export async function handleHybridAICommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printHybridAIUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'base-url') {
    configureHybridAIBaseUrl(normalized.slice(1));
    return;
  }
  if (sub === 'login') {
    await ensureHybridAIAuthApi();
    const parsed = parseHybridAILoginArgs(normalized.slice(1));
    const normalizedBaseUrl = parsed.baseUrl
      ? normalizeHybridAIBaseUrl(parsed.baseUrl)
      : undefined;
    if (normalizedBaseUrl) {
      updateRuntimeConfig((draft) => {
        draft.hybridai.baseUrl = normalizedBaseUrl;
      });
    }
    const result = await getHybridAIAuthApi().loginHybridAIInteractive({
      method: parsed.method,
      ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    });
    console.log(`Saved HybridAI credentials to ${result.path}.`);
    console.log(`Login method: ${result.method}`);
    console.log(`API key: ${result.maskedApiKey}`);
    console.log(`Validated: ${result.validated ? 'yes' : 'no'}`);
    if (normalizedBaseUrl) {
      console.log(`Base URL: ${normalizedBaseUrl}`);
    }
    return;
  }

  if (sub === 'logout') {
    await ensureHybridAIAuthApi();
    const filePath = getHybridAIAuthApi().clearHybridAICredentials();
    console.log(`Cleared HybridAI credentials in ${filePath}.`);
    console.log(
      'If HYBRIDAI_API_KEY is still exported in your shell, unset it separately.',
    );
    return;
  }

  if (sub === 'status') {
    await ensureHybridAIAuthApi();
    printHybridAIStatus();
    return;
  }

  throw new Error(`Unknown hybridai subcommand: ${sub}`);
}

export async function handleCodexCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printCodexUsage();
    return;
  }

  await ensureCodexAuthApi();

  const sub = normalized[0].toLowerCase();
  if (sub === 'login') {
    const method = parseCodexLoginMethod(normalized.slice(1));
    const result = await getCodexAuthApi().loginCodexInteractive({ method });
    console.log(`Saved Codex credentials to ${result.path}.`);
    console.log(`Account: ${result.credentials.accountId}`);
    console.log(`Source: ${result.method}`);
    console.log(
      `Expires: ${new Date(result.credentials.expiresAt).toISOString()}`,
    );
    return;
  }

  if (sub === 'logout') {
    const filePath = getCodexAuthApi().clearCodexCredentials();
    console.log(`Cleared Codex credentials in ${filePath}.`);
    return;
  }

  if (sub === 'status') {
    const status = getCodexAuthApi().getCodexAuthStatus();
    console.log(`Path: ${status.path}`);
    console.log(`Authenticated: ${status.authenticated ? 'yes' : 'no'}`);
    console.log(`Relogin required: ${status.reloginRequired ? 'yes' : 'no'}`);
    if (status.authenticated) {
      console.log(`Source: ${status.source}`);
      console.log(`Account: ${status.accountId}`);
      console.log(`Access token: ${status.maskedAccessToken}`);
      console.log(
        `Expires: ${status.expiresAt ? new Date(status.expiresAt).toISOString() : 'unknown'}`,
      );
    }
    return;
  }

  throw new Error(`Unknown codex subcommand: ${sub}`);
}
