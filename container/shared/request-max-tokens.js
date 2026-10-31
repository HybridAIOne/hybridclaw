/**
 * Request output budgets are separate from model context capacity. Provider
 * defaults serve ordinary calls; auxiliary tasks have bounded defaults and
 * never change the primary conversation's generation budget.
 */
import { parsePositiveInteger } from './primitive-values.js';

export const DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS = 32_000;
// Runtime default (Codex engineering decision, 2026-10-31): 8K supports image
// descriptions/OCR without reserving a provider's full 128K output allowance.
// Larger analyses use the existing auxiliaryModels.vision.maxTokens setting.
export const DEFAULT_VISION_MAX_TOKENS = 8_192;
// Runtime default (Codex engineering decision, 2026-10-31): reasoning and
// visible summary text share one generation allowance. Summary length has
// its own prompt target; auxiliaryModels.compression.maxTokens overrides this.
export const DEFAULT_COMPRESSION_MAX_TOKENS = 8_192;

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
