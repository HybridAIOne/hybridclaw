/**
 * Usage snapshots shared by workers and recovery readers. Only observed API
 * tokens are billable evidence; estimates and unfinished calls remain distinct.
 */
export interface TokenUsageStats {
  modelCalls: number;
  apiUsageAvailable: boolean;
  apiPromptTokens: number;
  apiCompletionTokens: number;
  apiTotalTokens: number;
  apiCacheUsageAvailable: boolean;
  apiCacheReadTokens: number;
  apiCacheWriteTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
  performanceSamples?: ModelCallPerformanceSample[];
}

export interface ModelCallTiming {
  durationMs: number;
  firstTextDeltaMs?: number;
}

export interface ModelCallPerformanceSample extends ModelCallTiming {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function createTokenUsageStats(): TokenUsageStats;
export function finalizeTokenUsage(stats: TokenUsageStats): TokenUsageStats;
export function validateTokenUsage(value: unknown): TokenUsageStats;
