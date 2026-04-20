import { HUGGINGFACE_BASE_URL } from '../config/config.js';
import { getDiscoveredHuggingFaceModelContextWindow } from './huggingface-discovery.js';
import { HUGGINGFACE_MODEL_PREFIX } from './huggingface-utils.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isHuggingFaceModel = createModelMatcher(HUGGINGFACE_MODEL_PREFIX);

async function resolveHuggingFaceRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'huggingface',
    apiKey: readApiKeyForOpenAICompatProvider('huggingface', {
      required: true,
    }),
    baseUrl: normalizeBaseUrl(HUGGINGFACE_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
    contextWindow:
      getDiscoveredHuggingFaceModelContextWindow(params.model) ?? undefined,
  };
}

export const huggingfaceProvider: AIProvider = {
  id: 'huggingface',
  matchesModel: isHuggingFaceModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveHuggingFaceRuntimeCredentials,
};
