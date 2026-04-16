import { DEEPSEEK_BASE_URL } from '../config/config.js';
import { DEEPSEEK_MODEL_PREFIX, readDeepSeekApiKey } from './deepseek-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isDeepSeekModel = createModelMatcher(DEEPSEEK_MODEL_PREFIX);

async function resolveDeepSeekRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'deepseek',
    apiKey: readDeepSeekApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(DEEPSEEK_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const deepseekProvider: AIProvider = {
  id: 'deepseek',
  matchesModel: isDeepSeekModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveDeepSeekRuntimeCredentials,
};
