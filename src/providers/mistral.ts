import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { MISTRAL_BASE_URL } from '../config/config.js';
import { MISTRAL_MODEL_PREFIX, readMistralApiKey } from './mistral-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export function isMistralModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(MISTRAL_MODEL_PREFIX);
}

async function resolveMistralRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  return {
    provider: 'mistral',
    apiKey: readMistralApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(MISTRAL_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
  };
}

export const mistralProvider: AIProvider = {
  id: 'mistral',
  matchesModel: isMistralModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveMistralRuntimeCredentials,
};
