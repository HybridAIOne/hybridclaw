import type { ChatCompletionResponse, ChatMessage, TokenUsageStats } from './types.js';

const CHARS_PER_TOKEN = 4;

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

export function createTokenUsageStats(): TokenUsageStats {
  return {
    modelCalls: 0,
    apiUsageAvailable: false,
    apiPromptTokens: 0,
    apiCompletionTokens: 0,
    apiTotalTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
  };
}

export function estimateTextTokens(text: unknown): number {
  const normalized = typeof text === 'string' ? text : '';
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / CHARS_PER_TOKEN));
}

function normalizeContentText(content: ChatMessage['content']): string {
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
    }
  }
  return chunks.join('\n');
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  let total = 2;
  for (const message of messages) {
    total += 4;
    total += estimateTextTokens(message.role);
    total += estimateTextTokens(normalizeContentText(message.content));
    if (message.tool_calls) total += estimateTextTokens(JSON.stringify(message.tool_calls));
    if (message.tool_call_id) total += estimateTextTokens(message.tool_call_id);
  }
  return total;
}

export function accumulateApiUsage(
  stats: TokenUsageStats,
  response: ChatCompletionResponse,
): void {
  const usage = response.usage;
  if (!usage) return;

  const hasUsageFields =
    usage.prompt_tokens != null
    || usage.completion_tokens != null
    || usage.total_tokens != null
    || usage.input_tokens != null
    || usage.output_tokens != null;
  if (!hasUsageFields) return;

  const promptTokens = parseUsageNumber(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = parseUsageNumber(usage.completion_tokens ?? usage.output_tokens);
  let totalTokens = parseUsageNumber(usage.total_tokens);
  if (totalTokens === 0 && (promptTokens > 0 || completionTokens > 0)) {
    totalTokens = promptTokens + completionTokens;
  }

  stats.apiUsageAvailable = true;
  stats.apiPromptTokens += promptTokens;
  stats.apiCompletionTokens += completionTokens;
  stats.apiTotalTokens += totalTokens;
}

export function finalizeTokenUsage(stats: TokenUsageStats): TokenUsageStats {
  const estimatedTotalTokens = stats.estimatedPromptTokens + stats.estimatedCompletionTokens;
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
