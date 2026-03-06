import type { ChatMessage, ToolDefinition } from '../types.js';

export type RuntimeProvider = 'hybridai' | 'openai-codex';

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
}

export interface NormalizedStreamCallArgs extends NormalizedCallArgs {
  onTextDelta: (delta: string) => void;
}

export class HybridAIRequestError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`HybridAI API error ${status}: ${body}`);
    this.name = 'HybridAIRequestError';
    this.status = status;
    this.body = body;
  }
}

function isProvider(value: unknown): value is RuntimeProvider {
  return value === 'hybridai' || value === 'openai-codex';
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
  };
}

export function normalizeStreamCallArgs(
  rawArgs: unknown[],
): NormalizedStreamCallArgs {
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
      onTextDelta: (rawArgs[9] as (delta: string) => void) || (() => {}),
      maxTokens: typeof rawArgs[10] === 'number' ? rawArgs[10] : undefined,
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
    onTextDelta: (rawArgs[7] as (delta: string) => void) || (() => {}),
    maxTokens: typeof rawArgs[8] === 'number' ? rawArgs[8] : undefined,
  };
}
