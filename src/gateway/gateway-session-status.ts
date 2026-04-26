import {
  getRecentStructuredAuditForSession,
  listStructuredAuditSessionIdsByPrefix,
} from '../memory/db.js';
import { firstNumber, parseAuditPayload } from './gateway-utils.js';

export interface SessionStatusSnapshot {
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHitPercent: number | null;
  contextUsedTokens: number | null;
  contextBudgetTokens: number | null;
  contextUsagePercent: number | null;
  inputTokensPerSecond: number | null;
  inputTokensPerSecondStddev: number | null;
  outputTokensPerSecond: number | null;
  outputTokensPerSecondStddev: number | null;
  tokensPerSecond: number | null;
  tokensPerSecondStddev: number | null;
}

export interface DelegateSessionStatusSnapshot {
  promptTokens: number;
  completionTokens: number;
  sessionCount: number;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleStddev(values: number[], mean: number): number {
  if (values.length <= 1) return 0;
  const squaredDeltaSum = values.reduce((total, value) => {
    const delta = value - mean;
    return total + delta * delta;
  }, 0);
  return Math.sqrt(squaredDeltaSum / (values.length - 1));
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

function addPerformanceSample(
  sample: Record<string, unknown>,
  samples: {
    input: number[];
    output: number[];
    total: number[];
  },
): boolean {
  const promptTokens = readPositiveNumber(sample.promptTokens) ?? 0;
  const completionTokens = readPositiveNumber(sample.completionTokens) ?? 0;
  const totalTokens =
    readPositiveNumber(sample.totalTokens) ?? promptTokens + completionTokens;
  const durationMs = readPositiveNumber(sample.durationMs);
  if (durationMs == null) return false;

  const firstTextDeltaMs = readPositiveNumber(sample.firstTextDeltaMs);
  if (promptTokens > 0) {
    samples.input.push(
      (promptTokens / (firstTextDeltaMs ?? durationMs)) * 1000,
    );
  }
  if (completionTokens > 0) {
    const outputDurationMs =
      firstTextDeltaMs != null && durationMs > firstTextDeltaMs
        ? durationMs - firstTextDeltaMs
        : durationMs;
    samples.output.push((completionTokens / outputDurationMs) * 1000);
  }
  if (totalTokens > 0) {
    samples.total.push((totalTokens / durationMs) * 1000);
  }
  return promptTokens + completionTokens > 0 || totalTokens > 0;
}

export function readSessionStatusSnapshot(
  sessionId: string,
  options?: {
    currentModel?: string | null;
    modelContextWindowTokens?: number | null;
  },
): SessionStatusSnapshot {
  const entries = getRecentStructuredAuditForSession(sessionId, 160);
  let usagePayload: Record<string, unknown> | null = null;
  let modelSelectionPayload: Record<string, unknown> | null = null;
  const inputTokensPerSecondSamples: number[] = [];
  const outputTokensPerSecondSamples: number[] = [];
  const tokensPerSecondSamples: number[] = [];

  for (const entry of entries) {
    const payload = parseAuditPayload(entry);
    if (!payload) continue;
    const payloadType =
      typeof payload.type === 'string' ? payload.type : entry.event_type;
    if (payloadType === 'model.usage') {
      if (!usagePayload) usagePayload = payload;
      const payloadPerformanceSamples = Array.isArray(
        payload.performanceSamples,
      )
        ? payload.performanceSamples
        : [];
      let usedPerformanceSamples = false;
      for (const sample of payloadPerformanceSamples) {
        if (!sample || typeof sample !== 'object') continue;
        usedPerformanceSamples =
          addPerformanceSample(sample as Record<string, unknown>, {
            input: inputTokensPerSecondSamples,
            output: outputTokensPerSecondSamples,
            total: tokensPerSecondSamples,
          }) || usedPerformanceSamples;
      }
      if (usedPerformanceSamples) continue;

      const entryPrompt = firstNumber([
        payload.promptTokens,
        payload.apiPromptTokens,
        payload.estimatedPromptTokens,
      ]);
      const entryCompletion = firstNumber([
        payload.completionTokens,
        payload.apiCompletionTokens,
        payload.estimatedCompletionTokens,
      ]);
      const entryDurationMs = firstNumber([payload.durationMs]);
      const entryPromptTokens = Math.max(0, entryPrompt || 0);
      const entryCompletionTokens = Math.max(0, entryCompletion || 0);
      const entryTokens = entryPromptTokens + entryCompletionTokens;
      if (entryDurationMs != null && entryDurationMs > 0) {
        if (entryPromptTokens > 0) {
          inputTokensPerSecondSamples.push(
            (entryPromptTokens / entryDurationMs) * 1000,
          );
        }
        if (entryCompletionTokens > 0) {
          outputTokensPerSecondSamples.push(
            (entryCompletionTokens / entryDurationMs) * 1000,
          );
        }
        if (entryTokens > 0) {
          tokensPerSecondSamples.push((entryTokens / entryDurationMs) * 1000);
        }
      }
    }
    if (
      !modelSelectionPayload &&
      payloadType === 'model.set' &&
      (!options?.currentModel ||
        String(payload.model || '').trim() === options.currentModel)
    ) {
      modelSelectionPayload = payload;
    }
  }

  const inputTokensPerSecond = average(inputTokensPerSecondSamples);
  const inputTokensPerSecondStddev =
    inputTokensPerSecond != null
      ? sampleStddev(inputTokensPerSecondSamples, inputTokensPerSecond)
      : null;
  const outputTokensPerSecond = average(outputTokensPerSecondSamples);
  const outputTokensPerSecondStddev =
    outputTokensPerSecond != null
      ? sampleStddev(outputTokensPerSecondSamples, outputTokensPerSecond)
      : null;
  const tokensPerSecond = average(tokensPerSecondSamples);
  const tokensPerSecondStddev =
    tokensPerSecond != null
      ? sampleStddev(tokensPerSecondSamples, tokensPerSecond)
      : null;

  const promptTokens = firstNumber([
    usagePayload?.promptTokens,
    usagePayload?.apiPromptTokens,
    usagePayload?.estimatedPromptTokens,
  ]);
  const completionTokens = firstNumber([
    usagePayload?.completionTokens,
    usagePayload?.apiCompletionTokens,
    usagePayload?.estimatedCompletionTokens,
  ]);

  const cacheReadTokens = firstNumber([
    usagePayload?.cacheReadTokens,
    usagePayload?.cacheReadInputTokens,
    usagePayload?.apiCacheReadTokens,
    usagePayload?.cacheRead,
    usagePayload?.cache_read,
    usagePayload?.cache_read_tokens,
    usagePayload?.cache_read_input_tokens,
    usagePayload?.cached_tokens,
    (usagePayload?.prompt_tokens_details as Record<string, unknown> | undefined)
      ?.cached_tokens,
  ]);
  const cacheWriteTokens = firstNumber([
    usagePayload?.cacheWriteTokens,
    usagePayload?.cacheWriteInputTokens,
    usagePayload?.apiCacheWriteTokens,
    usagePayload?.cacheWrite,
    usagePayload?.cache_write,
    usagePayload?.cache_write_tokens,
    usagePayload?.cache_write_input_tokens,
    usagePayload?.cache_creation_input_tokens,
  ]);
  const cacheRead = Math.max(0, cacheReadTokens || 0);
  const cacheWrite = Math.max(0, cacheWriteTokens || 0);
  const cacheTotal = cacheRead + cacheWrite;
  const cacheHitPercent =
    cacheTotal > 0 ? (cacheRead / cacheTotal) * 100 : null;

  const contextUsedTokens = firstNumber([
    usagePayload?.contextTokens,
    usagePayload?.context_tokens,
    usagePayload?.tokensInContext,
    usagePayload?.tokens_in_context,
    usagePayload?.promptTokens,
    usagePayload?.apiPromptTokens,
    usagePayload?.estimatedPromptTokens,
  ]);
  const contextBudgetTokens = firstNumber([
    usagePayload?.contextWindowTokens,
    usagePayload?.context_window_tokens,
    usagePayload?.modelContextWindowTokens,
    usagePayload?.model_context_window_tokens,
    usagePayload?.modelContextWindow,
    usagePayload?.model_context_window,
    usagePayload?.maxContextTokens,
    usagePayload?.max_context_tokens,
    usagePayload?.contextWindow,
    usagePayload?.context_window,
    usagePayload?.contextLength,
    usagePayload?.context_length,
    usagePayload?.maxContextSize,
    usagePayload?.max_context_size,
    modelSelectionPayload?.modelContextWindowTokens,
    modelSelectionPayload?.model_context_window_tokens,
    modelSelectionPayload?.contextWindowTokens,
    modelSelectionPayload?.context_window_tokens,
    options?.modelContextWindowTokens,
  ]);
  const contextUsagePercent =
    contextUsedTokens != null &&
    contextBudgetTokens != null &&
    contextBudgetTokens > 0
      ? (contextUsedTokens / contextBudgetTokens) * 100
      : null;

  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitPercent,
    contextUsedTokens,
    contextBudgetTokens,
    contextUsagePercent,
    inputTokensPerSecond,
    inputTokensPerSecondStddev,
    outputTokensPerSecond,
    outputTokensPerSecondStddev,
    tokensPerSecond,
    tokensPerSecondStddev,
  };
}

export function readDelegateSessionStatusSnapshot(
  parentSessionId: string,
): DelegateSessionStatusSnapshot {
  const childSessionIds = listStructuredAuditSessionIdsByPrefix(
    `delegate:d1:${String(parentSessionId || '').trim()}:`,
    64,
  );
  let promptTokens = 0;
  let completionTokens = 0;
  let sessionCount = 0;

  for (const childSessionId of childSessionIds) {
    const snapshot = readSessionStatusSnapshot(childSessionId);
    promptTokens += Math.max(0, snapshot.promptTokens || 0);
    completionTokens += Math.max(0, snapshot.completionTokens || 0);
    sessionCount += 1;
  }

  return {
    promptTokens,
    completionTokens,
    sessionCount,
  };
}
