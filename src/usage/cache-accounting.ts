/**
 * Native Anthropic usage reports `input_tokens` as the uncached remainder,
 * with cache reads and writes counted separately. OpenAI-style providers
 * (including OpenRouter and HybridAI relays) fold cached tokens into
 * `prompt_tokens`. Persisted usage rows always use the inclusive form so
 * cache hit rates and uncached shares can be derived uniformly.
 */
export function promptTokensIncludeCacheTokens(model: string): boolean {
  return !model.trim().toLowerCase().startsWith('anthropic/');
}

export interface CacheAwareTokenCounts {
  model: string;
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export function toInclusiveInputTokens<T extends CacheAwareTokenCounts>(
  counts: T,
): T {
  if (promptTokensIncludeCacheTokens(counts.model)) return counts;
  const cacheTokens =
    Math.max(0, counts.cacheReadTokens ?? 0) +
    Math.max(0, counts.cacheWriteTokens ?? 0);
  if (cacheTokens === 0) return counts;
  return { ...counts, inputTokens: counts.inputTokens + cacheTokens };
}

export function cacheHitRatio(
  inputTokens: number,
  cacheReadTokens: number,
): number | null {
  if (!(inputTokens > 0) || !(cacheReadTokens > 0)) return null;
  return Math.min(1, cacheReadTokens / inputTokens);
}
