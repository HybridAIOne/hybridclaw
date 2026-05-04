import { resolveCodexCredentials } from '../auth/codex-auth.js';
import { CODEX_BASE_URL } from '../config/config.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

export const OPENAI_CODEX_MODEL_PREFIX = 'openai-codex/';

export const isOpenAICodexModel = createModelMatcher(OPENAI_CODEX_MODEL_PREFIX);

async function resolveOpenAIRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const codex = await resolveCodexCredentials();
  const agentId = normalizeAgentId(params.agentId);
  return {
    provider: 'openai-codex',
    model: params.model,
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
