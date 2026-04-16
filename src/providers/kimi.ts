import { KIMI_BASE_URL } from '../config/config.js';
import { KIMI_MODEL_PREFIX, readKimiApiKey } from './kimi-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isKimiModel = createModelMatcher(KIMI_MODEL_PREFIX);

async function resolveKimiRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'kimi',
    apiKey: readKimiApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(KIMI_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const kimiProvider: AIProvider = {
  id: 'kimi',
  matchesModel: isKimiModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveKimiRuntimeCredentials,
};
