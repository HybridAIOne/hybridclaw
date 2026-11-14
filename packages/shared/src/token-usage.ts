/**
 * Canonical usage snapshots for live workers and durable recovery. Validation
 * rejects corrupt counters; it never estimates missing provider charges.
 */
import { isRecord } from './primitive-values.ts';
import { isRuntimeProviderId, type RuntimeProviderId } from './provider-ids.ts';

/**
 * Usage snapshots shared by workers and recovery readers. Only observed API
 * tokens are billable evidence; estimates and unfinished calls remain distinct.
 */
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

  const costUsd = stats.modelUsage?.every((call) => call.costUsd !== undefined)
    ? stats.modelUsage.reduce((sum, call) => sum + (call.costUsd as number), 0)
    : undefined;
  if (costUsd !== undefined && !Number.isFinite(costUsd))
    throw new Error('Invalid model usage cost total.');
  const result: TokenUsageStats = {
    ...stats,
    apiTotalTokens,
    estimatedTotalTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(stats.modelUsage
      ? {
          modelUsage: stats.modelUsage.map((call) => ({
            ...call,
            usage: finalizeTokenUsage(call.usage),
          })),
        }
      : {}),
  };
  if (stats.modelUsage && costUsd === undefined) delete result.costUsd;
  return result;
}

/** Gateway pricing sees only the primary calls; helpers are metered separately. */
export function primaryTokenUsage(stats: TokenUsageStats): TokenUsageStats {
  if (!stats.modelUsage) return stats;
  const calls = stats.modelUsage.filter((call) => !call.task);
  const counters = sumCallCounters(calls);
  // An auxiliary-only turn has a known absence of primary inference.
  if (!calls.length) counters.apiUsageAvailable = true;
  return finalizeTokenUsage({
    ...counters,
    performanceSamples: stats.performanceSamples,
    ...(calls.every((call) => call.costUsd !== undefined)
      ? {
          costUsd: calls.reduce(
            (sum, call) => sum + (call.costUsd as number),
            0,
          ),
        }
      : {}),
  });
}

function sumCallCounters(calls: ModelCallUsage[]): TokenUsageStats {
  const counters = createTokenUsageStats();
  for (const call of calls) {
    for (const [key, initial] of Object.entries(counters)) {
      if (typeof initial === 'number')
        (counters as unknown as Record<string, number>)[key] += (
          call.usage as unknown as Record<string, number>
        )[key];
      else if (typeof initial === 'boolean')
        (counters as unknown as Record<string, boolean>)[key] ||= (
          call.usage as unknown as Record<string, boolean>
        )[key];
    }
  }
  return finalizeTokenUsage(counters);
}

function validateCounters(value: unknown): TokenUsageStats {
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

export function validateTokenUsage(value: unknown): TokenUsageStats {
  const result = validateCounters(value);
  if ((value as Record<string, unknown>).costUsd !== undefined) {
    if (
      typeof (value as Record<string, unknown>).costUsd !== 'number' ||
      !Number.isFinite((value as Record<string, unknown>).costUsd) ||
      ((value as Record<string, unknown>).costUsd as number) < 0
    )
      throw new Error('Invalid checkpoint reported cost.');
    result.costUsd = (value as Record<string, unknown>).costUsd as number;
  }
  if ((value as Record<string, unknown>).modelUsage !== undefined) {
    if (!Array.isArray((value as Record<string, unknown>).modelUsage))
      throw new Error('Invalid checkpoint model usage.');
    result.modelUsage = (
      (value as Record<string, unknown>).modelUsage as unknown[]
    ).map((call: unknown): ModelCallUsage => {
      if (
        !isRecord(call) ||
        typeof call.model !== 'string' ||
        !call.model.trim() ||
        (call.provider !== undefined && !isRuntimeProviderId(call.provider)) ||
        (call.task !== undefined &&
          (typeof call.task !== 'string' || !call.task.trim())) ||
        !['running', 'success', 'error'].includes(call.status as string) ||
        !Number.isSafeInteger(call.durationMs) ||
        (call.durationMs as number) < 0 ||
        (call.usage as Record<string, unknown> | undefined)?.modelCalls !== 1 ||
        (call.costUsd !== undefined &&
          (typeof call.costUsd !== 'number' ||
            !Number.isFinite(call.costUsd) ||
            call.costUsd < 0)) ||
        (call.usage as Record<string, unknown> | undefined)?.modelUsage !==
          undefined
      )
        throw new Error('Invalid checkpoint model usage.');
      return {
        model: call.model,
        ...(call.provider !== undefined
          ? { provider: call.provider as RuntimeProviderId }
          : {}),
        ...(call.task !== undefined ? { task: call.task as string } : {}),
        status: call.status as ModelCallUsage['status'],
        durationMs: call.durationMs as number,
        usage: validateCounters(call.usage),
        ...(call.costUsd !== undefined
          ? { costUsd: call.costUsd as number }
          : {}),
      };
    });
    const expected = sumCallCounters(result.modelUsage);
    for (const [key, initial] of Object.entries(createTokenUsageStats())) {
      if (typeof initial !== 'number' && typeof initial !== 'boolean') continue;
      if (
        (result as unknown as Record<string, unknown>)[key] !==
        (expected as unknown as Record<string, unknown>)[key]
      )
        throw new Error('Model call usage does not match aggregate counters.');
    }
  }
  return finalizeTokenUsage(result);
}
