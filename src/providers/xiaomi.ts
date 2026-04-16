import { XIAOMI_BASE_URL } from '../config/config.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';
import { readXiaomiApiKey, XIAOMI_MODEL_PREFIX } from './xiaomi-utils.js';

export const isXiaomiModel = createModelMatcher(XIAOMI_MODEL_PREFIX);

async function resolveXiaomiRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'xiaomi',
    apiKey: readXiaomiApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(XIAOMI_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const xiaomiProvider: AIProvider = {
  id: 'xiaomi',
  matchesModel: isXiaomiModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveXiaomiRuntimeCredentials,
};
