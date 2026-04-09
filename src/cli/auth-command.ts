import readline from 'node:readline/promises';

import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  runtimeConfigPath,
  setRuntimeConfigSecretInput,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { resolveModelProvider } from '../providers/factory.js';
import type { LocalBackendType } from '../providers/local-types.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import {
  isLocalBackendType,
  LOCAL_BACKEND_IDS,
} from '../providers/provider-ids.js';
import { normalizeBaseUrl } from '../providers/utils.js';
import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { promptForSecretInput } from '../utils/secret-prompt.js';
import { makeLazyApi, normalizeArgs, parseValueFlag } from './common.js';
import {
  isHelpRequest,
  printAuthUsage,
  printCodexUsage,
  printHuggingFaceUsage,
  printHybridAIUsage,
  printLocalUsage,
  printMistralUsage,
  printMSTeamsUsage,
  printOpenRouterUsage,
  printWhatsAppUsage,
} from './help.js';
import { ensureOnboardingApi } from './onboarding-api.js';
import { ensureWhatsAppAuthApi, getWhatsAppAuthApi } from './whatsapp-api.js';

type HybridAIAuthApi = typeof import('../auth/hybridai-auth.js');
type CodexAuthApi = typeof import('../auth/codex-auth.js');

const hybridAIAuthApiState = makeLazyApi<HybridAIAuthApi>(
  () => import('../auth/hybridai-auth.js'),
  'HybridAI auth API accessed before it was initialized. Call ensureHybridAIAuthApi() first.',
);
const codexAuthApiState = makeLazyApi<CodexAuthApi>(
  () => import('../auth/codex-auth.js'),
  'Codex auth API accessed before it was initialized. Call ensureCodexAuthApi() first.',
);
const CONFIGURED_SECRET_STATUS = 'configured';

async function ensureHybridAIAuthApi(): Promise<HybridAIAuthApi> {
  return hybridAIAuthApiState.ensure();
}

function getHybridAIAuthApi(): HybridAIAuthApi {
  return hybridAIAuthApiState.get();
}

async function ensureCodexAuthApi(): Promise<CodexAuthApi> {
  return codexAuthApiState.ensure();
}

function getCodexAuthApi(): CodexAuthApi {
  return codexAuthApiState.get();
}

function parseExclusiveLoginMethodFlag<T extends string>(
  args: string[],
  params: {
    methods: Array<{
      flag: '--device-code' | '--browser' | '--import';
      value: T;
    }>;
    rejectUnknownFlags?: boolean;
  },
): T | null {
  const flags = new Set(args.map((arg) => arg.trim().toLowerCase()));
  const allowedFlags = new Set<string>(
    params.methods.map((method) => method.flag),
  );

  if (params.rejectUnknownFlags) {
    for (const arg of args) {
      if (!arg.startsWith('-')) continue;
      const normalized = arg.trim().toLowerCase();
      if (!allowedFlags.has(normalized)) {
        throw new Error(`Unknown flag: ${arg}`);
      }
    }
  }

  const requested = params.methods
    .filter((method) => flags.has(method.flag))
    .map((method) => method.value);

  if (requested.length > 1) {
    throw new Error(
      'Use only one of `--device-code`, `--browser`, or `--import`.',
    );
  }

  return requested[0] || null;
}

function parseCodexLoginMethod(
  args: string[],
): 'auto' | 'device-code' | 'browser-pkce' | 'codex-cli-import' {
  return (
    parseExclusiveLoginMethodFlag(args, {
      methods: [
        { flag: '--device-code', value: 'device-code' },
        { flag: '--browser', value: 'browser-pkce' },
        { flag: '--import', value: 'codex-cli-import' },
      ],
    }) || 'auto'
  );
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
    const baseUrlFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--base-url',
      placeholder: '<url>',
      allowEmptyEquals: true,
    });
    if (baseUrlFlag) {
      baseUrl = baseUrlFlag.value;
      index = baseUrlFlag.nextIndex;
      continue;
    }
    remaining.push(arg);
  }

  return { baseUrl, remaining };
}

