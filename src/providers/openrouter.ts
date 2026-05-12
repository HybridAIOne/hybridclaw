import { OPENROUTER_BASE_URL } from '../config/config.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import {
  discoverOpenRouterModels,
  getDiscoveredOpenRouterModelContextWindow,
  getDiscoveredOpenRouterModelMaxTokens,
} from './openrouter-discovery.js';
import {
  buildOpenRouterAttributionHeaders,
  OPENROUTER_MODEL_PREFIX,
} from './openrouter-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isOpenRouterModel = createModelMatcher(OPENROUTER_MODEL_PREFIX);

async function resolveOpenRouterRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  await discoverOpenRouterModels();
  return {
    provider: 'openrouter',
    model: params.model,
    apiKey: readApiKeyForOpenAICompatProvider('openrouter', { required: true }),
    baseUrl: normalizeBaseUrl(OPENROUTER_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: buildOpenRouterAttributionHeaders(),
    agentId,
    isLocal: false,
    contextWindow:
      getDiscoveredOpenRouterModelContextWindow(params.model) ?? undefined,
    maxTokens: getDiscoveredOpenRouterModelMaxTokens(params.model) ?? undefined,
  };
}

export const openrouterProvider: AIProvider = {
  id: 'openrouter',
  matchesModel: isOpenRouterModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveOpenRouterRuntimeCredentials,
};
