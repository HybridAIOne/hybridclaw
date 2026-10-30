import {
  DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL,
  DASHSCOPE_ENABLED,
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_ENABLED,
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
  GEMINI_ENABLED,
  HUGGINGFACE_API_KEY,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_ENABLED,
  KILO_API_KEY,
  KILO_BASE_URL,
  KILO_ENABLED,
  KIMI_API_KEY,
  KIMI_BASE_URL,
  KIMI_ENABLED,
  MINIMAX_API_KEY,
  MINIMAX_BASE_URL,
  MINIMAX_ENABLED,
  MISTRAL_API_KEY,
  MISTRAL_BASE_URL,
  MISTRAL_ENABLED,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_ENABLED,
  XAI_API_KEY,
  XAI_BASE_URL,
  XAI_ENABLED,
  XIAOMI_API_KEY,
  XIAOMI_BASE_URL,
  XIAOMI_ENABLED,
  ZAI_API_KEY,
  ZAI_BASE_URL,
  ZAI_ENABLED,
} from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';
import {
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  type OpenAICompatRemoteProviderId,
  providerModelPrefix,
} from './provider-ids.js';
import { PROVIDER_META } from './provider-meta.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export interface OpenAICompatRemoteProviderDef {
  id: OpenAICompatRemoteProviderId;
  prefix: string;
  readEnabled: () => boolean;
  readBaseUrl: () => string;
  readApiKey: (opts?: { required?: boolean }) => string;
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
      model: params.model,
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
    resolveRuntimeCredentials,
  };
}

const CONFIG_READERS = {
  openrouter: {
    enabled: () => OPENROUTER_ENABLED,
    baseUrl: () => OPENROUTER_BASE_URL,
    apiKey: () => OPENROUTER_API_KEY,
  },
  mistral: {
    enabled: () => MISTRAL_ENABLED,
    baseUrl: () => MISTRAL_BASE_URL,
    apiKey: () => MISTRAL_API_KEY,
  },
  huggingface: {
    enabled: () => HUGGINGFACE_ENABLED,
    baseUrl: () => HUGGINGFACE_BASE_URL,
    apiKey: () => HUGGINGFACE_API_KEY,
  },
  gemini: {
    enabled: () => GEMINI_ENABLED,
    baseUrl: () => GEMINI_BASE_URL,
    apiKey: () => GEMINI_API_KEY,
  },
  deepseek: {
    enabled: () => DEEPSEEK_ENABLED,
    baseUrl: () => DEEPSEEK_BASE_URL,
    apiKey: () => DEEPSEEK_API_KEY,
  },
  xai: {
    enabled: () => XAI_ENABLED,
    baseUrl: () => XAI_BASE_URL,
    apiKey: () => XAI_API_KEY,
  },
  zai: {
    enabled: () => ZAI_ENABLED,
    baseUrl: () => ZAI_BASE_URL,
    apiKey: () => ZAI_API_KEY,
  },
  kimi: {
    enabled: () => KIMI_ENABLED,
    baseUrl: () => KIMI_BASE_URL,
    apiKey: () => KIMI_API_KEY,
  },
  minimax: {
    enabled: () => MINIMAX_ENABLED,
    baseUrl: () => MINIMAX_BASE_URL,
    apiKey: () => MINIMAX_API_KEY,
  },
  dashscope: {
    enabled: () => DASHSCOPE_ENABLED,
    baseUrl: () => DASHSCOPE_BASE_URL,
    apiKey: () => DASHSCOPE_API_KEY,
  },
  xiaomi: {
    enabled: () => XIAOMI_ENABLED,
    baseUrl: () => XIAOMI_BASE_URL,
    apiKey: () => XIAOMI_API_KEY,
  },
  kilo: {
    enabled: () => KILO_ENABLED,
    baseUrl: () => KILO_BASE_URL,
    apiKey: () => KILO_API_KEY,
  },
} satisfies Record<
  OpenAICompatRemoteProviderId,
  { enabled: () => boolean; baseUrl: () => string; apiKey: () => string }
>;

export const OPENAI_COMPAT_REMOTE_PROVIDERS: readonly OpenAICompatRemoteProviderDef[] =
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS.map((id) => {
    const { envVars, secretKey } = PROVIDER_META[id];
    const reader = CONFIG_READERS[id];
    return {
      id,
      prefix: providerModelPrefix(id),
      readEnabled: reader.enabled,
      readBaseUrl: reader.baseUrl,
      readApiKey: (opts) =>
        readProviderApiKey(
          () => [...envVars.map((name) => process.env[name]), reader.apiKey()],
          secretKey,
          opts,
        ),
    };
  });

export const LEGACY_CUSTOM_PROVIDERS: ReadonlySet<OpenAICompatRemoteProviderId> =
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

export function getOpenAICompatRemoteProvider(
  id: OpenAICompatRemoteProviderId,
): AIProvider {
  const p = _providerMap.get(id);
  if (!p) {
    throw new Error(`Unknown OpenAI-compat remote provider: ${id}`);
  }
  return p;
}
