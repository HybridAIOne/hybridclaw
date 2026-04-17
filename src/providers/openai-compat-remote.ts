import {
  DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL,
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
  HUGGINGFACE_API_KEY,
  HUGGINGFACE_BASE_URL,
  KILO_API_KEY,
  KILO_BASE_URL,
  KIMI_API_KEY,
  KIMI_BASE_URL,
  MINIMAX_API_KEY,
  MINIMAX_BASE_URL,
  MISTRAL_API_KEY,
  MISTRAL_BASE_URL,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  XAI_API_KEY,
  XAI_BASE_URL,
  XIAOMI_API_KEY,
  XIAOMI_BASE_URL,
  ZAI_API_KEY,
  ZAI_BASE_URL,
} from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';
import type { RuntimeProviderId } from './provider-ids.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export type OpenAICompatRemoteProviderId =
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

export interface OpenAICompatRemoteProviderDef {
  id: OpenAICompatRemoteProviderId;
  prefix: string;
  readBaseUrl: () => string;
  readApiKey: (opts?: { required?: boolean }) => string;
  missingEnvVar: string;
}

export function createOpenAICompatRemoteProvider(
  def: OpenAICompatRemoteProviderDef,
): AIProvider {
  const matchesModel = createModelMatcher(def.prefix);

  async function resolveRuntimeCredentials(
    params: ResolveProviderRuntimeParams,
  ): Promise<ResolvedModelRuntimeCredentials> {
    const agentId = normalizeAgentId(params.agentId);
    return {
      provider: def.id,
      apiKey: def.readApiKey({ required: true }),
      baseUrl: normalizeBaseUrl(def.readBaseUrl()),
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId,
      isLocal: false,
    };
  }

  return {
    id: def.id,
    matchesModel,
    requiresChatbotId: () => false,
    resolveRuntimeCredentials,
  };
}

export const OPENAI_COMPAT_REMOTE_PROVIDERS: readonly OpenAICompatRemoteProviderDef[] =
  [
    {
      id: 'openrouter',
      prefix: 'openrouter/',
      readBaseUrl: () => OPENROUTER_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [process.env.OPENROUTER_API_KEY, OPENROUTER_API_KEY],
          'OPENROUTER_API_KEY',
          opts,
        ),
      missingEnvVar: 'OPENROUTER_API_KEY',
    },
    {
      id: 'mistral',
      prefix: 'mistral/',
      readBaseUrl: () => MISTRAL_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [process.env.MISTRAL_API_KEY, MISTRAL_API_KEY],
          'MISTRAL_API_KEY',
          opts,
        ),
      missingEnvVar: 'MISTRAL_API_KEY',
    },
    {
      id: 'huggingface',
      prefix: 'huggingface/',
      readBaseUrl: () => HUGGINGFACE_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [
            process.env.HF_TOKEN,
            process.env.HUGGINGFACE_API_KEY,
            HUGGINGFACE_API_KEY,
          ],
          'HF_TOKEN',
          opts,
        ),
      missingEnvVar: 'HF_TOKEN',
    },
    {
      id: 'gemini',
      prefix: 'gemini/',
      readBaseUrl: () => GEMINI_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [
            process.env.GOOGLE_API_KEY,
            process.env.GEMINI_API_KEY,
            GEMINI_API_KEY,
          ],
          'GEMINI_API_KEY',
          opts,
        ),
      missingEnvVar: 'GEMINI_API_KEY',
    },
    {
      id: 'deepseek',
      prefix: 'deepseek/',
      readBaseUrl: () => DEEPSEEK_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [process.env.DEEPSEEK_API_KEY, DEEPSEEK_API_KEY],
          'DEEPSEEK_API_KEY',
          opts,
        ),
      missingEnvVar: 'DEEPSEEK_API_KEY',
    },
    {
      id: 'xai',
      prefix: 'xai/',
      readBaseUrl: () => XAI_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [process.env.XAI_API_KEY, XAI_API_KEY],
          'XAI_API_KEY',
          opts,
        ),
      missingEnvVar: 'XAI_API_KEY',
    },
    {
      id: 'zai',
      prefix: 'zai/',
      readBaseUrl: () => ZAI_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [
            process.env.GLM_API_KEY,
            process.env.ZAI_API_KEY,
            process.env.Z_AI_API_KEY,
            ZAI_API_KEY,
          ],
          'ZAI_API_KEY',
          opts,
        ),
      missingEnvVar: 'ZAI_API_KEY',
    },
    {
      id: 'kimi',
      prefix: 'kimi/',
      readBaseUrl: () => KIMI_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [
            process.env.MOONSHOT_API_KEY,
            process.env.KIMI_API_KEY,
            KIMI_API_KEY,
          ],
          'KIMI_API_KEY',
          opts,
        ),
      missingEnvVar: 'KIMI_API_KEY',
    },
    {
      id: 'minimax',
      prefix: 'minimax/',
      readBaseUrl: () => MINIMAX_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [process.env.MINIMAX_API_KEY, MINIMAX_API_KEY],
          'MINIMAX_API_KEY',
          opts,
        ),
      missingEnvVar: 'MINIMAX_API_KEY',
    },
    {
      id: 'dashscope',
      prefix: 'dashscope/',
      readBaseUrl: () => DASHSCOPE_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [process.env.DASHSCOPE_API_KEY, DASHSCOPE_API_KEY],
          'DASHSCOPE_API_KEY',
          opts,
        ),
      missingEnvVar: 'DASHSCOPE_API_KEY',
    },
    {
      id: 'xiaomi',
      prefix: 'xiaomi/',
      readBaseUrl: () => XIAOMI_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [process.env.XIAOMI_API_KEY, XIAOMI_API_KEY],
          'XIAOMI_API_KEY',
          opts,
        ),
      missingEnvVar: 'XIAOMI_API_KEY',
    },
    {
      id: 'kilo',
      prefix: 'kilo/',
      readBaseUrl: () => KILO_BASE_URL,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [
            process.env.KILOCODE_API_KEY,
            process.env.KILO_API_KEY,
            KILO_API_KEY,
          ],
          'KILO_API_KEY',
          opts,
        ),
      missingEnvVar: 'KILO_API_KEY',
    },
  ] as const;

