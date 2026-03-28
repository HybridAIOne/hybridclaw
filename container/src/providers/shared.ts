import type { ChatMessage, ToolDefinition } from '../types.js';

export type RuntimeProvider =
  | 'hybridai'
  | 'openai-codex'
  | 'openrouter'
  | 'huggingface'
  | 'ollama'
  | 'lmstudio'
  | 'vllm';

export interface NormalizedCallArgs {
  provider: RuntimeProvider | undefined;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders: Record<string, string> | undefined;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens: number | undefined;
  isLocal: boolean;
  contextWindow: number | undefined;
  thinkingFormat: 'qwen' | undefined;
}

export interface NormalizedStreamCallArgs extends NormalizedCallArgs {
  onTextDelta: (delta: string) => void;
  onActivity?: () => void;
}

function summarizeErrorBody(body: string): string {
  const trimmed = String(body || '').trim();
  if (!trimmed) return 'Unknown error';

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string' && parsed.trim()) {
      return parsed.trim();
    }
    if (isRecord(parsed)) {
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
      const nested = parsed.error;
      if (isRecord(nested)) {
        if (typeof nested.message === 'string' && nested.message.trim()) {
          return nested.message.trim();
        }
        if (typeof nested.error === 'string' && nested.error.trim()) {
          return nested.error.trim();
        }
      }
    }
  } catch {
    // Fall back to the raw body below.
  }

  return trimmed;
}

export class HybridAIRequestError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`HybridAI API error ${status}: ${summarizeErrorBody(body)}`);
    this.name = 'HybridAIRequestError';
    this.status = status;
    this.body = body;
  }
}

function isProvider(value: unknown): value is RuntimeProvider {
  return (
    value === 'hybridai' ||
    value === 'openai-codex' ||
    value === 'openrouter' ||
    value === 'huggingface' ||
    value === 'ollama' ||
    value === 'lmstudio' ||
    value === 'vllm'
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value);
}

export function buildRequestHeaders(
  apiKey: string,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(requestHeaders || {}),
  };
}

export function normalizeOpenRouterRuntimeModelName(model: string): string {
  const trimmed = String(model || '').trim();
  const prefix = 'openrouter/';
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  const upstreamModel = trimmed.slice(prefix.length).trim();
  if (!upstreamModel) return trimmed;
  // OpenRouter-native ids like `openrouter/free` and `openrouter/hunter-alpha`
  // keep their namespace. Vendor-scoped ids use the upstream path.
  return upstreamModel.includes('/') ? upstreamModel : trimmed;
}

export function normalizeCallArgs(rawArgs: unknown[]): NormalizedCallArgs {
  if (isProvider(rawArgs[0])) {
    return {
      provider: rawArgs[0],
      baseUrl: String(rawArgs[1] || ''),
      apiKey: String(rawArgs[2] || ''),
      model: String(rawArgs[3] || ''),
      chatbotId: String(rawArgs[4] || ''),
      enableRag: Boolean(rawArgs[5]),
      requestHeaders: isStringRecord(rawArgs[6]) ? rawArgs[6] : undefined,
      messages: (rawArgs[7] as ChatMessage[]) || [],
      tools: (rawArgs[8] as ToolDefinition[]) || [],
      maxTokens: typeof rawArgs[9] === 'number' ? rawArgs[9] : undefined,
      isLocal: Boolean(rawArgs[10]),
      contextWindow: typeof rawArgs[11] === 'number' ? rawArgs[11] : undefined,
      thinkingFormat: rawArgs[12] === 'qwen' ? 'qwen' : undefined,
    };
  }

  return {
    provider: undefined,
    baseUrl: String(rawArgs[0] || ''),
    apiKey: String(rawArgs[1] || ''),
    model: String(rawArgs[2] || ''),
    chatbotId: String(rawArgs[3] || ''),
    enableRag: Boolean(rawArgs[4]),
    requestHeaders: undefined,
    messages: (rawArgs[5] as ChatMessage[]) || [],
    tools: (rawArgs[6] as ToolDefinition[]) || [],
    maxTokens: typeof rawArgs[7] === 'number' ? rawArgs[7] : undefined,
    isLocal: Boolean(rawArgs[8]),
    contextWindow: typeof rawArgs[9] === 'number' ? rawArgs[9] : undefined,
    thinkingFormat: rawArgs[10] === 'qwen' ? 'qwen' : undefined,
  };
}

export function normalizeStreamCallArgs(
  rawArgs: unknown[],
): NormalizedStreamCallArgs {
  if (isProvider(rawArgs[0])) {
    const onActivity =
      typeof rawArgs[10] === 'function'
        ? (rawArgs[10] as () => void)
        : () => undefined;
    const maxTokensIndex = typeof rawArgs[10] === 'function' ? 11 : 10;
    const isLocalIndex = maxTokensIndex + 1;
    const contextWindowIndex = maxTokensIndex + 2;
    const thinkingFormatIndex = maxTokensIndex + 3;
    return {
      provider: rawArgs[0],
      baseUrl: String(rawArgs[1] || ''),
      apiKey: String(rawArgs[2] || ''),
      model: String(rawArgs[3] || ''),
      chatbotId: String(rawArgs[4] || ''),
      enableRag: Boolean(rawArgs[5]),
      requestHeaders: isStringRecord(rawArgs[6]) ? rawArgs[6] : undefined,
      messages: (rawArgs[7] as ChatMessage[]) || [],
      tools: (rawArgs[8] as ToolDefinition[]) || [],
      onTextDelta: (rawArgs[9] as (delta: string) => void) || (() => {}),
      onActivity,
      maxTokens:
        typeof rawArgs[maxTokensIndex] === 'number'
          ? rawArgs[maxTokensIndex]
          : undefined,
      isLocal: Boolean(rawArgs[isLocalIndex]),
      contextWindow:
        typeof rawArgs[contextWindowIndex] === 'number'
          ? rawArgs[contextWindowIndex]
          : undefined,
      thinkingFormat:
        rawArgs[thinkingFormatIndex] === 'qwen' ? 'qwen' : undefined,
    };
  }

  const onActivity =
    typeof rawArgs[8] === 'function'
      ? (rawArgs[8] as () => void)
      : () => undefined;
  const maxTokensIndex = typeof rawArgs[8] === 'function' ? 9 : 8;
  const isLocalIndex = maxTokensIndex + 1;
  const contextWindowIndex = maxTokensIndex + 2;
  const thinkingFormatIndex = maxTokensIndex + 3;
  return {
    provider: undefined,
    baseUrl: String(rawArgs[0] || ''),
    apiKey: String(rawArgs[1] || ''),
    model: String(rawArgs[2] || ''),
    chatbotId: String(rawArgs[3] || ''),
    enableRag: Boolean(rawArgs[4]),
    requestHeaders: undefined,
    messages: (rawArgs[5] as ChatMessage[]) || [],
    tools: (rawArgs[6] as ToolDefinition[]) || [],
    onTextDelta: (rawArgs[7] as (delta: string) => void) || (() => {}),
    onActivity,
    maxTokens:
      typeof rawArgs[maxTokensIndex] === 'number'
        ? rawArgs[maxTokensIndex]
        : undefined,
    isLocal: Boolean(rawArgs[isLocalIndex]),
    contextWindow:
      typeof rawArgs[contextWindowIndex] === 'number'
        ? rawArgs[contextWindowIndex]
        : undefined,
    thinkingFormat:
      rawArgs[thinkingFormatIndex] === 'qwen' ? 'qwen' : undefined,
  };
}
