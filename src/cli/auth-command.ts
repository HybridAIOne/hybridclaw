import readline from 'node:readline/promises';
import {
  clearGoogleAuth,
  DEFAULT_GOOGLE_OAUTH_SCOPES,
  GOOGLE_ACCOUNT_SECRET,
  GOOGLE_OAUTH_CLIENT_ID_SECRET,
  GOOGLE_OAUTH_CLIENT_SECRET_SECRET,
  GOOGLE_OAUTH_REFRESH_TOKEN_SECRET,
  getGoogleAuthStatus,
  loginGoogle,
  parseGoogleScopes,
} from '../auth/google-auth.js';
import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  runtimeConfigPath,
  setRuntimeConfigSecretInput,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { resolveModelProvider } from '../providers/factory.js';
import {
  ANTHROPIC_DEFAULT_MODEL,
  normalizeAnthropicBaseUrl,
  normalizeAnthropicModelName,
} from '../providers/anthropic-utils.js';
import type { LocalBackendType } from '../providers/local-types.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import { getProviderAliasesFor } from '../providers/provider-aliases.js';
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
  printAnthropicUsage,
  printAuthUsage,
  printCodexUsage,
  printGoogleUsage,
  printHuggingFaceUsage,
  printHybridAIUsage,
  printLocalUsage,
  printMistralUsage,
  printMSTeamsUsage,
  printOpenRouterUsage,
  printSlackUsage,
  printWhatsAppUsage,
} from './help.js';
import { ensureOnboardingApi } from './onboarding-api.js';
import { ensureWhatsAppAuthApi, getWhatsAppAuthApi } from './whatsapp-api.js';

type HybridAIAuthApi = typeof import('../auth/hybridai-auth.js');
type CodexAuthApi = typeof import('../auth/codex-auth.js');
type AnthropicAuthApi = typeof import('../auth/anthropic-auth.js');

