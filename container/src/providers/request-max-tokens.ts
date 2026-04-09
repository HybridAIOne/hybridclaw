export const DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS = 32_000;

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function isAnthropicProviderModel(model: string): boolean {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('anthropic/')) return true;
  if (normalized.includes('/anthropic/')) return true;

  const slashTail = normalized.split('/').at(-1) ?? normalized;
  const colonTail = slashTail.split(':').at(0) ?? slashTail;
  return colonTail.startsWith('claude-');
}

export function resolveProviderRequestMaxTokens(params: {
  provider?: string;
  model: string;
  requestedMaxTokens?: number;
  discoveredMaxTokens?: number;
  isLocal?: boolean;
  localDefaultMaxTokens?: number;
}): number | undefined {
  const discoveredMaxTokens = normalizePositiveInteger(
    params.discoveredMaxTokens,
  );

  if (!isAnthropicProviderModel(params.model)) {
    return undefined;
  }

  return discoveredMaxTokens ?? DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS;
}
