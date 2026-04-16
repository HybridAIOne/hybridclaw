import { XAI_BASE_URL } from '../config/config.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';
import { readXaiApiKey, XAI_MODEL_PREFIX } from './xai-utils.js';

export const isXaiModel = createModelMatcher(XAI_MODEL_PREFIX);

async function resolveXaiRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'xai',
    apiKey: readXaiApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(XAI_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const xaiProvider: AIProvider = {
  id: 'xai',
  matchesModel: isXaiModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveXaiRuntimeCredentials,
};
