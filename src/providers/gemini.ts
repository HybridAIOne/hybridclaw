import { GEMINI_BASE_URL } from '../config/config.js';
import { GEMINI_MODEL_PREFIX, readGeminiApiKey } from './gemini-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isGeminiModel = createModelMatcher(GEMINI_MODEL_PREFIX);

async function resolveGeminiRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'gemini',
    apiKey: readGeminiApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(GEMINI_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const geminiProvider: AIProvider = {
  id: 'gemini',
  matchesModel: isGeminiModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveGeminiRuntimeCredentials,
};
