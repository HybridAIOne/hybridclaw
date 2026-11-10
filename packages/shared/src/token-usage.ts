/**
 * Canonical usage snapshots for live workers and durable recovery. Validation
 * rejects corrupt counters; it never estimates missing provider charges. The
 * snapshot shape is wire data (`@hybridclaw/contracts/token-usage`).
 */
import type {
  ModelCallPerformanceSample,
  TokenUsageStats,
} from '@hybridclaw/contracts/token-usage';
import { isRecord } from './primitive-values.ts';

export function createTokenUsageStats(): TokenUsageStats {
  return {
    modelCalls: 0,
    apiUsageAvailable: false,
    apiPromptTokens: 0,
    apiCompletionTokens: 0,
    apiTotalTokens: 0,
    apiCacheUsageAvailable: false,
    apiCacheReadTokens: 0,
    apiCacheWriteTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
    performanceSamples: [],
  };
}

export function finalizeTokenUsage(stats: TokenUsageStats): TokenUsageStats {
  const estimatedTotalTokens =
    stats.estimatedPromptTokens + stats.estimatedCompletionTokens;
  let apiTotalTokens = stats.apiTotalTokens;
  if (stats.apiUsageAvailable && apiTotalTokens === 0) {
    apiTotalTokens = stats.apiPromptTokens + stats.apiCompletionTokens;
  }

  return {
    ...stats,
    apiTotalTokens,
    estimatedTotalTokens,
  };
}

export function validateTokenUsage(value: unknown): TokenUsageStats {
  if (!isRecord(value)) throw new Error('Invalid checkpoint usage.');
  const result = createTokenUsageStats();
  for (const [key, initial] of Object.entries(result)) {
    if (key === 'performanceSamples') continue;
    const actual = value[key];
    if (
      typeof initial === 'boolean'
        ? typeof actual !== 'boolean'
        : !Number.isSafeInteger(actual) || (actual as number) < 0
    )
      throw new Error('Invalid checkpoint usage.');
    (result as unknown as Record<string, unknown>)[key] = actual;
  }
  if (value.performanceSamples !== undefined) {
    if (!Array.isArray(value.performanceSamples))
      throw new Error('Invalid checkpoint performance samples.');
    result.performanceSamples = value.performanceSamples.map(
      (sample: unknown): ModelCallPerformanceSample => {
        if (!isRecord(sample))
          throw new Error('Invalid checkpoint performance sample.');
        const copy: Record<string, number> = {};
        for (const key of [
          'promptTokens',
          'completionTokens',
          'totalTokens',
          'durationMs',
          'firstTextDeltaMs',
        ]) {
          const actual = sample[key] as number;
          if (key === 'firstTextDeltaMs' && actual === undefined) continue;
          if (!Number.isSafeInteger(actual) || actual < 0)
            throw new Error('Invalid checkpoint performance sample.');
          copy[key] = actual;
        }
        return copy as unknown as ModelCallPerformanceSample;
      },
    );
  }
  const finalized = finalizeTokenUsage(result);
  if (
    !Number.isSafeInteger(finalized.apiTotalTokens) ||
    !Number.isSafeInteger(finalized.estimatedTotalTokens)
  )
    throw new Error('Invalid checkpoint usage totals.');
  return finalized;
}
