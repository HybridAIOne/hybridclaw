import { normalizeMessageContentToText } from '../ralph.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ToolDefinition,
} from '../types.js';
import { isRuntimeProvider, type RuntimeProvider } from './provider-ids.js';

export type { RuntimeProvider } from './provider-ids.js';

export interface NormalizedCallArgs {
  provider: RuntimeProvider | undefined;
  providerMethod?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders: Record<string, string> | undefined;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  debugModelResponses?: boolean;
  maxTokens: number | undefined;
  isLocal: boolean;
  contextWindow: number | undefined;
  thinkingFormat: 'qwen' | undefined;
}

export interface NormalizedStreamCallArgs extends NormalizedCallArgs {
  onTextDelta: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onActivity?: () => void;
}

interface ParsedProviderErrorBody {
  message: string | null;
  type: string | null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseProviderErrorRecord(
  value: Record<string, unknown>,
): ParsedProviderErrorBody {
  let message =
    asTrimmedString(value.message) ??
    asTrimmedString(value.detail) ??
    asTrimmedString(value.error);
  let type = asTrimmedString(value.type);
  const nested = value.error;
  if (isRecord(nested)) {
    message ||=
      asTrimmedString(nested.message) ??
      asTrimmedString(nested.detail) ??
      asTrimmedString(nested.error);
    type ||= asTrimmedString(nested.type);
  }
  return { message, type };
}

export function parseProviderErrorBody(
  body: string,
): ParsedProviderErrorBody | null {
  const trimmed = String(body || '').trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') {
      return {
        message: asTrimmedString(parsed),
        type: null,
      };
    }
    if (isRecord(parsed)) return parseProviderErrorRecord(parsed);
  } catch {
    // Fall back to the raw body below.
  }

  return {
    message: trimmed,
    type: null,
  };
}

function summarizeParsedErrorBody(
  parsed: ParsedProviderErrorBody | null,
): string {
  const message = parsed?.message;
  if (!message) return 'Unknown error';
  if (
    parsed?.type === 'permission_error' &&
    /premium models require a paid plan or token-credit balance/i.test(message)
  ) {
    return 'Premium model access requires a paid plan or token-credit balance. The non-premium HybridAI model is `gpt-4.1-mini`; use `/model set gpt-4.1-mini`, add credits, or switch to a configured `huggingface/...`, `openrouter/...`, or `openai-codex/...` model.';
  }
  return message;
}

export class ProviderRequestError extends Error {
  status: number;
  body: string;
  readonly parsedBody: ParsedProviderErrorBody | null;

  constructor(status: number, body: string) {
    const parsedBody = parseProviderErrorBody(body);
    super(
      `Provider API error ${status}: ${summarizeParsedErrorBody(parsedBody)}`,
    );
    this.name = 'ProviderRequestError';
    this.status = status;
    this.body = body;
    this.parsedBody = parsedBody;
  }
}

export function isPremiumModelPermissionError(error: unknown): boolean {
  if (!(error instanceof ProviderRequestError) || error.status !== 403) {
    return false;
  }
  const parsed = error.parsedBody;
  return (
    parsed?.type === 'permission_error' &&
    typeof parsed.message === 'string' &&
    /premium models require a paid plan or token-credit balance/i.test(
      parsed.message,
    )
  );
}

export function isHybridAIEmptyVisibleCompletion(
  response: ChatCompletionResponse,
): boolean {
  const choice = response.choices[0];
  if (!choice) return false;
  if ((choice.message.tool_calls || []).length > 0) return false;
  return !normalizeMessageContentToText(choice.message.content);
}

export function summarizeHybridAICompletionForDebug(
  response: ChatCompletionResponse,
): string {
  const choice = response.choices[0];
  const content = choice?.message?.content ?? null;
  const contentType = Array.isArray(content)
    ? 'parts'
    : content === null
      ? 'null'
      : typeof content;
  return `id=${response.id || 'null'} model=${response.model || 'null'} finish=${choice?.finish_reason || 'null'} contentType=${contentType}`;
}

export function logModelResponseDebug(params: {
  provider: RuntimeProvider | undefined;
  model: string;
  kind:
    | 'raw_non_streaming_response'
    | 'raw_streaming_response'
    | 'non_streaming_response'
    | 'streaming_response';
  response: unknown;
}): void {
  try {
    emitModelResponseDebugFileText(
      `[model-response-debug] ${JSON.stringify({
        provider: params.provider || 'hybridai',
        model: params.model,
        kind: params.kind,
        response: params.response,
      })}\n`,
    );
  } catch (err) {
    emitModelResponseDebugFileText(
      `[model-response-debug] failed to serialize response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function emitModelResponseDebugFileText(text: string): void {
  console.error(
    `[model-response-debug-file] ${Buffer.from(text, 'utf-8').toString('base64')}`,
  );
}

export function emitRawSsePayloadDebug(
  args: NormalizedCallArgs,
  payloadText: string,
): void {
  if (!args.debugModelResponses) return;
  emitModelResponseDebugFileText(`data: ${payloadText}\n\n`);
}

export function emitRawSseLineDebug(
  args: NormalizedCallArgs,
  rawLine: string,
): void {
  if (!args.debugModelResponses) return;
  const normalized = rawLine.replace(/\r$/, '');
  if (!normalized.trimStart().startsWith('data:')) return;
  emitModelResponseDebugFileText(`${normalized}\n\n`);
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
  if (isRuntimeProvider(rawArgs[0])) {
    return {
      provider: rawArgs[0],
      baseUrl: String(rawArgs[1] || ''),
      apiKey: String(rawArgs[2] || ''),
      providerMethod: typeof rawArgs[3] === 'string' ? rawArgs[3] : undefined,
      model: String(rawArgs[4] || ''),
      chatbotId: String(rawArgs[5] || ''),
      enableRag: Boolean(rawArgs[6]),
      requestHeaders: isStringRecord(rawArgs[7]) ? rawArgs[7] : undefined,
      messages: (rawArgs[8] as ChatMessage[]) || [],
      tools: (rawArgs[9] as ToolDefinition[]) || [],
      maxTokens: typeof rawArgs[10] === 'number' ? rawArgs[10] : undefined,
      isLocal: Boolean(rawArgs[11]),
      contextWindow: typeof rawArgs[12] === 'number' ? rawArgs[12] : undefined,
      thinkingFormat: rawArgs[13] === 'qwen' ? 'qwen' : undefined,
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
  if (isRuntimeProvider(rawArgs[0])) {
    const onActivity =
      typeof rawArgs[11] === 'function'
        ? (rawArgs[11] as () => void)
        : () => undefined;
    const maxTokensIndex = typeof rawArgs[11] === 'function' ? 12 : 11;
    const isLocalIndex = maxTokensIndex + 1;
    const contextWindowIndex = maxTokensIndex + 2;
    const thinkingFormatIndex = maxTokensIndex + 3;
    return {
      provider: rawArgs[0],
      baseUrl: String(rawArgs[1] || ''),
      apiKey: String(rawArgs[2] || ''),
      providerMethod: typeof rawArgs[3] === 'string' ? rawArgs[3] : undefined,
      model: String(rawArgs[4] || ''),
      chatbotId: String(rawArgs[5] || ''),
      enableRag: Boolean(rawArgs[6]),
      requestHeaders: isStringRecord(rawArgs[7]) ? rawArgs[7] : undefined,
      messages: (rawArgs[8] as ChatMessage[]) || [],
      tools: (rawArgs[9] as ToolDefinition[]) || [],
      onTextDelta: (rawArgs[10] as (delta: string) => void) || (() => {}),
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
