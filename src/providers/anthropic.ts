import type {
  AIProvider,
  ResolveProviderRuntimeParams,
  ResolvedModelRuntimeCredentials,
} from './types.js';

const ANTHROPIC_MODEL_PREFIX = 'anthropic/';

export function isAnthropicModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(ANTHROPIC_MODEL_PREFIX);
}

function resolveAnthropicAgentId(_model: string, chatbotId: string): string {
  const trimmedChatbotId = String(chatbotId || '').trim();
  return trimmedChatbotId || 'anthropic';
}

async function resolveAnthropicRuntimeCredentials(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  throw new Error(
    `Anthropic provider is not implemented yet for model "${params.model}".`,
  );
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',
  matchesModel: isAnthropicModel,
  requiresChatbotId: () => false,
  resolveAgentId: resolveAnthropicAgentId,
  resolveRuntimeCredentials: resolveAnthropicRuntimeCredentials,
};
