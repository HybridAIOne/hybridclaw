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
import { resolveLocalEndpointForModel } from './local-endpoints.js';
import type { LocalBackendType } from './local-types.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

function resolveLocalRuntimeModel(
  model: string,
  backend: LocalBackendType,
): {
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
} {
  const trimmed = String(model || '').trim();
  const endpoint = resolveLocalEndpointForModel(trimmed, backend);
  if (endpoint) {
    return {
      modelId: endpoint.modelId,
      baseUrl: endpoint.endpoint.baseUrl,
      apiKey: endpoint.endpoint.apiKey || '',
    };
  }
  const prefix = `${backend}/`;
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    return { modelId: trimmed };
  }
  return { modelId: trimmed.slice(prefix.length) || trimmed };
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
      if (resolveLocalEndpointForModel(normalized, backend)) return true;
      return getLocalModelInfo(normalized)?.backend === backend;
    },
    requiresChatbotId: () => false,
    async resolveRuntimeCredentials(
      runtimeParams: ResolveProviderRuntimeParams,
    ): Promise<ResolvedModelRuntimeCredentials> {
      const resolvedModel = resolveLocalRuntimeModel(
        runtimeParams.model,
        backend,
      );
      const normalizedModel = resolvedModel.modelId;
      const modelInfo =
        getLocalModelInfo(runtimeParams.model) ||
        getLocalModelInfo(normalizedModel);
      const agentId =
        String(runtimeParams.agentId || '').trim() || DEFAULT_AGENT_ID;
      return {
        provider: backend,
        model: `${backend}/${normalizedModel}`,
        apiKey: resolvedModel.apiKey ?? apiKey?.() ?? '',
        baseUrl: (resolvedModel.baseUrl ?? baseUrl())
          .trim()
          .replace(/\/+$/g, ''),
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
