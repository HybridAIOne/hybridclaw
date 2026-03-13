import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  MissingRequiredEnvVarError,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import { getDiscoveredOpenRouterModelContextWindow } from './openrouter-discovery.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

const OPENROUTER_MODEL_PREFIX = 'openrouter/';
const OPENROUTER_REFERER = 'https://github.com/hybridaione/hybridclaw';
const OPENROUTER_TITLE = 'HybridClaw';

export function isOpenRouterModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(OPENROUTER_MODEL_PREFIX);
}

function readOpenRouterApiKey(): string {
  refreshRuntimeSecretsFromEnv();
  const apiKey = process.env.OPENROUTER_API_KEY || OPENROUTER_API_KEY || '';
  const normalized = apiKey.trim();
  if (!normalized) {
    throw new MissingRequiredEnvVarError('OPENROUTER_API_KEY');
  }
  return normalized;
}

async function resolveOpenRouterRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  return {
    provider: 'openrouter',
    apiKey: readOpenRouterApiKey(),
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
