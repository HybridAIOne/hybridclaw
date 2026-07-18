import { resolveCodexCredentials } from '../auth/codex-auth.js';
import {
  CODEX_BASE_URL,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
} from '../config/config.js';
import { resolveStaticModelCatalogMetadata } from './model-metadata.js';
import { readProviderApiKey } from './provider-api-key-utils.js';
import { createModelMatcher, normalizeAgentId } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export const OPENAI_MODEL_PREFIX = 'openai/';
export const OPENAI_CODEX_MODEL_PREFIX = 'openai-codex/';

export const isOpenAIModel = createModelMatcher(OPENAI_MODEL_PREFIX);
export const isOpenAICodexModel = createModelMatcher(OPENAI_CODEX_MODEL_PREFIX);

export function readOpenAIAPIKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.OPENAI_API_KEY, OPENAI_API_KEY],
    'OPENAI_API_KEY',
    opts,
  );
}

async function resolveOpenAIAPIRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const metadata = resolveStaticModelCatalogMetadata(params.model);
  return {
    provider: 'openai',
    providerMethod: 'api-key',
    model: params.model,
    apiKey: readOpenAIAPIKey({ required: true }),
    baseUrl: normalizeBaseUrl(OPENAI_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: normalizeAgentId(params.agentId),
    isLocal: false,
    contextWindow: metadata.contextWindow ?? undefined,
    maxTokens: metadata.maxTokens ?? undefined,
  };
}

export const openAIAPIProvider: AIProvider = {
  id: 'openai',
  matchesModel: isOpenAIModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveOpenAIAPIRuntimeCredentials,
};

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