const LEGACY_CUSTOM_PROVIDERS: ReadonlySet<OpenAICompatRemoteProviderId> =
  new Set(['openrouter', 'mistral', 'huggingface'] as const);

const PROVIDER_DEF_BY_ID: ReadonlyMap<
  OpenAICompatRemoteProviderId,
  OpenAICompatRemoteProviderDef
> = new Map(OPENAI_COMPAT_REMOTE_PROVIDERS.map((def) => [def.id, def]));

export function getOpenAICompatRemoteProviderDef(
  id: OpenAICompatRemoteProviderId,
): OpenAICompatRemoteProviderDef {
  const def = PROVIDER_DEF_BY_ID.get(id);
  if (!def) throw new Error(`No OpenAI-compat remote provider: ${id}`);
  return def;
}

export function readApiKeyForOpenAICompatProvider(
  id: OpenAICompatRemoteProviderId,
  opts?: { required?: boolean },
): string {
  return getOpenAICompatRemoteProviderDef(id).readApiKey(opts);
}

function buildProviderMap(): ReadonlyMap<
  OpenAICompatRemoteProviderId,
  AIProvider
> {
  const map = new Map<OpenAICompatRemoteProviderId, AIProvider>();
  for (const def of OPENAI_COMPAT_REMOTE_PROVIDERS) {
    if (LEGACY_CUSTOM_PROVIDERS.has(def.id)) continue;
    map.set(def.id, createOpenAICompatRemoteProvider(def));
  }
  return map;
}

const _providerMap = buildProviderMap();

function getProvider(id: OpenAICompatRemoteProviderId): AIProvider {
  const p = _providerMap.get(id);
  if (!p) {
    throw new Error(`Unknown OpenAI-compat remote provider: ${id}`);
  }
  return p;
}

export const geminiProvider: AIProvider = getProvider('gemini');
export const deepseekProvider: AIProvider = getProvider('deepseek');
export const xaiProvider: AIProvider = getProvider('xai');
export const zaiProvider: AIProvider = getProvider('zai');
export const kimiProvider: AIProvider = getProvider('kimi');
export const minimaxProvider: AIProvider = getProvider('minimax');
export const dashscopeProvider: AIProvider = getProvider('dashscope');
export const xiaomiProvider: AIProvider = getProvider('xiaomi');
export const kiloProvider: AIProvider = getProvider('kilo');
