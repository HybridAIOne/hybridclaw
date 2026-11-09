/**
 * Usage snapshots shared by workers and recovery readers. Only observed API
 * tokens are billable evidence; estimates and unfinished calls remain distinct.
 */
import type { RuntimeProviderId } from './provider-ids.js';

export interface TokenUsageCounters {
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

export function createTokenUsageStats(): TokenUsageStats;
export function finalizeTokenUsage(stats: TokenUsageStats): TokenUsageStats;
export function validateTokenUsage(value: unknown): TokenUsageStats;
export function primaryTokenUsage(stats: TokenUsageStats): TokenUsageStats;
