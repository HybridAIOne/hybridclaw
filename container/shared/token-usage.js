/**
 * Canonical usage snapshots for live workers and durable recovery. Validation
 * rejects corrupt counters; it never estimates missing provider charges.
 */
import { isRecord } from './primitive-values.js';
import { isRuntimeProviderId } from './provider-ids.js';

export function createTokenUsageStats() {
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

export function finalizeTokenUsage(stats) {
  const estimatedTotalTokens =
    stats.estimatedPromptTokens + stats.estimatedCompletionTokens;
  let apiTotalTokens = stats.apiTotalTokens;
  if (stats.apiUsageAvailable && apiTotalTokens === 0) {
    apiTotalTokens = stats.apiPromptTokens + stats.apiCompletionTokens;
  }

  const costUsd = stats.modelUsage?.every((call) => call.costUsd !== undefined)
    ? stats.modelUsage.reduce((sum, call) => sum + call.costUsd, 0)
    : undefined;
  if (costUsd !== undefined && !Number.isFinite(costUsd))
    throw new Error('Invalid model usage cost total.');
  const result = {
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
export function primaryTokenUsage(stats) {
  if (!stats.modelUsage) return stats;
  const calls = stats.modelUsage.filter((call) => !call.task);
  const counters = sumCallCounters(calls);
  // An auxiliary-only turn has a known absence of primary inference.
  if (!calls.length) counters.apiUsageAvailable = true;
  return finalizeTokenUsage({
    ...counters,
    performanceSamples: stats.performanceSamples,
    ...(calls.every((call) => call.costUsd !== undefined)
      ? { costUsd: calls.reduce((sum, call) => sum + call.costUsd, 0) }
      : {}),
  });
}

function sumCallCounters(calls) {
  const counters = createTokenUsageStats();
  for (const call of calls) {
    for (const [key, initial] of Object.entries(counters)) {
      if (typeof initial === 'number') counters[key] += call.usage[key];
      else if (typeof initial === 'boolean') counters[key] ||= call.usage[key];
    }
  }
  return finalizeTokenUsage(counters);
}

function validateCounters(value) {
  if (!isRecord(value)) throw new Error('Invalid checkpoint usage.');
  const result = createTokenUsageStats();
  for (const [key, initial] of Object.entries(result)) {
    if (key === 'performanceSamples') continue;
    const actual = value[key];
    if (
      typeof initial === 'boolean'
        ? typeof actual !== 'boolean'
        : !Number.isSafeInteger(actual) || actual < 0
    )
      throw new Error('Invalid checkpoint usage.');
    result[key] = actual;
  }
  if (value.performanceSamples !== undefined) {
    if (!Array.isArray(value.performanceSamples))
      throw new Error('Invalid checkpoint performance samples.');
    result.performanceSamples = value.performanceSamples.map((sample) => {
      if (!isRecord(sample))
        throw new Error('Invalid checkpoint performance sample.');
      const copy = {};
      for (const key of [
        'promptTokens',
        'completionTokens',
        'totalTokens',
        'durationMs',
        'firstTextDeltaMs',
      ]) {
        const actual = sample[key];
        if (key === 'firstTextDeltaMs' && actual === undefined) continue;
        if (!Number.isSafeInteger(actual) || actual < 0)
          throw new Error('Invalid checkpoint performance sample.');
        copy[key] = actual;
      }
      return copy;
    });
  }
  const finalized = finalizeTokenUsage(result);
  if (
    !Number.isSafeInteger(finalized.apiTotalTokens) ||
    !Number.isSafeInteger(finalized.estimatedTotalTokens)
  )
    throw new Error('Invalid checkpoint usage totals.');
  return finalized;
}

export function validateTokenUsage(value) {
  const result = validateCounters(value);
  if (value.costUsd !== undefined) {
    if (
      typeof value.costUsd !== 'number' ||
      !Number.isFinite(value.costUsd) ||
      value.costUsd < 0
    )
      throw new Error('Invalid checkpoint reported cost.');
    result.costUsd = value.costUsd;
  }
  if (value.modelUsage !== undefined) {
    if (!Array.isArray(value.modelUsage))
      throw new Error('Invalid checkpoint model usage.');
    result.modelUsage = value.modelUsage.map((call) => {
      if (
        !isRecord(call) ||
        typeof call.model !== 'string' ||
        !call.model.trim() ||
        (call.provider !== undefined && !isRuntimeProviderId(call.provider)) ||
        (call.task !== undefined &&
          (typeof call.task !== 'string' || !call.task.trim())) ||
        !['running', 'success', 'error'].includes(call.status) ||
        !Number.isSafeInteger(call.durationMs) ||
        call.durationMs < 0 ||
        call.usage?.modelCalls !== 1 ||
        (call.costUsd !== undefined &&
          (typeof call.costUsd !== 'number' ||
            !Number.isFinite(call.costUsd) ||
            call.costUsd < 0)) ||
        call.usage?.modelUsage !== undefined
      )
        throw new Error('Invalid checkpoint model usage.');
      return {
        model: call.model,
        ...(call.provider !== undefined ? { provider: call.provider } : {}),
        ...(call.task !== undefined ? { task: call.task } : {}),
        status: call.status,
        durationMs: call.durationMs,
        usage: validateCounters(call.usage),
        ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : {}),
      };
    });
    const expected = sumCallCounters(result.modelUsage);
    for (const [key, initial] of Object.entries(createTokenUsageStats())) {
      if (typeof initial !== 'number' && typeof initial !== 'boolean') continue;
      if (result[key] !== expected[key])
        throw new Error('Model call usage does not match aggregate counters.');
    }
  }
  return finalizeTokenUsage(result);
}
