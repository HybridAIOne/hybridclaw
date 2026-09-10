/**
 * Local compatible adapters preserve the selected backend and its limits.
 * Managed MLX requires authenticated discovery on literal loopback; it cannot
 * use generic fallback credentials or fabricate a context window while offline.
 * A missing MLX entry triggers fresh discovery, including after local startup.
 */
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  LOCAL_DEFAULT_CONTEXT_WINDOW,
  LOCAL_LLAMACPP_BASE_URL,
  LOCAL_LLAMACPP_MODEL_BEHAVIOR,
  LOCAL_LMSTUDIO_BASE_URL,
  LOCAL_LMSTUDIO_MODEL_BEHAVIOR,
  LOCAL_VLLM_API_KEY,
  LOCAL_VLLM_BASE_URL,
  LOCAL_VLLM_MODEL_BEHAVIOR,
} from '../config/config.js';
import { assertMlxEndpoint } from '../inference/mlx-endpoint.js';
import {
  normalizeModelBehavior,
  resolveModelBehavior,
} from '../types/model-behavior.js';
import {
  discoverAllLocalModels,
  getLocalModelInfo,
  resolveLocalModelBehavior,
  resolveLocalModelThinkingFormat,
} from './local-discovery.js';
import { resolveLocalEndpointForModel } from './local-endpoints.js';
import type { LocalBackendType, LocalModelBehavior } from './local-types.js';
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
  endpointName?: string;
  modelBehavior?: LocalModelBehavior;
} {
  const trimmed = String(model || '').trim();
  const endpoint = resolveLocalEndpointForModel(trimmed, backend);
  if (endpoint) {
    return {
      modelId: endpoint.modelId,
      baseUrl: endpoint.endpoint.baseUrl,
      apiKey: endpoint.endpoint.apiKey || '',
      endpointName: endpoint.endpoint.name,
      modelBehavior: endpoint.endpoint.modelBehavior,
    };
  }
  const prefix = `${backend}/`;
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    return { modelId: trimmed };
  }
  return { modelId: trimmed.slice(prefix.length) || trimmed };
}

function createLocalOpenAICompatProvider(params: {
  backend: Extract<LocalBackendType, 'llamacpp' | 'lmstudio' | 'vllm' | 'mlx'>;
  baseUrl: () => string;
  apiKey?: () => string;
  modelBehavior?: () => LocalModelBehavior | undefined;
}): AIProvider {
  const {
    backend,
    baseUrl,
    apiKey,
    modelBehavior: backendModelBehavior,
  } = params;
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
      if (backend === 'mlx') {
        if (!resolvedModel.endpointName || !resolvedModel.apiKey) {
          throw new Error(
            'MLX requires an authenticated named endpoint. Run hybridclaw local setup.',
          );
        }
        assertMlxEndpoint(resolvedModel.baseUrl || '');
      }
      const normalizedModel = resolvedModel.modelId;
      let modelInfo =
        getLocalModelInfo(runtimeParams.model) ||
        (backend === 'mlx' ? null : getLocalModelInfo(normalizedModel));
      if (!modelInfo && resolvedModel.endpointName) {
        // An empty cached result can predate startup. MLX requires the exact
        // named endpoint's live limits before the first inference request.
        await discoverAllLocalModels(
          backend === 'mlx' ? { force: true } : undefined,
        );
        modelInfo =
          getLocalModelInfo(runtimeParams.model) ||
          (backend === 'mlx' ? null : getLocalModelInfo(normalizedModel));
      }
      if (backend === 'mlx') {
        modelInfo = getLocalModelInfo(runtimeParams.model);
        if (modelInfo?.backend !== 'mlx')
          throw new Error(
            'The selected MLX model is unavailable. Start the local model first.',
          );
      }
      const configuredBehavior = normalizeModelBehavior(
        resolvedModel.modelBehavior ||
          modelInfo?.modelBehavior ||
          resolveLocalModelBehavior(runtimeParams.model) ||
          resolveLocalModelBehavior(normalizedModel) ||
          backendModelBehavior?.(),
      );
      const thinkingFormat =
        configuredBehavior?.thinkingFormat ||
        modelInfo?.thinkingFormat ||
        resolveLocalModelThinkingFormat(runtimeParams.model) ||
        resolveLocalModelThinkingFormat(normalizedModel) ||
        undefined;
      const resolvedBehavior = resolveModelBehavior({
        model: normalizedModel,
        configured: {
          ...(configuredBehavior || {}),
          ...(thinkingFormat ? { thinkingFormat } : {}),
        },
      });
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
        ...(backend === 'mlx' ? { maxTokens: modelInfo?.maxTokens } : {}),
        thinkingFormat: resolvedBehavior?.thinkingFormat,
        modelBehavior: resolvedBehavior,
      };
    },
  };
}

export const lmstudioProvider = createLocalOpenAICompatProvider({
  backend: 'lmstudio',
  baseUrl: () => LOCAL_LMSTUDIO_BASE_URL,
  modelBehavior: () => LOCAL_LMSTUDIO_MODEL_BEHAVIOR,
});

export const llamacppProvider = createLocalOpenAICompatProvider({
  backend: 'llamacpp',
  baseUrl: () => LOCAL_LLAMACPP_BASE_URL,
  modelBehavior: () => LOCAL_LLAMACPP_MODEL_BEHAVIOR,
});

export const vllmProvider = createLocalOpenAICompatProvider({
  backend: 'vllm',
  baseUrl: () => LOCAL_VLLM_BASE_URL,
  apiKey: () => LOCAL_VLLM_API_KEY,
  modelBehavior: () => LOCAL_VLLM_MODEL_BEHAVIOR,
});

export const mlxProvider = createLocalOpenAICompatProvider({
  backend: 'mlx',
  baseUrl: () => {
    throw new Error('Configure a named MLX endpoint.');
  },
});
