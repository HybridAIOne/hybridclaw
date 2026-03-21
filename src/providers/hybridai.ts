import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL, HYBRIDAI_ENABLE_RAG } from '../config/config.js';
import { getDiscoveredHybridAIModelContextWindow } from './hybridai-discovery.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

function normalizeChatbotId(chatbotId: string | undefined): string {
  return String(chatbotId || '').trim();
}

async function resolveHybridAIRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const chatbotId = normalizeChatbotId(params.chatbotId);
  const agentId = normalizeChatbotId(params.agentId) || DEFAULT_AGENT_ID;
  const enableRag = params.enableRag ?? HYBRIDAI_ENABLE_RAG;
  return {
    provider: 'hybridai',
    apiKey: getHybridAIApiKey(),
    baseUrl: HYBRIDAI_BASE_URL,
    chatbotId,
    enableRag,
    requestHeaders: {},
    agentId,
    contextWindow:
      getDiscoveredHybridAIModelContextWindow(params.model) ?? undefined,
  };
}

export const hybridAIProvider: AIProvider = {
  id: 'hybridai',
  matchesModel: () => true,
  requiresChatbotId: () => true,
  resolveRuntimeCredentials: resolveHybridAIRuntimeCredentials,
};
