import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { HUGGINGFACE_BASE_URL } from '../config/config.js';
import { getDiscoveredHuggingFaceModelContextWindow } from './huggingface-discovery.js';
import {
  HUGGINGFACE_MODEL_PREFIX,
  readHuggingFaceApiKey,
} from './huggingface-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';
import { normalizeBaseUrl } from './utils.js';

export function isHuggingFaceModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(HUGGINGFACE_MODEL_PREFIX);
}

async function resolveHuggingFaceRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const agentId = String(params.agentId || '').trim() || DEFAULT_AGENT_ID;
  return {
    provider: 'huggingface',
    apiKey: readHuggingFaceApiKey({ required: true }),
    baseUrl: normalizeBaseUrl(HUGGINGFACE_BASE_URL),
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId,
    isLocal: false,
    contextWindow:
      getDiscoveredHuggingFaceModelContextWindow(params.model) ?? undefined,
  };
}

export const huggingfaceProvider: AIProvider = {
  id: 'huggingface',
  matchesModel: isHuggingFaceModel,
  requiresChatbotId: () => false,
  resolveRuntimeCredentials: resolveHuggingFaceRuntimeCredentials,
};
