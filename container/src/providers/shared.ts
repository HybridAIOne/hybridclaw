import type { ReasoningEffort } from '../../shared/reasoning-effort.js';
import type { ModelBehavior, ModelThinkingFormat } from '../model-behavior.js';
import { normalizeMessageContentToText } from '../ralph.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ContainerInput,
  ToolDefinition,
} from '../types.js';
import type { RuntimeProvider } from './provider-ids.js';

export type { RuntimeProvider } from './provider-ids.js';

export interface NormalizedCallArgs {
  sessionId?: string;
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
  modelBehavior?: ModelBehavior;
  thinkingFormat: ModelThinkingFormat | undefined;
  reasoningEffort?: ReasoningEffort;
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
    return 'Premium model access requires a paid plan or token-credit balance. The non-premium HybridAI model is `gpt-6-luna`; use `/model set gpt-6-luna`, add credits, or switch to a configured `huggingface/...`, `openrouter/...`, or `openai-codex/...` model.';
  }
  return message;
}

export class ProviderRequestError extends Error {
  status: number;
  body: string;
  /** The wait the provider asked for in Retry-After, when it sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, body: string, retryAfterMs?: number) {
    super(
      `Provider API error ${status}: ${summarizeParsedErrorBody(parseProviderErrorBody(body))}`,
    );
    this.name = 'ProviderRequestError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** `retry-after-ms`, or `retry-after` as delta-seconds or an HTTP date. */
export function readRetryAfterMs(headers: Headers): number | undefined {
  const milliseconds = headers.get('retry-after-ms')?.trim();
  if (milliseconds && Number.isFinite(Number(milliseconds))) {
    return Math.max(0, Number(milliseconds));
  }
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function isHybridAIEmptyVisibleCompletion(
  response: ChatCompletionResponse,
): boolean {
  const choice = response.choices[0];
  if (!choice) return false;
  if ((choice.message.tool_calls || []).length > 0) return false;
  return !normalizeMessageContentToText(choice.message.content).trim();
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

export function logLastPrompt(params: {
  sessionId?: string;
  provider: RuntimeProvider | undefined;
  model: string;
  kind: string;
  request: unknown;
}): void {
  try {
    const text = `${JSON.stringify(
      {
        ts: new Date().toISOString(),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        provider: params.provider || 'hybridai',
        model: params.model,
        kind: params.kind,
        request: params.request,
      },
      function (key, value: unknown) {
        // Binary documents and pixels are not useful in diagnostic prompt dumps.
        if (
          typeof value === 'string' &&
          (/^data:[^,]*;base64,/i.test(value) ||
            (key === 'data' && this.type === 'base64'))
        )
          return '[binary omitted]';
        if (key === 'images' && Array.isArray(value))
          return value.map(() => '[binary omitted]');
        return value;
      },
    )}\n`;
    console.error(
      `[last-prompt-file] ${Buffer.from(text, 'utf-8').toString('base64')}`,
    );
  } catch {
    // Prompt dumping is diagnostic-only and must not disrupt model execution.
  }
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

export function emitRawNdjsonLineDebug(
  args: NormalizedCallArgs,
  rawLine: string,
): void {
  if (!args.debugModelResponses) return;
  const normalized = rawLine.replace(/\r$/, '');
  if (!normalized.trim()) return;
  emitModelResponseDebugFileText(`${normalized}\n`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readStringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const HYBRIDAI_CORRELATION_HEADERS = {
  sessionId: 'X-HybridClaw-Session-Id',
  runId: 'X-HybridClaw-Run-Id',
  agentId: 'X-HybridClaw-Agent-Id',
  channelId: 'X-HybridClaw-Channel-Id',
  client: 'X-HybridClaw-Client',
} as const;

type HybridAICorrelationKey = keyof typeof HYBRIDAI_CORRELATION_HEADERS;

function normalizeHeaderValue(value: string | undefined): string {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 256);
}

export function withHybridAICorrelationHeaders(
  params: Partial<Record<HybridAICorrelationKey, string>> & {
    provider: ContainerInput['provider'];
    requestHeaders?: Record<string, string>;
  },
): Record<string, string> | undefined {
  if (params.provider !== 'hybridai') return params.requestHeaders;
  const headers = { ...(params.requestHeaders || {}) };
  for (const key of Object.keys(
    HYBRIDAI_CORRELATION_HEADERS,
  ) as HybridAICorrelationKey[]) {
    const value = normalizeHeaderValue(params[key]);
    if (value) headers[HYBRIDAI_CORRELATION_HEADERS[key]] = value;
  }
  return headers;
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
