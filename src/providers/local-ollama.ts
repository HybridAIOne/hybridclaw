import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  LOCAL_DEFAULT_CONTEXT_WINDOW,
  LOCAL_OLLAMA_BASE_URL,
} from '../config/config.js';
import {
  getLocalModelInfo,
  resolveLocalModelThinkingFormat,
  resolveOllamaApiBase,
} from './local-discovery.js';
import { stripProviderPrefix } from './model-names.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

const OLLAMA_MODEL_PREFIX = 'ollama/';

function normalizeOllamaModelName(model: string): string {
  return stripProviderPrefix(model, 'ollama');
}

async function resolveOllamaRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const modelName = normalizeOllamaModelName(params.model);
  const modelInfo =
    getLocalModelInfo(params.model) || getLocalModelInfo(modelName);
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  return {
    provider: 'ollama',
    apiKey: '',
    baseUrl: resolveOllamaApiBase(LOCAL_OLLAMA_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: true,
    contextWindow: modelInfo?.contextWindow ?? LOCAL_DEFAULT_CONTEXT_WINDOW,
    thinkingFormat:
      modelInfo?.thinkingFormat ||
      resolveLocalModelThinkingFormat(params.model) ||
      resolveLocalModelThinkingFormat(modelName) ||
      undefined,
  };
}

export const ollamaProvider: AIProvider = {
  id: 'ollama',
  matchesModel(model: string): boolean {
    const normalized = String(model || '').trim();
    if (!normalized) return false;
    if (normalized.toLowerCase().startsWith(OLLAMA_MODEL_PREFIX)) return true;
    return getLocalModelInfo(normalized)?.backend === 'ollama';
  },
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveOllamaRuntimeCredentials,
};
