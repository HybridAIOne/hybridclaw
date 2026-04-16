import { DASHSCOPE_BASE_URL } from '../config/config.js';
import {
  DASHSCOPE_MODEL_PREFIX,
  readDashScopeApiKey,
} from './dashscope-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const isDashScopeModel = createModelMatcher(DASHSCOPE_MODEL_PREFIX);

async function resolveDashScopeRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'dashscope',
    apiKey: readDashScopeApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(DASHSCOPE_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const dashscopeProvider: AIProvider = {
  id: 'dashscope',
  matchesModel: isDashScopeModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveDashScopeRuntimeCredentials,
};
