/**
 * Token usage snapshot a worker reports with each reply. NOT the counter
 * validator or accumulators (`packages/shared/src/token-usage.ts`), which the
 * gateway applies to every reply on top of `ContainerOutputSchema`.
 */
import type { RuntimeProviderId } from './provider-ids.ts';

/**
 * Usage snapshots shared by workers and recovery readers. Only observed API
 * tokens are billable evidence; estimates and unfinished calls remain distinct.
 */
export interface TokenUsageCounters {
  modelCalls: number;
  /** Calls that resent a request after its previous call failed. */
  modelRetries: number;
  apiUsageAvailable: boolean;
  apiPromptTokens: number;
  apiCompletionTokens: number;
  /** Reported reasoning tokens already included in the completion count. */
  apiReasoningTokens?: number;
  apiTotalTokens: number;
  apiCacheUsageAvailable: boolean;
  apiCacheReadTokens: number;
  apiCacheWriteTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
  performanceSamples?: ModelCallPerformanceSample[];
}

export interface ModelCallUsage {
  provider?: RuntimeProviderId;
  model: string;
  task?: string;
  status: 'running' | 'success' | 'error';
  durationMs: number;
  usage: TokenUsageCounters;
  costUsd?: number;
}

export interface TokenUsageStats extends TokenUsageCounters {
  modelUsage?: ModelCallUsage[];
  costUsd?: number;
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
