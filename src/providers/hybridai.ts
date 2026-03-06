import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import {
  HYBRIDAI_BASE_URL,
  HYBRIDAI_ENABLE_RAG,
} from '../config/config.js';
import type {
  AIProvider,
  ResolveProviderRuntimeParams,
  ResolvedModelRuntimeCredentials,
} from './types.js';

function normalizeChatbotId(chatbotId: string | undefined): string {
  return String(chatbotId || '').trim();
}

function resolveHybridAIAgentId(
  _model: string,
  chatbotId: string,
): string {
  const trimmedChatbotId = normalizeChatbotId(chatbotId);
  return trimmedChatbotId || 'default';
}

async function resolveHybridAIRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const chatbotId = normalizeChatbotId(params.chatbotId);
  const enableRag = params.enableRag ?? HYBRIDAI_ENABLE_RAG;
  return {
    provider: 'hybridai',
    apiKey: getHybridAIApiKey(),
    baseUrl: HYBRIDAI_BASE_URL,
    chatbotId,
    enableRag,
    requestHeaders: {},
    agentId: resolveHybridAIAgentId(params.model, chatbotId),
  };
}

export const hybridAIProvider: AIProvider = {
  id: 'hybridai',
  matchesModel: () => true,
  requiresChatbotId: () => true,
  resolveAgentId: resolveHybridAIAgentId,
  resolveRuntimeCredentials: resolveHybridAIRuntimeCredentials,
};
