import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { OPENROUTER_BASE_URL } from '../config/config.js';
import { getDiscoveredOpenRouterModelContextWindow } from './openrouter-discovery.js';
import {
  OPENROUTER_MODEL_PREFIX,
  OPENROUTER_REFERER,
  OPENROUTER_TITLE,
  readOpenRouterApiKey,
} from './openrouter-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

export function isOpenRouterModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(OPENROUTER_MODEL_PREFIX);
}

async function resolveOpenRouterRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  return {
    provider: 'openrouter',
    apiKey: readOpenRouterApiKey({ required: true }),
    baseUrl: OPENROUTER_BASE_URL.trim().replace(/\/+$/g, ''),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {
      'HTTP-Referer': OPENROUTER_REFERER,
      'X-Title': OPENROUTER_TITLE,
    },
    agentId,
    isLocal: false,
    contextWindow:
      getDiscoveredOpenRouterModelContextWindow(params.model) ?? undefined,
  };
}

export const openrouterProvider: AIProvider = {
  id: 'openrouter',
  matchesModel: isOpenRouterModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveOpenRouterRuntimeCredentials,
};