function parseHybridAILoginArgs(args: string[]): ParsedHybridAILoginArgs {
  const { baseUrl, remaining } = extractBaseUrlArg(args);
  const method =
    parseExclusiveLoginMethodFlag(remaining, {
      methods: [
        { flag: '--device-code', value: 'device-code' },
        { flag: '--browser', value: 'browser' },
        { flag: '--import', value: 'import' },
      ],
      rejectUnknownFlags: true,
    }) || 'auto';

  return {
    method,
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
    const apiKeyFlag = parseValueFlag({
      arg,
      args: remaining,
      index,
      name: '--api-key',
      placeholder: '<key>',
      allowEmptyEquals: true,
    });
    if (apiKeyFlag) {
      apiKey = apiKeyFlag.value;
      index = apiKeyFlag.nextIndex;
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

function parseHuggingFaceLoginArgs(args: string[]): ParsedOpenRouterLoginArgs {
  return parseOpenRouterLoginArgs(args);
}

function normalizeProviderModelId(prefix: string, rawModelId: string): string {
  const trimmed = rawModelId.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith(prefix)) {
    return trimmed;
  }
  return `${prefix}${trimmed}`;
}

function normalizeProviderBaseUrl(
  defaultBaseUrl: string,
  requiredSuffixPattern: RegExp,
  requiredSuffix: string,
  rawBaseUrl: string,
): string {
  const trimmed = normalizeBaseUrl(rawBaseUrl);
  if (!trimmed) return defaultBaseUrl;
  return requiredSuffixPattern.test(trimmed)
    ? trimmed
    : `${trimmed}${requiredSuffix}`;
}

function normalizeOpenRouterModelId(rawModelId: string): string {
  return normalizeProviderModelId('openrouter/', rawModelId);
}

function normalizeOpenRouterBaseUrl(rawBaseUrl: string): string {
  return normalizeProviderBaseUrl(
    'https://openrouter.ai/api/v1',
    /\/api\/v1$/i,
    '/api/v1',
    rawBaseUrl,
  );
}

function normalizeMistralModelId(rawModelId: string): string {
  return normalizeProviderModelId('mistral/', rawModelId);
}

function normalizeMistralBaseUrl(rawBaseUrl: string): string {
  return normalizeProviderBaseUrl(
    'https://api.mistral.ai/v1',
    /\/v1$/i,
    '/v1',
    rawBaseUrl,
  );
}

function normalizeHuggingFaceModelId(rawModelId: string): string {
  return normalizeProviderModelId('huggingface/', rawModelId);
}

function normalizeHuggingFaceBaseUrl(rawBaseUrl: string): string {
  return normalizeProviderBaseUrl(
    'https://router.huggingface.co/v1',
    /\/v1$/i,
    '/v1',
    rawBaseUrl,
  );
}

async function promptForOpenRouterApiKey(): Promise<string> {
  return await promptForSecretInput({
    prompt: '🔒 Paste OpenRouter API key: ',
    missingMessage:
      'Missing OpenRouter API key. Pass `--api-key <key>`, set `OPENROUTER_API_KEY`, or run this command in an interactive terminal to paste it.',
  });
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

async function promptForMistralApiKey(): Promise<string> {
  return await promptForSecretInput({
    prompt: '🔒 Paste Mistral API key: ',
    missingMessage:
      'Missing Mistral API key. Pass `--api-key <key>`, set `MISTRAL_API_KEY`, or run this command in an interactive terminal to paste it.',
  });
}

async function resolveMistralApiKey(
  explicitApiKey: string | undefined,
): Promise<string> {
  const configuredApiKey =
    explicitApiKey?.trim() || process.env.MISTRAL_API_KEY?.trim() || '';
  if (configuredApiKey) return configuredApiKey;

  const promptedApiKey = await promptForMistralApiKey();
  if (promptedApiKey) return promptedApiKey;

  throw new Error(
    'Mistral API key cannot be empty. Pass `--api-key <key>`, set `MISTRAL_API_KEY`, or paste it when prompted.',
  );
}

async function promptForHuggingFaceApiKey(): Promise<string> {
  return await promptForSecretInput({
    prompt: '🔒 Paste Hugging Face token: ',
    missingMessage:
      'Missing Hugging Face token. Pass `--api-key <token>`, set `HF_TOKEN`, or run this command in an interactive terminal to paste it.',
  });
}

async function resolveHuggingFaceApiKey(
  explicitApiKey: string | undefined,
): Promise<string> {
  const configuredApiKey = explicitApiKey?.trim() || '';
  if (configuredApiKey) return configuredApiKey;

  const promptedApiKey = await promptForHuggingFaceApiKey();
  if (promptedApiKey) return promptedApiKey;

  throw new Error(
    'Hugging Face token cannot be empty. Pass `--api-key <token>` or paste it when prompted.',
  );
}

interface RouterProviderConfigFlowOptions {
  args: string[];
  providerId: 'openrouter' | 'mistral' | 'huggingface';
  providerLabel: 'OpenRouter' | 'Mistral' | 'Hugging Face';
  parseArgs: (args: string[]) => ParsedOpenRouterLoginArgs;
  getCurrentProviderConfig: () => { baseUrl: string };
  defaultModel: string;
  normalizeModelId: (modelId: string) => string;
  normalizeBaseUrl: (baseUrl: string) => string;
  resolveApiKey: (explicitApiKey: string | undefined) => Promise<string>;
  saveSecrets: (apiKey: string) => string;
  applyApiKeyToEnv: (apiKey: string) => void;
  updateConfig: (
    parsed: ParsedOpenRouterLoginArgs,
    normalizedBaseUrl: string,
    fullModelName: string,
  ) => ReturnType<typeof updateRuntimeConfig>;
}

async function configureRouterProvider(
  options: RouterProviderConfigFlowOptions,
): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = options.parseArgs(options.args);
  const currentProviderConfig = options.getCurrentProviderConfig();
  const currentDefaultModel = getRuntimeConfig().hybridai.defaultModel.trim();
  const configuredModel =
    parsed.modelId ||
    (resolveModelProvider(currentDefaultModel) === options.providerId
      ? currentDefaultModel
      : options.defaultModel);
  const fullModelName = options.normalizeModelId(configuredModel);
  if (!fullModelName) {
    throw new Error(`${options.providerLabel} model ID cannot be empty.`);
  }

  const apiKey = await options.resolveApiKey(parsed.apiKey);
  const normalizedBaseUrl = options.normalizeBaseUrl(
    parsed.baseUrl || currentProviderConfig.baseUrl,
  );
  const secretsPath = options.saveSecrets(apiKey);
  const nextConfig = options.updateConfig(
    parsed,
    normalizedBaseUrl,
    fullModelName,
  );

  options.applyApiKeyToEnv(apiKey);
  console.log(`Saved ${options.providerLabel} credentials to ${secretsPath}.`);
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Provider: ${options.providerId}`);
  console.log(`Base URL: ${normalizedBaseUrl}`);
  console.log(`Configured model: ${fullModelName}`);
  if (parsed.setDefault) {
    console.log(`Default model: ${fullModelName}`);
  } else {
    console.log(
      `Default model unchanged: ${formatModelForDisplay(nextConfig.hybridai.defaultModel)}`,
    );
  }
  console.log('Next:');
  console.log('  hybridclaw tui');
  console.log(`  /model set ${fullModelName}`);
}

async function configureOpenRouter(args: string[]): Promise<void> {
  await configureRouterProvider({
    args,
    providerId: 'openrouter',
    providerLabel: 'OpenRouter',
    parseArgs: parseOpenRouterLoginArgs,
    getCurrentProviderConfig: () => getRuntimeConfig().openrouter,
    defaultModel: 'openrouter/anthropic/claude-sonnet-4',
    normalizeModelId: normalizeOpenRouterModelId,
    normalizeBaseUrl: normalizeOpenRouterBaseUrl,
    resolveApiKey: resolveOpenRouterApiKey,
    saveSecrets: (apiKey) => saveRuntimeSecrets({ OPENROUTER_API_KEY: apiKey }),
    applyApiKeyToEnv: () => {},
    updateConfig: (parsed, normalizedBaseUrl, fullModelName) =>
      updateRuntimeConfig((draft) => {
        draft.openrouter.enabled = true;
        draft.openrouter.baseUrl = normalizedBaseUrl;
        if (parsed.setDefault) {
          draft.hybridai.defaultModel = fullModelName;
        }
      }),
  });
}

async function configureMistral(args: string[]): Promise<void> {
  await configureRouterProvider({
    args,
    providerId: 'mistral',
    providerLabel: 'Mistral',
    parseArgs: parseOpenRouterLoginArgs,
    getCurrentProviderConfig: () => getRuntimeConfig().mistral,
    defaultModel: 'mistral/mistral-large-latest',
    normalizeModelId: normalizeMistralModelId,
    normalizeBaseUrl: normalizeMistralBaseUrl,
    resolveApiKey: resolveMistralApiKey,
    saveSecrets: (apiKey) => saveRuntimeSecrets({ MISTRAL_API_KEY: apiKey }),
    applyApiKeyToEnv: () => {},
    updateConfig: (parsed, normalizedBaseUrl, fullModelName) =>
      updateRuntimeConfig((draft) => {
        draft.mistral.enabled = true;
        draft.mistral.baseUrl = normalizedBaseUrl;
        if (parsed.setDefault) {
          draft.hybridai.defaultModel = fullModelName;
        }
      }),
  });
}

async function configureHuggingFace(args: string[]): Promise<void> {
  await configureRouterProvider({
    args,
    providerId: 'huggingface',
    providerLabel: 'Hugging Face',
    parseArgs: parseHuggingFaceLoginArgs,
    getCurrentProviderConfig: () => getRuntimeConfig().huggingface,
    defaultModel: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    normalizeModelId: normalizeHuggingFaceModelId,
    normalizeBaseUrl: normalizeHuggingFaceBaseUrl,
    resolveApiKey: resolveHuggingFaceApiKey,
    saveSecrets: (apiKey) => saveRuntimeSecrets({ HF_TOKEN: apiKey }),
    applyApiKeyToEnv: () => {},
    updateConfig: (parsed, normalizedBaseUrl, fullModelName) =>
      updateRuntimeConfig((draft) => {
        draft.huggingface.enabled = true;
        draft.huggingface.baseUrl = normalizedBaseUrl;
        if (parsed.setDefault) {
          draft.hybridai.defaultModel = fullModelName;
        }
      }),
  });
}

type UnifiedProvider =
  | 'hybridai'
  | 'codex'
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
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
  if (normalized === 'mistral') {
    return 'mistral';
  }
  if (
    normalized === 'huggingface' ||
    normalized === 'hf' ||
    normalized === 'hugging-face' ||
    normalized === 'huggingface-hub'
  ) {
    return 'huggingface';
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
  if (args.length === 0) {
    return {
      provider: null,
      remaining: [],
    };
  }

  const first = args[0] || '';
  if (first === '--provider') {
    const rawProvider = args[1];
    if (!rawProvider) {
      throw new Error('Missing value for `--provider`.');
    }
    const provider = normalizeUnifiedProvider(rawProvider);
    if (!provider) {
      throw new Error(
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`local\`, or \`msteams\`.`,
      );
    }
    return {
      provider,
      remaining: args.slice(2),
    };
  }

  if (first.startsWith('--provider=')) {
    const rawProvider = first.slice('--provider='.length);
    const provider = normalizeUnifiedProvider(rawProvider);
    if (!provider) {
      throw new Error(
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`local\`, or \`msteams\`.`,
      );
    }
    return {
      provider,
      remaining: args.slice(1),
    };
  }

  const provider = normalizeUnifiedProvider(first);
  return {
    provider,
    remaining: provider == null ? args : args.slice(1),
  };
}

