import { createModelMatcher } from './provider-utils.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

export const isAnthropicModel = createModelMatcher('anthropic/');

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
