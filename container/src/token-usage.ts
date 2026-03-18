import { isRecord } from './providers/shared.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  TokenUsageStats,
} from './types.js';

export const CHARS_PER_TOKEN = 4;
export const TOOL_RESULT_CHARS_PER_TOKEN = 2;
export type TokenEstimateCache = WeakMap<ChatMessage, number>;

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

function parseOptionalUsageNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return undefined;
}

function firstDefined(values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
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
  };
}

export function createTokenEstimateCache(): TokenEstimateCache {
  return new WeakMap<ChatMessage, number>();
}

export function estimateTextTokens(text: unknown): number {
  return estimateTextTokensWithRatio(text, CHARS_PER_TOKEN);
}

export function estimateToolResultTokens(text: unknown): number {
  return estimateTextTokensWithRatio(text, TOOL_RESULT_CHARS_PER_TOKEN);
}

function estimateTextTokensWithRatio(
  text: unknown,
  charsPerToken: number,
): number {
  const normalized = typeof text === 'string' ? text : '';
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / charsPerToken));
}

export function normalizeContentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      chunks.push(part.text);
      continue;
    }
    if (part?.type === 'image_url' && part.image_url?.url) {
      chunks.push('[image]');
      continue;
    }
    if (part?.type === 'audio_url' && part.audio_url?.url) {
      chunks.push('[audio]');
    }
  }
  return chunks.join('\n');
}

export function estimateChatMessageTokens(
  message: ChatMessage,
  cache?: TokenEstimateCache,
): number {
  if (cache) {
    const cached = cache.get(message);
    if (cached !== undefined) return cached;
  }

  let total = 4;
  total += estimateTextTokens(message.role);
  total +=
    message.role === 'tool'
      ? estimateToolResultTokens(normalizeContentText(message.content))
      : estimateTextTokens(normalizeContentText(message.content));
  if (message.tool_calls) {
    total += estimateTextTokens(JSON.stringify(message.tool_calls));
  }
  if (message.tool_call_id) total += estimateTextTokens(message.tool_call_id);

  cache?.set(message, total);
  return total;
}

export function estimateMessageTokens(
  messages: ChatMessage[],
  cache?: TokenEstimateCache,
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  let total = 2;
  for (const message of messages) {
    total += estimateChatMessageTokens(message, cache);
  }
  return total;
}

export function accumulateApiUsage(
  stats: TokenUsageStats,
  response: ChatCompletionResponse,
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
  const promptTokenDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : null;
  const cacheReadTokens = parseOptionalUsageNumber(
    firstDefined([
      usageRecord.cacheRead,
      usageRecord.cache_read,
      usageRecord.cacheReadTokens,
      usage.cache_read_tokens,
      usageRecord.cacheReadInputTokens,
      usage.cache_read_input_tokens,
      usageRecord.cached_tokens,
      usage.cached_tokens,
      promptTokenDetails?.cached_tokens,
    ]),
  );
  const cacheWriteTokens = parseOptionalUsageNumber(
    firstDefined([
      usageRecord.cacheWrite,
      usageRecord.cache_write,
      usageRecord.cacheWriteTokens,
      usage.cache_write_tokens,
      usageRecord.cacheWriteInputTokens,
      usage.cache_write_input_tokens,
      usage.cache_creation_input_tokens,
    ]),
  );
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

export function finalizeTokenUsage(stats: TokenUsageStats): TokenUsageStats {
  const estimatedTotalTokens =
    stats.estimatedPromptTokens + stats.estimatedCompletionTokens;
  let apiTotalTokens = stats.apiTotalTokens;
  if (stats.apiUsageAvailable && apiTotalTokens === 0) {
    apiTotalTokens = stats.apiPromptTokens + stats.apiCompletionTokens;
  }

  return {
    ...stats,
    apiTotalTokens,
    estimatedTotalTokens,
  };
}
