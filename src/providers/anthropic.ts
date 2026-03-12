import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

const ANTHROPIC_MODEL_PREFIX = 'anthropic/';

export function isAnthropicModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(ANTHROPIC_MODEL_PREFIX);
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
  resolveRuntimeCredentials: resolveAnthropicRuntimeCredentials,
};
