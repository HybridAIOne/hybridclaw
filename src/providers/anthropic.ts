import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  requireAnthropicApiKey,
  requireAnthropicClaudeCliCredential,
} from '../auth/anthropic-auth.js';
import { ANTHROPIC_BASE_URL, ANTHROPIC_METHOD } from '../config/config.js';
import {
  discoverAnthropicModels,
  getDiscoveredAnthropicModelContextWindow,
  getDiscoveredAnthropicModelMaxTokens,
} from './anthropic-discovery.js';
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
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  await discoverAnthropicModels();
  if (ANTHROPIC_METHOD === 'claude-cli') {
    requireAnthropicClaudeCliCredential();
    return {
      provider: 'anthropic',
      providerMethod: 'claude-cli',
      model: params.model,
      apiKey: '',
      baseUrl: normalizeAnthropicBaseUrl(ANTHROPIC_BASE_URL),
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId,
      isLocal: false,
      contextWindow:
        getDiscoveredAnthropicModelContextWindow(params.model) ??
        resolveModelContextWindowFallback(params.model) ??
        undefined,
      maxTokens:
        getDiscoveredAnthropicModelMaxTokens(params.model) ?? undefined,
    };
  }

  const auth = requireAnthropicApiKey();
  return {
    provider: 'anthropic',
    providerMethod: 'api-key',
    model: params.model,
    apiKey: auth.apiKey,
    baseUrl: normalizeAnthropicBaseUrl(ANTHROPIC_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: auth.headers,
    agentId,
    isLocal: false,
    contextWindow:
      getDiscoveredAnthropicModelContextWindow(params.model) ??
      resolveModelContextWindowFallback(params.model) ??
      undefined,
    maxTokens: getDiscoveredAnthropicModelMaxTokens(params.model) ?? undefined,
  };
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',
  matchesModel: isAnthropicModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveAnthropicRuntimeCredentials,
};
