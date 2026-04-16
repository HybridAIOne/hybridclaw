import { MINIMAX_BASE_URL } from '../config/config.js';
import { MINIMAX_MODEL_PREFIX, readMiniMaxApiKey } from './minimax-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isMiniMaxModel = createModelMatcher(MINIMAX_MODEL_PREFIX);

async function resolveMiniMaxRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'minimax',
    apiKey: readMiniMaxApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(MINIMAX_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const minimaxProvider: AIProvider = {
  id: 'minimax',
  matchesModel: isMiniMaxModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveMiniMaxRuntimeCredentials,
};