const hybridAIAuthApiState = makeLazyApi<HybridAIAuthApi>(
  () => import('../auth/hybridai-auth.js'),
  'HybridAI auth API accessed before it was initialized. Call ensureHybridAIAuthApi() first.',
);
const codexAuthApiState = makeLazyApi<CodexAuthApi>(
  () => import('../auth/codex-auth.js'),
  'Codex auth API accessed before it was initialized. Call ensureCodexAuthApi() first.',
);
const anthropicAuthApiState = makeLazyApi<AnthropicAuthApi>(
  () => import('../auth/anthropic-auth.js'),
  'Anthropic auth API accessed before it was initialized. Call ensureAnthropicAuthApi() first.',
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

async function ensureAnthropicAuthApi(): Promise<AnthropicAuthApi> {
  return anthropicAuthApiState.ensure();
}

function getAnthropicAuthApi(): AnthropicAuthApi {
  return anthropicAuthApiState.get();
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

interface ParsedAnthropicLoginArgs {
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  method: 'cli' | 'api-key';
  setDefault: boolean;
}

function parseAnthropicLoginArgs(args: string[]): ParsedAnthropicLoginArgs {
  const positional: string[] = [];
  const { baseUrl, remaining } = extractBaseUrlArg(args);
  let apiKey: string | undefined;
  let method: 'cli' | 'api-key' | undefined;
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
    const methodFlag = parseValueFlag({
      arg,
      args: remaining,
      index,
      name: '--method',
      placeholder: '<cli|api-key>',
      allowEmptyEquals: true,
    });
    if (methodFlag) {
      const normalizedMethod = methodFlag.value.trim().toLowerCase();
      if (normalizedMethod === 'cli') {
        method = 'cli';
      } else if (
        normalizedMethod === 'api-key' ||
        normalizedMethod === 'apikey' ||
        normalizedMethod === 'token'
      ) {
        method = 'api-key';
      } else {
        throw new Error(
          `Unknown Anthropic auth method "${methodFlag.value}". Use \`cli\` or \`api-key\`.`,
        );
      }
      index = methodFlag.nextIndex;
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
      method ||= 'api-key';
      index = apiKeyFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  const resolvedMethod = method || 'cli';
  if (resolvedMethod === 'cli' && apiKey !== undefined) {
    throw new Error(
      '`--api-key` cannot be used with `--method cli`. Use `--method api-key` or omit `--method` when passing an API key.',
    );
  }

  return {
    modelId: positional.length > 0 ? positional.join(' ') : undefined,
    baseUrl,
    apiKey,
    method: resolvedMethod,
    setDefault,
  };
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

async function promptForAnthropicApiKey(): Promise<string> {
  return await promptForSecretInput({
    prompt: '🔒 Paste Anthropic API key: ',
    missingMessage:
      'Missing Anthropic API key. Pass `--api-key <key>`, set `ANTHROPIC_API_KEY`, or run this command in an interactive terminal to paste it.',
  });
}

async function resolveAnthropicApiKey(
  explicitApiKey: string | undefined,
): Promise<string> {
  const configuredApiKey =
    explicitApiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || '';
  if (configuredApiKey) return configuredApiKey;

  const promptedApiKey = await promptForAnthropicApiKey();
  if (promptedApiKey) return promptedApiKey;

  throw new Error(
    'Anthropic API key cannot be empty. Pass `--api-key <key>`, set `ANTHROPIC_API_KEY`, or paste it when prompted.',
  );
}

async function resolveGenericProviderApiKey(
  providerLabel: string,
  envVarNames: string[],
  explicitApiKey: string | undefined,
): Promise<string> {
  const configuredApiKey =
    explicitApiKey?.trim() ||
    envVarNames.map((name) => process.env[name]?.trim()).find((v) => v) ||
    '';
  if (configuredApiKey) return configuredApiKey;

  const promptedApiKey = await promptForSecretInput({
    prompt: `🔒 Paste ${providerLabel} API key: `,
    missingMessage: `Missing ${providerLabel} API key. Pass \`--api-key <key>\`, set the appropriate environment variable, or run this command in an interactive terminal to paste it.`,
  });
  if (promptedApiKey) return promptedApiKey;

  throw new Error(
    `${providerLabel} API key cannot be empty. Pass \`--api-key <key>\` or paste it when prompted.`,
  );
}

interface RouterProviderConfigFlowOptions {
  args: string[];
  providerId:
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | 'gemini'
    | 'deepseek'
    | 'xai'
    | 'zai'
    | 'kimi'
    | 'minimax'
    | 'dashscope'
    | 'xiaomi'
    | 'kilo';
  providerLabel: string;
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

async function configureAnthropic(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  await ensureAnthropicAuthApi();

  const parsed = parseAnthropicLoginArgs(args);
  const currentProviderConfig = getRuntimeConfig().anthropic;
  const configuredModel =
    parsed.modelId ||
    currentProviderConfig.models[0] ||
    ANTHROPIC_DEFAULT_MODEL;
  const fullModelName = normalizeAnthropicModelName(configuredModel);
  if (!fullModelName) {
    throw new Error('Anthropic model ID cannot be empty.');
  }

  const normalizedBaseUrl = normalizeAnthropicBaseUrl(
    parsed.baseUrl || currentProviderConfig.baseUrl,
  );
  let savedSecretsPath: string | null = null;
  let cliCredentialPath: string | null = null;
  let expiresAt: number | null = null;

  if (parsed.method === 'cli') {
    const auth = getAnthropicAuthApi().requireAnthropicCliCredentials();
    cliCredentialPath = auth.path;
    expiresAt = auth.expiresAt;
  } else {
    const apiKey = await resolveAnthropicApiKey(parsed.apiKey);
    savedSecretsPath = saveRuntimeSecrets({ ANTHROPIC_API_KEY: apiKey });
    process.env.ANTHROPIC_API_KEY = apiKey;
  }

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.anthropic.enabled = true;
    draft.anthropic.baseUrl = normalizedBaseUrl;
    draft.anthropic.models = Array.from(
      new Set([fullModelName, ...draft.anthropic.models]),
    );
    if (parsed.setDefault) {
      draft.hybridai.defaultModel = fullModelName;
    }
  });

  if (savedSecretsPath) {
    console.log(`Saved Anthropic credentials to ${savedSecretsPath}.`);
  }
  if (cliCredentialPath) {
    console.log(`Using Claude Code credentials from ${cliCredentialPath}.`);
  }
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log('Provider: anthropic');
  console.log(`Auth method: ${parsed.method}`);
  if (expiresAt) {
    console.log(`Expires: ${new Date(expiresAt).toISOString()}`);
  }
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

interface GenericProviderAuthDef {
  /** Provider ID used in CLI and config. */
  id:
    | 'gemini'
    | 'deepseek'
    | 'xai'
    | 'zai'
    | 'kimi'
    | 'minimax'
    | 'dashscope'
    | 'xiaomi'
    | 'kilo';
  /** Human-readable label shown in status/error output. */
  label: string;
  /** Default model used when none is specified. */
  defaultModel: string;
  /** Default base URL for the API. */
  defaultBaseUrl: string;
  /** Regex to detect the URL path suffix that should be present. */
  baseUrlSuffixPattern: RegExp;
  /** Suffix appended to the base URL if the pattern doesn't match. */
  baseUrlSuffix: string;
  /** Canonical secret key name used for encrypted storage. */
  secretKey: string;
  /** All env var names checked for this provider (order matters). */
  envVarNames: string[];
  /** CLI aliases that resolve to this provider. */
  aliases: string[];
}

const GENERIC_PROVIDER_AUTH_DEFS: readonly GenericProviderAuthDef[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini/gemini-2.5-pro',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlSuffixPattern: /\/openai$/i,
    baseUrlSuffix: '/openai',
    secretKey: 'GEMINI_API_KEY',
    envVarNames: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    aliases: getProviderAliasesFor('gemini'),
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek/deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'DEEPSEEK_API_KEY',
    envVarNames: ['DEEPSEEK_API_KEY'],
    aliases: getProviderAliasesFor('deepseek'),
  },
  {
    id: 'xai',
    label: 'xAI',
    defaultModel: 'xai/grok-3',
    defaultBaseUrl: 'https://api.x.ai/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'XAI_API_KEY',
    envVarNames: ['XAI_API_KEY'],
    aliases: getProviderAliasesFor('xai'),
  },
  {
    id: 'zai',
    label: 'Z.AI / GLM',
    defaultModel: 'zai/glm-5.1',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    baseUrlSuffixPattern: /\/v4$/i,
    baseUrlSuffix: '/v4',
    secretKey: 'ZAI_API_KEY',
    envVarNames: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
    aliases: getProviderAliasesFor('zai'),
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot',
    defaultModel: 'kimi/kimi-k2.5',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'KIMI_API_KEY',
    envVarNames: ['KIMI_API_KEY'],
    aliases: getProviderAliasesFor('kimi'),
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    defaultModel: 'minimax/MiniMax-M2',
    defaultBaseUrl: 'https://api.minimax.io/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'MINIMAX_API_KEY',
    envVarNames: ['MINIMAX_API_KEY'],
    aliases: getProviderAliasesFor('minimax'),
  },
  {
    id: 'dashscope',
    label: 'DashScope / Qwen',
    defaultModel: 'dashscope/qwen3-coder-plus',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'DASHSCOPE_API_KEY',
    envVarNames: ['DASHSCOPE_API_KEY'],
    aliases: getProviderAliasesFor('dashscope'),
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    defaultModel: 'xiaomi/MiMo-7B-RL',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'XIAOMI_API_KEY',
    envVarNames: ['XIAOMI_API_KEY'],
    aliases: getProviderAliasesFor('xiaomi'),
  },
  {
    id: 'kilo',
    label: 'Kilo Code',
    defaultModel: 'kilo/anthropic/claude-sonnet-4.6',
    defaultBaseUrl: 'https://api.kilo.ai/api/gateway',
    baseUrlSuffixPattern: /\/api\/gateway$/i,
    baseUrlSuffix: '/api/gateway',
    secretKey: 'KILO_API_KEY',
    envVarNames: ['KILOCODE_API_KEY', 'KILO_API_KEY'],
    aliases: getProviderAliasesFor('kilo'),
  },
] as const;

const GENERIC_PROVIDER_BY_ID = new Map(
  GENERIC_PROVIDER_AUTH_DEFS.map((def) => [def.id, def]),
);

function findGenericProviderDef(
  id: string,
): GenericProviderAuthDef | undefined {
  return GENERIC_PROVIDER_BY_ID.get(id as GenericProviderAuthDef['id']);
}

async function configureGenericProvider(
  def: GenericProviderAuthDef,
  args: string[],
): Promise<void> {
  const prefix = `${def.id}/`;
  await configureRouterProvider({
    args,
    providerId: def.id,
    providerLabel: def.label,
    parseArgs: parseOpenRouterLoginArgs,
    getCurrentProviderConfig: () =>
      getRuntimeConfig()[def.id] as { baseUrl: string },
    defaultModel: def.defaultModel,
    normalizeModelId: (id) => normalizeProviderModelId(prefix, id),
    normalizeBaseUrl: (url) =>
      normalizeProviderBaseUrl(
        def.defaultBaseUrl,
        def.baseUrlSuffixPattern,
        def.baseUrlSuffix,
        url,
      ),
    resolveApiKey: (key) =>
      resolveGenericProviderApiKey(def.label, def.envVarNames, key),
    saveSecrets: (apiKey) => saveRuntimeSecrets({ [def.secretKey]: apiKey }),
    applyApiKeyToEnv: () => {},
    updateConfig: (parsed, normalizedBaseUrl, fullModelName) =>
      updateRuntimeConfig((draft) => {
        const section = draft[def.id] as {
          enabled: boolean;
          baseUrl: string;
        };
        section.enabled = true;
        section.baseUrl = normalizedBaseUrl;
        if (parsed.setDefault) {
          draft.hybridai.defaultModel = fullModelName;
        }
      }),
  });
}

type UnifiedProvider =
  | 'hybridai'
  | 'codex'
  | 'anthropic'
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
  | 'google'
  | 'gemini'
  | 'deepseek'
  | 'xai'
  | 'zai'
  | 'kimi'
  | 'minimax'
  | 'dashscope'
  | 'xiaomi'
  | 'kilo'
  | 'local'
  | 'msteams'
  | 'slack';

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
  if (normalized === 'anthropic' || normalized === 'claude') {
    return 'anthropic';
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
  if (normalized === 'google' || normalized === 'gog') {
    return 'google';
  }
  // Check data-driven generic providers by id or alias.
  for (const def of GENERIC_PROVIDER_AUTH_DEFS) {
    if (normalized === def.id || def.aliases.includes(normalized)) {
      return def.id;
    }
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
  if (normalized === 'slack') {
    return 'slack';
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
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`anthropic\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`google\`, \`gemini\`, \`deepseek\`, \`xai\`, \`zai\`, \`kimi\`, \`minimax\`, \`dashscope\`, \`xiaomi\`, \`kilo\`, \`local\`, \`msteams\`, or \`slack\`.`,
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
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`anthropic\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`google\`, \`gemini\`, \`deepseek\`, \`xai\`, \`zai\`, \`kimi\`, \`minimax\`, \`dashscope\`, \`xiaomi\`, \`kilo\`, \`local\`, \`msteams\`, or \`slack\`.`,
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

type ApiKeyProviderConfigKey =
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
  | 'gemini'
  | 'deepseek'
  | 'xai'
  | 'zai'
  | 'kimi'
  | 'minimax'
  | 'dashscope'
  | 'xiaomi'
  | 'kilo';

function printApiKeyProviderStatus(options: {
  providerLabel?: string;
  configKey: ApiKeyProviderConfigKey;
  secretKey: string;
  envVarNames: string[];
  showProviderLabel?: boolean;
  catalog?: string;
}): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedApiKey = readStoredRuntimeSecret(options.secretKey);
  const envApiKey =
    options.envVarNames
      .map((name) => process.env[name]?.trim())
      .find((value) => value) || '';
  const source = envApiKey
    ? storedApiKey && envApiKey === storedApiKey
      ? 'runtime-secrets'
      : 'env'
    : storedApiKey
      ? 'runtime-secrets'
      : null;
  const apiKey = envApiKey || storedApiKey || '';

  if (options.showProviderLabel && options.providerLabel) {
    console.log(`Provider: ${options.providerLabel}`);
  }
  console.log(`Path: ${runtimeSecretsPath()}`);
  console.log(`Authenticated: ${apiKey ? 'yes' : 'no'}`);
  if (source) {
    console.log(`Source: ${source}`);
  }
  if (apiKey) {
    console.log(`API key: ${CONFIGURED_SECRET_STATUS}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config[options.configKey].enabled ? 'yes' : 'no'}`);
  console.log(`Base URL: ${config[options.configKey].baseUrl}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  if (options.catalog) {
    console.log(`Catalog: ${options.catalog}`);
  }
}

function printAnthropicStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const status = getAnthropicAuthApi().getAnthropicAuthStatus();

  console.log(`Path: ${status.path}`);
  console.log(`Authenticated: ${status.authenticated ? 'yes' : 'no'}`);
  if (status.method) {
    console.log(`Method: ${status.method}`);
  }
  if (status.source) {
    console.log(`Source: ${status.source}`);
  }
  if (status.maskedValue) {
    console.log(
      `${status.method === 'api-key' ? 'API key' : 'Credential'}: ${status.maskedValue}`,
    );
  }
  if (status.expiresAt) {
    console.log(`Expires: ${new Date(status.expiresAt).toISOString()}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.anthropic.enabled ? 'yes' : 'no'}`);
  console.log(`Base URL: ${config.anthropic.baseUrl}`);
  console.log(
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  );
  console.log(
    `Models: ${config.anthropic.models.length > 0 ? config.anthropic.models.join(', ') : '(none configured)'}`,
  );
}

function clearOpenRouterCredentials(): void {
  const filePath = saveRuntimeSecrets({ OPENROUTER_API_KEY: null });
  console.log(`Cleared OpenRouter credentials in ${filePath}.`);
  console.log(
    'If OPENROUTER_API_KEY is still exported in your shell, unset it separately.',
  );
}

function clearAnthropicCredentials(): void {
  const filePath = saveRuntimeSecrets({ ANTHROPIC_API_KEY: null });
  console.log(`Cleared stored Anthropic API key in ${filePath}.`);
  console.log(
    'If Claude Code credentials are still present on this host, HybridClaw will keep using them. Run `claude auth logout` separately if you also want to remove the Claude CLI session.',
  );
  console.log(
    'If ANTHROPIC_API_KEY is still exported in your shell, unset it separately.',
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

function printGoogleStatus(): void {
  const status = getGoogleAuthStatus();
  console.log(`Path: ${status.path}`);
  console.log(`Authenticated: ${status.authenticated ? 'yes' : 'no'}`);
  if (status.authenticated) {
    console.log('Source: runtime-secrets');
    console.log(`Account: ${status.account || '(not set)'}`);
    console.log('Refresh token: configured');
    console.log('Client secret: configured');
    console.log(`Scopes: ${status.scopes.join(' ')}`);
    console.log('gog mode: direct access token');
  }
}

function clearGoogleCredentials(): void {
  const filePath = clearGoogleAuth();
  console.log(`Cleared Google OAuth credentials from ${filePath}.`);
  console.log('gog containers will no longer receive GOG_ACCESS_TOKEN.');
}

function parseGoogleLoginArgs(args: string[]): {
  account?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  scopes?: string;
  redirectPort?: number;
} {
  type GoogleStringFlagKey =
    | 'account'
    | 'clientId'
    | 'clientSecret'
    | 'refreshToken'
    | 'scopes';
  const parsed: {
    account?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    scopes?: string;
    redirectPort?: number;
  } = {};
  const stringFlags: Array<{
    key: GoogleStringFlagKey;
    name: string;
    placeholder: string;
  }> = [
    { key: 'account', name: '--account', placeholder: '<email>' },
    { key: 'clientId', name: '--client-id', placeholder: '<id>' },
    {
      key: 'clientSecret',
      name: '--client-secret',
      placeholder: '<secret>',
    },
    {
      key: 'refreshToken',
      name: '--refresh-token',
      placeholder: '<token>',
    },
    { key: 'scopes', name: '--scopes', placeholder: '<scopes>' },
  ];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    let matchedStringFlag = false;
    for (const flag of stringFlags) {
      const parsedFlag = parseValueFlag({
        arg,
        args,
        index,
        name: flag.name,
        placeholder: flag.placeholder,
        allowEmptyEquals: true,
      });
      if (!parsedFlag) continue;
      parsed[flag.key] = parsedFlag.value || undefined;
      index = parsedFlag.nextIndex;
      matchedStringFlag = true;
      break;
    }
    if (matchedStringFlag) continue;

    const redirectPortFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--redirect-port',
      placeholder: '<port>',
      allowEmptyEquals: true,
    });
    if (redirectPortFlag) {
      const port = Number.parseInt(redirectPortFlag.value, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(
          'Google OAuth redirect port must be between 1 and 65535.',
        );
      }
      parsed.redirectPort = port;
      index = redirectPortFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw auth login google --help\`.`,
    );
  }

  return parsed;
}

async function resolveInteractiveGoogleLogin(params: {
  account: string;
  clientId: string;
  clientSecret: string;
}): Promise<{
  account: string;
  clientId: string;
  clientSecret: string;
}> {
  if (params.account && params.clientId && params.clientSecret) {
    return params;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing Google OAuth credentials. Pass `--client-id <id>`, `--client-secret <secret>`, and `--account <email>`, or run this command in an interactive terminal.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const account = await promptWithDefault({
      rl,
      question: 'Google account email',
      defaultValue: params.account || undefined,
    });
    const clientId = await promptWithDefault({
      rl,
      question: 'Google OAuth desktop client id',
      defaultValue: params.clientId || undefined,
    });
    const clientSecret = await promptWithDefault({
      rl,
      question: 'Google OAuth desktop client secret',
      defaultValue: params.clientSecret || undefined,
      secret: true,
    });
    return {
      account,
      clientId,
      clientSecret,
    };
  } finally {
    rl.close();
  }
}

async function configureGoogleAuth(args: string[]): Promise<void> {
  const parsed = parseGoogleLoginArgs(args);
  const resolved = await resolveInteractiveGoogleLogin({
    account:
      parsed.account ||
      process.env[GOOGLE_ACCOUNT_SECRET]?.trim() ||
      readStoredRuntimeSecret(GOOGLE_ACCOUNT_SECRET) ||
      '',
    clientId:
      parsed.clientId ||
      process.env[GOOGLE_OAUTH_CLIENT_ID_SECRET]?.trim() ||
      readStoredRuntimeSecret(GOOGLE_OAUTH_CLIENT_ID_SECRET) ||
      '',
    clientSecret:
      parsed.clientSecret ||
      process.env[GOOGLE_OAUTH_CLIENT_SECRET_SECRET]?.trim() ||
      readStoredRuntimeSecret(GOOGLE_OAUTH_CLIENT_SECRET_SECRET) ||
      '',
  });
  const scopes = parseGoogleScopes(
    parsed.scopes ||
      process.env.GOOGLE_OAUTH_SCOPES?.trim() ||
      readStoredRuntimeSecret('GOOGLE_OAUTH_SCOPES') ||
      DEFAULT_GOOGLE_OAUTH_SCOPES.join(' '),
  );
  const result = await loginGoogle({
    account: resolved.account,
    clientId: resolved.clientId,
    clientSecret: resolved.clientSecret,
    refreshToken:
      parsed.refreshToken ||
      process.env[GOOGLE_OAUTH_REFRESH_TOKEN_SECRET]?.trim() ||
      undefined,
    scopes,
    redirectPort: parsed.redirectPort,
  });

  console.log(`Saved Google OAuth credentials to ${result.secretsPath}.`);
  console.log(`Account: ${result.account}`);
  console.log(`Scopes: ${result.scopes.join(' ')}`);
  console.log(
    result.usedProvidedRefreshToken
      ? 'Stored provided refresh token.'
      : 'Completed browser authorization and stored refresh token.',
  );
  console.log(
    'Agent containers will receive a fresh short-lived GOG_ACCESS_TOKEN for gog.',
  );
}

function clearGenericProviderCredentials(
  providerLabel: string,
  secretKey: string,
  envVarNames: string[],
): void {
  const filePath = saveRuntimeSecrets({ [secretKey]: null });
  console.log(`Cleared ${providerLabel} credentials in ${filePath}.`);
  const hint = envVarNames.join('`, `');
  console.log(
    `If \`${hint}\` is still exported in your shell, unset it separately.`,
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

function printSlackStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedBotToken = readStoredRuntimeSecret('SLACK_BOT_TOKEN');
  const storedAppToken = readStoredRuntimeSecret('SLACK_APP_TOKEN');
  const envBotToken = process.env.SLACK_BOT_TOKEN?.trim() || '';
  const envAppToken = process.env.SLACK_APP_TOKEN?.trim() || '';
  const botToken = envBotToken || storedBotToken || '';
  const appToken = envAppToken || storedAppToken || '';
  const botSource = envBotToken
    ? storedBotToken && envBotToken === storedBotToken
      ? 'runtime-secrets'
      : 'env'
    : storedBotToken
      ? 'runtime-secrets'
      : null;
  const appSource = envAppToken
    ? storedAppToken && envAppToken === storedAppToken
      ? 'runtime-secrets'
      : 'env'
    : storedAppToken
      ? 'runtime-secrets'
      : null;

  console.log(`Path: ${runtimeSecretsPath()}`);
  console.log(`Authenticated: ${botToken && appToken ? 'yes' : 'no'}`);
  if (botSource) {
    console.log(`Bot token source: ${botSource}`);
  }
  if (appSource) {
    console.log(`App token source: ${appSource}`);
  }
  if (botToken) {
    console.log(`Bot token: ${CONFIGURED_SECRET_STATUS}`);
  }
  if (appToken) {
    console.log(`App token: ${CONFIGURED_SECRET_STATUS}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.slack.enabled ? 'yes' : 'no'}`);
  console.log(`DM policy: ${config.slack.dmPolicy}`);
  console.log(`Group policy: ${config.slack.groupPolicy}`);
  console.log(`Require mention: ${config.slack.requireMention ? 'yes' : 'no'}`);
  console.log(`Reply style: ${config.slack.replyStyle}`);
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

function clearSlackCredentials(): void {
  ensureRuntimeConfigFile();
  const filePath = saveRuntimeSecrets({
    SLACK_BOT_TOKEN: null,
    SLACK_APP_TOKEN: null,
  });
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.slack.enabled = false;
  });

  console.log(`Cleared Slack credentials in ${filePath}.`);
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(
    `Slack integration: ${nextConfig.slack.enabled ? 'enabled' : 'disabled'}`,
  );
  console.log(
    'If SLACK_BOT_TOKEN or SLACK_APP_TOKEN are still exported in your shell, unset them separately.',
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
  if (provider === 'anthropic') {
    printAnthropicUsage();
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
  if (provider === 'google') {
    printGoogleUsage();
    return;
  }
  if (findGenericProviderDef(provider)) {
    console.log(
      `Usage: hybridclaw auth login ${provider} [--api-key <key>] [--base-url <url>] [--model <model>] [--no-default]`,
    );
    return;
  }
  if (provider === 'msteams') {
    printMSTeamsUsage();
    return;
  }
  if (provider === 'slack') {
    printSlackUsage();
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
      `Unknown auth login provider "${normalizedArgs[0]}". Use \`hybridai\`, \`codex\`, \`anthropic\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`google\`, \`gemini\`, \`deepseek\`, \`xai\`, \`zai\`, \`kimi\`, \`minimax\`, \`dashscope\`, \`xiaomi\`, \`kilo\`, \`local\`, \`msteams\`, or \`slack\`.`,
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
  if (parsed.provider === 'anthropic') {
    await configureAnthropic(parsed.remaining);
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
  if (parsed.provider === 'google') {
    await configureGoogleAuth(parsed.remaining);
    return;
  }
  const genericLoginDef = findGenericProviderDef(parsed.provider);
  if (genericLoginDef) {
    await configureGenericProvider(genericLoginDef, parsed.remaining);
    return;
  }
  if (parsed.provider === 'msteams') {
    await configureMSTeamsAuth(parsed.remaining);
    return;
  }
  if (parsed.provider === 'slack') {
    await configureSlackAuth(parsed.remaining);
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
  if (provider === 'anthropic') {
    if (action === 'status') {
      await ensureAnthropicAuthApi();
      printAnthropicStatus();
      return;
    }
    clearAnthropicCredentials();
    return;
  }
  if (provider === 'openrouter') {
    if (action === 'status') {
      printApiKeyProviderStatus({
        configKey: 'openrouter',
        secretKey: 'OPENROUTER_API_KEY',
        envVarNames: ['OPENROUTER_API_KEY'],
        catalog: 'auto-discovered',
      });
      return;
    }
    clearOpenRouterCredentials();
    return;
  }
  if (provider === 'mistral') {
    if (action === 'status') {
      printApiKeyProviderStatus({
        configKey: 'mistral',
        secretKey: 'MISTRAL_API_KEY',
        envVarNames: ['MISTRAL_API_KEY'],
        catalog: 'auto-discovered',
      });
      return;
    }
    clearMistralCredentials();
    return;
  }
  if (provider === 'huggingface') {
    if (action === 'status') {
      printApiKeyProviderStatus({
        configKey: 'huggingface',
        secretKey: 'HF_TOKEN',
        envVarNames: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
        catalog: 'auto-discovered',
      });
      return;
    }
    clearHuggingFaceCredentials();
    return;
  }
  if (provider === 'google') {
    if (action === 'status') {
      printGoogleStatus();
      return;
    }
    clearGoogleCredentials();
    return;
  }
  const genericDef = findGenericProviderDef(provider);
  if (genericDef) {
    if (action === 'status') {
      printApiKeyProviderStatus({
        providerLabel: genericDef.label,
        configKey: genericDef.id,
        secretKey: genericDef.secretKey,
        envVarNames: genericDef.envVarNames,
        showProviderLabel: true,
      });
      return;
    }
    clearGenericProviderCredentials(
      genericDef.label,
      genericDef.secretKey,
      genericDef.envVarNames,
    );
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
  if (provider === 'slack') {
    if (action === 'status') {
      printSlackStatus();
      return;
    }
    clearSlackCredentials();
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
      `Unknown ${action} provider "${normalizedArgs[0]}". Use \`hybridai\`, \`codex\`, \`anthropic\`, \`openrouter\`, \`mistral\`, \`huggingface\`, \`google\`, \`gemini\`, \`deepseek\`, \`xai\`, \`zai\`, \`kimi\`, \`minimax\`, \`dashscope\`, \`xiaomi\`, \`kilo\`, \`local\`, \`msteams\`, or \`slack\`.`,
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

function parseSlackLoginArgs(args: string[]): {
  botToken: string | null;
  appToken: string | null;
} {
  let botToken: string | null = null;
  let appToken: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    const botTokenFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--bot-token',
      placeholder: '<xoxb...>',
      allowEmptyEquals: true,
    });
    if (botTokenFlag) {
      botToken = botTokenFlag.value || null;
      index = botTokenFlag.nextIndex;
      continue;
    }
    const appTokenFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--app-token',
      placeholder: '<xapp...>',
      allowEmptyEquals: true,
    });
    if (appTokenFlag) {
      appToken = appTokenFlag.value || null;
      index = appTokenFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw auth login slack [--bot-token <xoxb...>] [--app-token <xapp...>]\`.`,
    );
  }

  return {
    botToken,
    appToken,
  };
}

async function resolveInteractiveSlackLogin(params: {
  botToken: string;
  appToken: string;
}): Promise<{
  botToken: string;
  appToken: string;
}> {
  let botToken = params.botToken;
  let appToken = params.appToken;

  if (botToken && appToken) {
    return { botToken, appToken };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing Slack credentials. Pass `--bot-token <xoxb...>` and `--app-token <xapp...>`, set `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`, or run this command in an interactive terminal to be prompted.',
    );
  }

  botToken =
    botToken ||
    (await promptForSecretInput({
      prompt: 'Slack bot token (xoxb-...): ',
    }));
  appToken =
    appToken ||
    (await promptForSecretInput({
      prompt: 'Slack app token (xapp-...): ',
    }));
  return { botToken, appToken };
}

async function configureSlackAuth(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseSlackLoginArgs(args);
  const currentConfig = getRuntimeConfig().slack;
  const resolved = await resolveInteractiveSlackLogin({
    botToken:
      parsed.botToken ||
      process.env.SLACK_BOT_TOKEN?.trim() ||
      readStoredRuntimeSecret('SLACK_BOT_TOKEN') ||
      '',
    appToken:
      parsed.appToken ||
      process.env.SLACK_APP_TOKEN?.trim() ||
      readStoredRuntimeSecret('SLACK_APP_TOKEN') ||
      '',
  });

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.slack.enabled = true;
  });
  const secretsPath = saveRuntimeSecrets({
    SLACK_BOT_TOKEN: resolved.botToken,
    SLACK_APP_TOKEN: resolved.appToken,
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Saved Slack tokens to ${secretsPath}.`);
  console.log(
    `Slack mode: ${nextConfig.slack.enabled ? 'enabled' : 'disabled'}`,
  );
  console.log(`DM policy: ${currentConfig.dmPolicy}`);
  console.log(`Group policy: ${currentConfig.groupPolicy}`);
  console.log(
    `Require mention: ${currentConfig.requireMention ? 'yes' : 'no'}`,
  );
  console.log(`Reply style: ${currentConfig.replyStyle}`);
  console.log('Next:');
  console.log('  hybridclaw gateway restart --foreground');
  console.log('  hybridclaw gateway status');
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
