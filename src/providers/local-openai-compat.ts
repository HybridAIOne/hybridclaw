import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  LOCAL_DEFAULT_CONTEXT_WINDOW,
  LOCAL_LLAMACPP_BASE_URL,
  LOCAL_LMSTUDIO_BASE_URL,
  LOCAL_VLLM_API_KEY,
  LOCAL_VLLM_BASE_URL,
} from '../config/config.js';
import {
  getLocalModelInfo,
  resolveLocalModelThinkingFormat,
} from './local-discovery.js';
import type { LocalBackendType } from './local-types.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

function normalizePrefixedModelName(
  model: string,
  backend: LocalBackendType,
): string {
  const trimmed = String(model || '').trim();
  const prefix = `${backend}/`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  return trimmed.slice(prefix.length) || trimmed;
}

function createLocalOpenAICompatProvider(params: {
  backend: Extract<LocalBackendType, 'llamacpp' | 'lmstudio' | 'vllm'>;
  baseUrl: () => string;
  apiKey?: () => string;
}): AIProvider {
  const { backend, baseUrl, apiKey } = params;
  return {
    id: backend,
    matchesModel(model: string): boolean {
      const normalized = String(model || '').trim();
      if (!normalized) return false;
      if (normalized.toLowerCase().startsWith(`${backend}/`)) return true;
      return getLocalModelInfo(normalized)?.backend === backend;
    },
    requiresChatbotId: () => false,
    async resolveRuntimeCredentials(
      runtimeParams: ResolveProviderRuntimeParams,
    ): Promise<ResolvedModelRuntimeCredentials> {
      const normalizedModel = normalizePrefixedModelName(
        runtimeParams.model,
        backend,
      );
      const modelInfo =
        getLocalModelInfo(runtimeParams.model) ||
        getLocalModelInfo(normalizedModel);
      const agentId =
        String(runtimeParams.agentId || '').trim() || DEFAULT_AGENT_ID;
      return {
        provider: backend,
        apiKey: apiKey?.() || '',
        baseUrl: baseUrl().trim().replace(/\/+$/g, ''),
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId,
        isLocal: true,
        contextWindow: modelInfo?.contextWindow ?? LOCAL_DEFAULT_CONTEXT_WINDOW,
        thinkingFormat:
          modelInfo?.thinkingFormat ||
          resolveLocalModelThinkingFormat(runtimeParams.model) ||
          resolveLocalModelThinkingFormat(normalizedModel) ||
          undefined,
      };
    },
  };
}

export const lmstudioProvider = createLocalOpenAICompatProvider({
  backend: 'lmstudio',
  baseUrl: () => LOCAL_LMSTUDIO_BASE_URL,
});

export const llamacppProvider = createLocalOpenAICompatProvider({
  backend: 'llamacpp',
  baseUrl: () => LOCAL_LLAMACPP_BASE_URL,
});

export const vllmProvider = createLocalOpenAICompatProvider({
  backend: 'vllm',
  baseUrl: () => LOCAL_VLLM_BASE_URL,
  apiKey: () => LOCAL_VLLM_API_KEY,
});
