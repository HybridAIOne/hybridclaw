import { parsePositiveInteger } from './primitive-values.js';

export const DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS = 32_000;

export function isAnthropicProviderModel(model) {
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

export function resolveProviderRequestMaxTokens(params) {
  const discoveredMaxTokens = parsePositiveInteger(params.discoveredMaxTokens);

  if (!isAnthropicProviderModel(params.model)) {
    return undefined;
  }

  return discoveredMaxTokens ?? DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS;
}
