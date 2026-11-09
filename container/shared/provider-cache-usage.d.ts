/** Normalized reported cache counters; missing fields remain unknown. */
export interface ProviderCacheUsage {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function readProviderCacheUsage(value: unknown): ProviderCacheUsage;
