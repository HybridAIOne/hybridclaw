/**
 * Turn-scoped routing telemetry isolates concurrent requests and closes at completion.
 * Unlike billing storage, this collector preserves unknown costs and never stores content.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getModelCatalogMetadata } from '../providers/model-catalog.js';
import type {
  RoutingTrace,
  RoutingTraceAttempt,
} from '../types/routing-trace.js';
import { estimateModelUsageCostUsd } from './model-cost.js';

const scope = new AsyncLocalStorage<{
  trace: RoutingTrace;
  closed: boolean;
  reason?: string;
  progress?: (trace: RoutingTrace) => void;
}>();

export async function captureRoutingTrace<T>(
  work: () => Promise<T>,
  progress?: (trace: RoutingTrace) => void,
): Promise<{ result: T; trace: RoutingTrace }> {
  const startedAt = Date.now();
  const state = {
    trace: {
      version: 1,
      status: 'running',
      mode: 'direct',
      attempts: [],
      durationMs: 0,
    } as RoutingTrace,
    closed: false,
    progress,
  };
  return scope.run(state, async () => {
    try {
      const result = await work();
      return { result, trace: state.trace };
    } finally {
      state.closed = true;
      state.trace.durationMs = Date.now() - startedAt;
      state.trace.status = 'complete';
      for (const attempt of state.trace.attempts) {
        if (attempt.status === 'running') attempt.status = 'error';
      }
    }
  });
}

export function setRoutingTraceMode(
  mode: RoutingTrace['mode'],
  reason?: string,
): void {
  const state = scope.getStore();
  if (state && !state.closed) {
    state.trace.mode = mode;
    state.reason = reason;
  }
}

export function startRoutingTraceAttempt(
  model: string,
  kind: RoutingTraceAttempt['kind'] = 'execution',
  reason?: string,
): RoutingTraceAttempt | undefined {
  const state = scope.getStore();
  if (!state || state.closed) return undefined;
  const attempt: RoutingTraceAttempt = {
    id: state.trace.attempts.length + 1,
    kind,
    model,
    zone: getModelCatalogMetadata(model).zone ?? 'cloud',
    reason: reason ?? state.reason ?? 'selected-model',
    tier: null,
    status: 'running',
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    tokensEstimated: false,
    costUsd: null,
    costSource: 'unknown',
  };
  state.trace.attempts.push(attempt);
  state.progress?.(structuredClone(state.trace));
  return attempt;
}

export function finishRoutingTraceAttempt(params: {
  model: string;
  attempt?: RoutingTraceAttempt;
  status: 'success' | 'error';
  durationMs: number;
  reason?: string;
  tier?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  tokensEstimated?: boolean;
  costUsd?: number;
  costSource?: 'reported' | 'estimated';
}): void {
  const state = scope.getStore();
  if (!state || state.closed) return;
  const attempt =
    params.attempt ??
    state.trace.attempts.find(
      (item) =>
        item.kind === 'execution' &&
        item.model === params.model &&
        item.status === 'running',
    );
  if (!attempt) return;
  const finite = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  attempt.status = params.status;
  attempt.durationMs = Math.max(0, params.durationMs);
  attempt.reason = params.reason ?? attempt.reason;
  attempt.tier = params.tier ?? null;
  attempt.inputTokens = finite(params.inputTokens);
  attempt.outputTokens = finite(params.outputTokens);
  attempt.totalTokens =
    finite(params.totalTokens) ??
    (attempt.inputTokens !== null && attempt.outputTokens !== null
      ? attempt.inputTokens + attempt.outputTokens
      : null);
  attempt.cacheReadTokens = finite(params.cacheReadTokens);
  attempt.cacheWriteTokens = finite(params.cacheWriteTokens);
  attempt.tokensEstimated = params.tokensEstimated ?? false;
  const explicit = finite(params.costUsd);
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  const estimated =
    attempt.inputTokens !== null &&
    attempt.outputTokens !== null &&
    (attempt.inputTokens === 0 || pricing.input != null) &&
    (attempt.outputTokens === 0 || pricing.output != null)
      ? estimateModelUsageCostUsd({
          model: params.model,
          promptTokens: attempt.inputTokens,
          completionTokens: attempt.outputTokens,
          cacheReadTokens: attempt.cacheReadTokens,
          cacheWriteTokens: attempt.cacheWriteTokens,
        })
      : null;
  attempt.costUsd = explicit ?? estimated;
  attempt.costSource =
    explicit !== null
      ? (params.costSource ?? 'reported')
      : estimated !== null
        ? 'estimated'
        : 'unknown';
}