function isLocalProviderModel(modelName: string): boolean {
  return /^(ollama|lmstudio|llamacpp|vllm)\//i.test(modelName.trim());
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
    console.log(`API key: ${CONFIGURED_SECRET_STATUS}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.openrouter.enabled ? 'yes' : 'no'}`);
  console.log(`Base URL: ${config.openrouter.baseUrl}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  console.log('Catalog: auto-discovered');
}

function printMistralStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedApiKey = readStoredRuntimeSecret('MISTRAL_API_KEY');
  const envApiKey = process.env.MISTRAL_API_KEY?.trim() || '';
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
    console.log(`API key: ${CONFIGURED_SECRET_STATUS}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.mistral.enabled ? 'yes' : 'no'}`);
  console.log(`Base URL: ${config.mistral.baseUrl}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  console.log('Catalog: auto-discovered');
}

function printHuggingFaceStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedApiKey = readStoredRuntimeSecret('HF_TOKEN');
  const envApiKey =
    process.env.HF_TOKEN?.trim() ||
    process.env.HUGGINGFACE_API_KEY?.trim() ||
    '';
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
    console.log(`API key: ${CONFIGURED_SECRET_STATUS}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.huggingface.enabled ? 'yes' : 'no'}`);
  console.log(`Base URL: ${config.huggingface.baseUrl}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  console.log('Catalog: auto-discovered');
}

function clearOpenRouterCredentials(): void {
  const filePath = saveRuntimeSecrets({ OPENROUTER_API_KEY: null });
  console.log(`Cleared OpenRouter credentials in ${filePath}.`);
  console.log(
    'If OPENROUTER_API_KEY is still exported in your shell, unset it separately.',
  );
}

function clearMistralCredentials(): void {
  const filePath = saveRuntimeSecrets({ MISTRAL_API_KEY: null });
  console.log(`Cleared Mistral credentials in ${filePath}.`);
  console.log(
    'If MISTRAL_API_KEY is still exported in your shell, unset it separately.',
  );
}

function clearHuggingFaceCredentials(): void {
  const filePath = saveRuntimeSecrets({ HF_TOKEN: null });
  console.log(`Cleared Hugging Face credentials in ${filePath}.`);
  console.log(
    'If HF_TOKEN is still exported in your shell, unset it separately.',
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
    console.log(`API key: ${CONFIGURED_SECRET_STATUS}`);
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
    console.log(`App password: ${CONFIGURED_SECRET_STATUS}`);
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
  saveRuntimeSecrets({ VLLM_API_KEY: null });
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.local.backends.ollama.enabled = false;
    draft.local.backends.lmstudio.enabled = false;
    draft.local.backends.llamacpp.enabled = false;
    draft.local.backends.vllm.enabled = false;
    draft.local.backends.vllm.apiKey = '';
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log('Disabled local backends: ollama, lmstudio, llamacpp, vllm.');
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
  if (provider === 'mistral') {
    printMistralUsage();
    return;
  }
  if (provider === 'huggingface') {
    printHuggingFaceUsage();
    return;
  }
  if (provider === 'msteams') {
    printMSTeamsUsage();
    return;
  }
  printLocalUsage();
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
  if (/^(ollama|lmstudio|llamacpp|vllm)\//i.test(trimmed)) {
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
    if (backend === 'llamacpp') return 'http://127.0.0.1:8081/v1';
    return 'http://127.0.0.1:8000/v1';
  }
  if (backend === 'ollama') {
    return trimmed.replace(/\/v1$/i, '');
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

interface ParsedLocalConfigureArgs {
  backend: LocalBackendType;
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  setDefault: boolean;
}

function parseLocalConfigureArgs(args: string[]): ParsedLocalConfigureArgs {
  const positional: string[] = [];
  const { baseUrl, remaining } = extractBaseUrlArg(args);
  let apiKey: string | undefined;
  let setDefault = true;
  let setDefaultExplicit = false;

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index] || '';
    if (arg === '--no-default') {
      setDefault = false;
      setDefaultExplicit = true;
      continue;
    }
    if (arg === '--set-default') {
      setDefault = true;
      setDefaultExplicit = true;
      continue;
    }
    const apiKeyFlag = parseValueFlag({
      arg,
      args: remaining,
      index,
      name: '--api-key',
      placeholder: '<key>',
      allowEmptyEquals: true,
    });
    if (apiKeyFlag) {
      apiKey = apiKeyFlag.value;
      index = apiKeyFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length < 1) {
    throw new Error(
      'Usage: `hybridclaw local configure <ollama|lmstudio|llamacpp|vllm> [model-id] [--base-url <url>] [--api-key <key>] [--no-default]`',
    );
  }

  const backendRaw = (positional[0] || '').trim().toLowerCase();
  if (!isLocalBackendType(backendRaw)) {
    throw new Error(
      `Unknown local backend "${positional[0]}". Use \`ollama\`, \`lmstudio\`, \`llamacpp\`, or \`vllm\`.`,
    );
  }

  if (backendRaw !== 'vllm' && apiKey !== undefined) {
    throw new Error('`--api-key` is only supported for the `vllm` backend.');
  }

  const rawModelId = positional.slice(1).join(' ');
  const modelId = rawModelId
    ? normalizeLocalModelId(backendRaw, rawModelId)
    : undefined;
  if (setDefaultExplicit && setDefault && !modelId) {
    throw new Error('`--set-default` requires a model ID.');
  }

  return {
    backend: backendRaw,
    ...(modelId ? { modelId } : {}),
    baseUrl,
    apiKey,
    setDefault: Boolean(modelId) && setDefault,
  };
}

function printLocalStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  for (const backend of LOCAL_BACKEND_IDS) {
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
  const fullModelName = parsed.modelId
    ? `${parsed.backend}/${parsed.modelId}`
    : '';
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.local.backends[parsed.backend].enabled = true;
    draft.local.backends[parsed.backend].baseUrl = normalizedBaseUrl;
    if (parsed.backend === 'vllm' && parsed.apiKey !== undefined) {
      draft.local.backends.vllm.apiKey = '';
    }
    if (parsed.setDefault) {
      draft.hybridai.defaultModel = fullModelName;
    }
  });
  if (parsed.backend === 'vllm' && parsed.apiKey !== undefined) {
    saveRuntimeSecrets({ VLLM_API_KEY: parsed.apiKey });
    setRuntimeConfigSecretInput(
      'local.backends.vllm.apiKey',
      {
        source: 'store',
        id: 'VLLM_API_KEY',
      },
      {
        route: 'cli.auth.local.configure-vllm-secret-ref',
        source: 'user',
      },
    );
  }

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Backend: ${parsed.backend}`);
  console.log(`Base URL: ${nextConfig.local.backends[parsed.backend].baseUrl}`);
  if (fullModelName) {
    console.log(`Configured model: ${fullModelName}`);
  } else {
    console.log('Configured model: none');
  }
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
  if (fullModelName) {
    console.log(`  /model set ${fullModelName}`);
  } else {
    console.log(`  /model list ${parsed.backend}`);
    console.log(`  /model set ${parsed.backend}/<model>`);
  }
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

async function handleAuthLoginCommand(normalizedArgs: string[]): Promise<void> {
  if (normalizedArgs.length === 0) {
    const { ensureRuntimeCredentials } = await ensureOnboardingApi();
    await ensureRuntimeCredentials({
      commandName: 'hybridclaw auth login',
    });
    return;
  }
  if (isHelpRequest(normalizedArgs)) {
    printAuthUsage();
    return;
  }

  const parsed = parseUnifiedProviderArgs(normalizedArgs);
  if (!parsed.provider) {
    throw new Error(
      `Unknown auth login provider "${normalizedArgs[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`local\`, or \`msteams\`.`,
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
  if (parsed.provider === 'mistral') {
    await configureMistral(parsed.remaining);
    return;
  }
  if (parsed.provider === 'huggingface') {
    await configureHuggingFace(parsed.remaining);
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

async function handleAuthWhatsAppCommand(
  normalizedArgs: string[],
): Promise<void> {
  if (normalizedArgs.length === 0 || isHelpRequest(normalizedArgs)) {
    printWhatsAppUsage();
    return;
  }

  const sub = normalizedArgs[0].toLowerCase();
  if (sub !== 'reset') {
    throw new Error(
      `Unknown auth whatsapp subcommand: ${sub}. Use \`hybridclaw auth whatsapp reset\`.`,
    );
  }
  if (normalizedArgs.length > 1) {
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
  if (provider === 'mistral') {
    if (action === 'status') {
      printMistralStatus();
      return;
    }
    clearMistralCredentials();
    return;
  }
  if (provider === 'huggingface') {
    if (action === 'status') {
      printHuggingFaceStatus();
      return;
    }
    clearHuggingFaceCredentials();
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
  normalizedArgs: string[],
  commandName: string,
  action: ProviderAction,
): Promise<void> {
  if (normalizedArgs.length === 0 || isHelpRequest(normalizedArgs)) {
    printAuthUsage();
    return;
  }

  const parsed = parseUnifiedProviderArgs(normalizedArgs);
  if (!parsed.provider) {
    throw new Error(
      `Unknown ${action} provider "${normalizedArgs[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`local\`, or \`msteams\`.`,
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
    const appIdFlag =
      parseValueFlag({
        arg,
        args,
        index,
        name: '--app-id',
        placeholder: '<id>',
        allowEmptyEquals: true,
      }) ||
      parseValueFlag({
        arg,
        args,
        index,
        name: '--client-id',
        placeholder: '<id>',
        displayName: '--app-id',
        allowEmptyEquals: true,
      });
    if (appIdFlag) {
      appId = appIdFlag.value || null;
      index = appIdFlag.nextIndex;
      continue;
    }
    const appPasswordFlag =
      parseValueFlag({
        arg,
        args,
        index,
        name: '--app-password',
        placeholder: '<secret>',
        allowEmptyEquals: true,
      }) ||
      parseValueFlag({
        arg,
        args,
        index,
        name: '--client-secret',
        placeholder: '<secret>',
        displayName: '--app-password',
        allowEmptyEquals: true,
      });
    if (appPasswordFlag) {
      appPassword = appPasswordFlag.value || null;
      index = appPasswordFlag.nextIndex;
      continue;
    }
    const tenantIdFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--tenant-id',
      placeholder: '<id>',
      allowEmptyEquals: true,
    });
    if (tenantIdFlag) {
      tenantId = tenantIdFlag.value || null;
      index = tenantIdFlag.nextIndex;
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
  required?: boolean;
  secret?: boolean;
}): Promise<string> {
  while (true) {
    const suffix =
      params.defaultValue && !params.secret ? ` [${params.defaultValue}]` : '';
    const prompt = `${params.question}${suffix}: `;
    const raw = params.secret
      ? await promptForSecretInput({ prompt, rl: params.rl })
      : (await params.rl.question(prompt)).trim();
    const value = raw || params.defaultValue || '';
    if (value || params.required === false) {
      return value;
    }
    console.log('Please enter a value.');
  }
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

  const createPromptInterface = () =>
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  let rl = createPromptInterface();

  try {
    appId = await promptWithDefault({
      rl,
      question: 'Microsoft Teams app id',
      defaultValue: appId || undefined,
    });
    rl.close();
    appPassword =
      (appPassword || '').trim() ||
      (await promptForSecretInput({
        prompt: 'Microsoft Teams app password: ',
      }));
    rl = createPromptInterface();
    const tenantId = await promptWithDefault({
      rl,
      question: 'Microsoft Teams tenant id (optional)',
      defaultValue: params.tenantId || undefined,
      required: false,
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
      console.log(`Access token: ${CONFIGURED_SECRET_STATUS}`);
      console.log(
        `Expires: ${status.expiresAt ? new Date(status.expiresAt).toISOString() : 'unknown'}`,
      );
    }
    return;
  }

  throw new Error(`Unknown codex subcommand: ${sub}`);
}
