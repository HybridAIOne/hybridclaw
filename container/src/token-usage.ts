/**
 * Provider-response counters and the completion estimate reuse the shared
 * snapshot schema. Unlike snapshot validation, this module interprets provider
 * payloads; it does not price requests or infer charges for unfinished calls.
 * Prompt estimates live in `@hybridclaw/shared/token-estimate`.
 */
import { isRecord } from '@hybridclaw/shared/primitive-values';
import { readProviderCacheUsage } from '@hybridclaw/shared/provider-cache-usage';
import { estimateTextTokens } from '@hybridclaw/shared/token-estimate';
import type {
  ChatCompletionResponse,
  ModelCallPerformanceSample,
  TokenUsageStats,
} from './types.js';

function parseUsageNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function firstDefined(values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export {
  createTokenUsageStats,
  finalizeTokenUsage,
} from '@hybridclaw/shared/token-usage';

export function estimateResponseTokens(
  response: ChatCompletionResponse,
): number {
  const message = response.choices[0]?.message;
  return (
    estimateTextTokens(message?.content) +
    (message?.tool_calls?.length
      ? estimateTextTokens(JSON.stringify(message.tool_calls))
      : 0)
  );
}

export function accumulateApiUsage(
  stats: TokenUsageStats,
  response: Pick<ChatCompletionResponse, 'usage'>,
): void {
  const usage = response.usage;
  if (!usage) return;
  const usageRecord = isRecord(usage) ? (usage as Record<string, unknown>) : {};

  const hasTokenUsageFields =
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    usage.total_tokens != null ||
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usageRecord.promptTokens != null ||
    usageRecord.completionTokens != null ||
    usageRecord.totalTokens != null ||
    usageRecord.inputTokens != null ||
    usageRecord.outputTokens != null;
  const { cacheReadTokens, cacheWriteTokens } = readProviderCacheUsage(usage);
  const hasCacheUsageFields =
    cacheReadTokens !== undefined || cacheWriteTokens !== undefined;
  if (!hasTokenUsageFields && !hasCacheUsageFields) return;

  const promptTokens = parseUsageNumber(
    firstDefined([
      usage.prompt_tokens,
      usage.input_tokens,
      usageRecord.promptTokens,
      usageRecord.inputTokens,
    ]),
  );
  const completionTokens = parseUsageNumber(
    firstDefined([
      usage.completion_tokens,
      usage.output_tokens,
      usageRecord.completionTokens,
      usageRecord.outputTokens,
    ]),
  );
  let totalTokens = parseUsageNumber(
    firstDefined([usage.total_tokens, usageRecord.totalTokens]),
  );
  if (totalTokens === 0 && (promptTokens > 0 || completionTokens > 0)) {
    totalTokens = promptTokens + completionTokens;
  }

  if (hasTokenUsageFields) {
    stats.apiUsageAvailable = true;
    stats.apiPromptTokens += promptTokens;
    stats.apiCompletionTokens += completionTokens;
    stats.apiTotalTokens += totalTokens;
  }
  if (hasCacheUsageFields) {
    stats.apiCacheUsageAvailable = true;
    stats.apiCacheReadTokens += cacheReadTokens ?? 0;
    stats.apiCacheWriteTokens += cacheWriteTokens ?? 0;
  }
}

export function readChatCompletionUsageTokens(response: ChatCompletionResponse):
  | {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  const usageRecord = isRecord(usage) ? (usage as Record<string, unknown>) : {};

  const hasTokenUsageFields =
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    usage.total_tokens != null ||
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usageRecord.promptTokens != null ||
    usageRecord.completionTokens != null ||
    usageRecord.totalTokens != null ||
    usageRecord.inputTokens != null ||
    usageRecord.outputTokens != null;
  if (!hasTokenUsageFields) return undefined;

  const promptTokens = parseUsageNumber(
    firstDefined([
      usage.prompt_tokens,
      usage.input_tokens,
      usageRecord.promptTokens,
      usageRecord.inputTokens,
    ]),
  );
  const completionTokens = parseUsageNumber(
    firstDefined([
      usage.completion_tokens,
      usage.output_tokens,
      usageRecord.completionTokens,
      usageRecord.outputTokens,
    ]),
  );
  let totalTokens = parseUsageNumber(
    firstDefined([usage.total_tokens, usageRecord.totalTokens]),
  );
  if (totalTokens === 0 && (promptTokens > 0 || completionTokens > 0)) {
    totalTokens = promptTokens + completionTokens;
  }

  return { promptTokens, completionTokens, totalTokens };
}

export function recordPerformanceSample(
  stats: TokenUsageStats,
  sample: ModelCallPerformanceSample,
): void {
  if (
    sample.durationMs <= 0 ||
    sample.promptTokens + sample.completionTokens <= 0
  ) {
    return;
  }
  if (!stats.performanceSamples) stats.performanceSamples = [];
  stats.performanceSamples.push({
    promptTokens: Math.max(0, Math.floor(sample.promptTokens)),
    completionTokens: Math.max(0, Math.floor(sample.completionTokens)),
    totalTokens: Math.max(0, Math.floor(sample.totalTokens)),
    durationMs: Math.max(0, Math.floor(sample.durationMs)),
    ...(sample.firstTextDeltaMs != null && sample.firstTextDeltaMs > 0
      ? { firstTextDeltaMs: Math.max(0, Math.floor(sample.firstTextDeltaMs)) }
      : {}),
  });
}
