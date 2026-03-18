import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { resolveCodexCredentials } from '../auth/codex-auth.js';
import { CODEX_BASE_URL } from '../config/config.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

export const OPENAI_CODEX_MODEL_PREFIX = 'openai-codex/';

export function isOpenAICodexModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(OPENAI_CODEX_MODEL_PREFIX);
}

async function resolveOpenAIRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const codex = await resolveCodexCredentials();
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  return {
    provider: 'openai-codex',
    apiKey: codex.apiKey,
    baseUrl: (
      process.env.HYBRIDCLAW_CODEX_BASE_URL ||
      CODEX_BASE_URL ||
      codex.baseUrl
    )
      .trim()
      .replace(/\/+$/g, ''),
    chatbotId: '',
    enableRag: false,
    requestHeaders: { ...codex.headers },
    agentId,
    accountId: codex.accountId,
  };
}

export const openAIProvider: AIProvider = {
  id: 'openai-codex',
  matchesModel: isOpenAICodexModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveOpenAIRuntimeCredentials,
};
