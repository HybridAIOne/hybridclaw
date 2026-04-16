import { KILO_BASE_URL } from '../config/config.js';
import { KILO_MODEL_PREFIX, readKiloApiKey } from './kilo-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isKiloModel = createModelMatcher(KILO_MODEL_PREFIX);

async function resolveKiloRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'kilo',
    apiKey: readKiloApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(KILO_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const kiloProvider: AIProvider = {
  id: 'kilo',
  matchesModel: isKiloModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveKiloRuntimeCredentials,
};
