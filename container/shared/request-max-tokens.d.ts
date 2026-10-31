export const DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS: number;
export const DEFAULT_VISION_MAX_TOKENS: number;
export const DEFAULT_COMPRESSION_MAX_TOKENS: number;
export function isAnthropicProviderModel(model: string): boolean;
export function resolveProviderRequestMaxTokens(params: {
  model: string;
  discoveredMaxTokens?: number;
}): number | undefined;
