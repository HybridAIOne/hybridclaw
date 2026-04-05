import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { resolveAnthropicAuth } from '../auth/anthropic-auth.js';
import { ANTHROPIC_BASE_URL } from '../config/config.js';
import {
  isAnthropicModel,
  normalizeAnthropicBaseUrl,
} from './anthropic-utils.js';
import { resolveModelContextWindowFallback } from './hybridai-models.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

async function resolveAnthropicRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const auth = resolveAnthropicAuth();
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  return {
    provider: 'anthropic',
    apiKey: auth.apiKey,
    baseUrl: normalizeAnthropicBaseUrl(ANTHROPIC_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: auth.headers,
    agentId,
    isLocal: false,
    contextWindow: resolveModelContextWindowFallback(params.model) ?? undefined,
  };
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',
  matchesModel: isAnthropicModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveAnthropicRuntimeCredentials,
};
