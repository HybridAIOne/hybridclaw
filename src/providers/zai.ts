import { ZAI_BASE_URL } from '../config/config.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';
import { readZaiApiKey, ZAI_MODEL_PREFIX } from './zai-utils.js';

export const isZaiModel = createModelMatcher(ZAI_MODEL_PREFIX);

async function resolveZaiRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'zai',
    apiKey: readZaiApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(ZAI_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const zaiProvider: AIProvider = {
  id: 'zai',
  matchesModel: isZaiModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveZaiRuntimeCredentials,
};
