import {
  DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL,
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
  KILO_API_KEY,
  KILO_BASE_URL,
  KIMI_API_KEY,
  KIMI_BASE_URL,
  MINIMAX_API_KEY,
  MINIMAX_BASE_URL,
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

// ---------------------------------------------------------------------------
// Provider definition type
// ---------------------------------------------------------------------------

export interface OpenAICompatRemoteProviderDef {
  /** Provider identifier (e.g. 'gemini'). */
  id: RuntimeProviderId;
  /** Model-string prefix used for matching (e.g. 'gemini/'). */
  prefix: string;
  /** Returns the base URL from the config module. */
  readBaseUrl: () => string;
  /** Reads the API key, checking process.env then the config fallback. */
  readApiKey: (opts?: { required?: boolean }) => string;
  /** Primary env var name shown in error messages. */
  missingEnvVar: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registry of all 9 OpenAI-compatible remote providers
// ---------------------------------------------------------------------------

export const OPENAI_COMPAT_REMOTE_PROVIDERS: readonly OpenAICompatRemoteProviderDef[] =
  [
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
          // Moonshot AI (which runs the Kimi API) documents `MOONSHOT_API_KEY`
          // as the conventional env var. Accept both.
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

// ---------------------------------------------------------------------------
// Individual provider instances (backward compatibility with factory.ts)
// ---------------------------------------------------------------------------

function buildProviderMap(): ReadonlyMap<RuntimeProviderId, AIProvider> {
  const map = new Map<RuntimeProviderId, AIProvider>();
  for (const def of OPENAI_COMPAT_REMOTE_PROVIDERS) {
    map.set(def.id, createOpenAICompatRemoteProvider(def));
  }
  return map;
}

const _providerMap = buildProviderMap();

function getProvider(id: RuntimeProviderId): AIProvider {
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
