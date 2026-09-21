/**
 * Per-response routing evidence contains metadata only, never prompt content.
 * Unlike the routing policy, this record describes execution and grants no authority.
 */
import {
  isTypedRoutingEvaluation,
  type TypedRoutingEvaluation,
} from '../routing/evaluator-contract.js';
export interface RoutingTraceAttempt {
  id: number;
  kind: 'execution' | 'auxiliary';
  model: string;
  zone: string;
  reason: string;
  tier: string | null;
  status: 'running' | 'success' | 'error';
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  tokensEstimated: boolean;
  costUsd: number | null;
  costSource: 'reported' | 'estimated' | 'unknown';
}

export interface RoutingTrace {
  evaluation?: TypedRoutingEvaluation;
  version: 1;
  status: 'running' | 'complete' | 'error';
  mode: 'direct' | 'concierge' | 'tiered';
  attempts: RoutingTraceAttempt[];
  durationMs: number;
}

export function parseRoutingTrace(raw: string | null): RoutingTrace | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as RoutingTrace;
    if (
      value?.version !== 1 ||
      !['running', 'complete', 'error'].includes(value.status) ||
      !['direct', 'concierge', 'tiered'].includes(value.mode) ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs < 0 ||
      !Array.isArray(value.attempts)
    )
      return null;
    if (
      value.evaluation !== undefined &&
      !isTypedRoutingEvaluation(value.evaluation)
    )
      return null;
    for (const attempt of value.attempts) {
      if (
        !attempt ||
        !Number.isSafeInteger(attempt.id) ||
        attempt.id < 1 ||
        !['execution', 'auxiliary'].includes(attempt.kind) ||
        typeof attempt.model !== 'string' ||
        typeof attempt.zone !== 'string' ||
        typeof attempt.reason !== 'string' ||
        (attempt.tier !== null && typeof attempt.tier !== 'string') ||
        !['running', 'success', 'error'].includes(attempt.status) ||
        !['reported', 'estimated', 'unknown'].includes(attempt.costSource) ||
        typeof attempt.tokensEstimated !== 'boolean' ||
        !Number.isFinite(attempt.durationMs) ||
        attempt.durationMs < 0
      )
        return null;
      for (const key of [
        'inputTokens',
        'outputTokens',
        'totalTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'costUsd',
      ] as const) {
        if (
          attempt[key] !== null &&
          (typeof attempt[key] !== 'number' ||
            !Number.isFinite(attempt[key]) ||
            attempt[key] < 0)
        )
          return null;
      }
    }
    return value;
  } catch {
    return null;
  }
}
