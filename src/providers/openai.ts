import { CODEX_BASE_URL } from '../config/config.js';
import { resolveCodexCredentials } from '../auth/codex-auth.js';
import type {
  AIProvider,
  ResolveProviderRuntimeParams,
  ResolvedModelRuntimeCredentials,
} from './types.js';

const OPENAI_CODEX_MODEL_PREFIX = 'openai-codex/';

export function isOpenAICodexModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(OPENAI_CODEX_MODEL_PREFIX);
}

function resolveOpenAIAgentId(_model: string, chatbotId: string): string {
  const trimmedChatbotId = String(chatbotId || '').trim();
  return trimmedChatbotId || 'openai-codex';
}

async function resolveOpenAIRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const codex = await resolveCodexCredentials();
  return {
    provider: 'openai-codex',
    apiKey: codex.apiKey,
    baseUrl: (process.env.HYBRIDCLAW_CODEX_BASE_URL || CODEX_BASE_URL || codex.baseUrl)
      .trim()
      .replace(/\/+$/g, ''),
    chatbotId: '',
    enableRag: false,
    requestHeaders: { ...codex.headers },
    agentId: resolveOpenAIAgentId(params.model, String(params.chatbotId || '')),
    accountId: codex.accountId,
  };
}

export const openAIProvider: AIProvider = {
  id: 'openai-codex',
  matchesModel: isOpenAICodexModel,
  requiresChatbotId: () => false,
  resolveAgentId: resolveOpenAIAgentId,
  resolveRuntimeCredentials: resolveOpenAIRuntimeCredentials,
};
