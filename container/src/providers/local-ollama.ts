import type {
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import {
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  ProviderRequestError,
} from './shared.js';
import {
  createThinkingStreamEmitter,
  extractThinkingBlocks,
} from './thinking-extractor.js';
import {
  normalizeToolCalls,
  resolveToolCallTextParser,
} from './tool-call-normalizer.js';

interface OllamaChatMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

interface OllamaStreamPayload {
  model?: string;
  done?: boolean;
  done_reason?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: unknown[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '')
    .replace(/\/v1$/i, '');
}

function normalizeOllamaModelName(model: string): string {
  const trimmed = String(model || '').trim();
  if (!trimmed.toLowerCase().startsWith('ollama/')) return trimmed;
  return trimmed.slice('ollama/'.length) || trimmed;
}

function normalizeMessageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function extractDataUriImagePayload(url: string): string | null {
  const match = String(url || '').match(
    /^data:[^;]+;base64,([A-Za-z0-9+/=]+)$/i,
  );
  return match?.[1] || null;
}

function convertToolCallArguments(
  rawArguments: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function convertMessage(message: ChatMessage): OllamaChatMessage {
  const converted: OllamaChatMessage = {
    role: message.role,
    content: normalizeMessageText(message.content),
  };

  if (Array.isArray(message.content)) {
    const images = message.content
      .filter((part) => part.type === 'image_url')
      .map((part) => extractDataUriImagePayload(part.image_url.url))
      .filter((value): value is string => Boolean(value));
    if (images.length > 0) {
      converted.images = images;
    }
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    converted.tool_calls = message.tool_calls.map((toolCall) => ({
      function: {
        name: toolCall.function.name,
        arguments: convertToolCallArguments(toolCall.function.arguments),
      },
    }));
  }

  return converted;
}

function convertTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools;
}

function buildRequestBody(
  args: NormalizedCallArgs,
  stream: boolean,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: normalizeOllamaModelName(args.model),
    messages: args.messages.map(convertMessage),
    tools: convertTools(args.tools),
    stream,
  };
  if (
    typeof args.maxTokens === 'number' &&
    Number.isFinite(args.maxTokens) &&
    args.maxTokens > 0
  ) {
    request.options = {
      num_predict: Math.floor(args.maxTokens),
    };
  }
  return request;
}

function buildUsage(
  payload: OllamaStreamPayload,
): ChatCompletionResponse['usage'] | undefined {
  const promptTokens =
    typeof payload.prompt_eval_count === 'number'
      ? payload.prompt_eval_count
      : 0;
  const completionTokens =
    typeof payload.eval_count === 'number' ? payload.eval_count : 0;
  if (promptTokens === 0 && completionTokens === 0) return undefined;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function finalizeContent(
  rawContent: string,
  thinkingText: string,
): string | null {
  const extracted = extractThinkingBlocks(rawContent);
  if (extracted.content && extracted.content !== 'Done.') {
    return extracted.content;
  }
  if (thinkingText.trim()) return 'Done.';
  return extracted.content;
}

function finalizeToolCalls(
  rawToolCalls: unknown[] | undefined,
  content: string | null,
  model: string | undefined,
): { content: string | null; toolCalls: ToolCall[] } {
  const parser = resolveToolCallTextParser(model);
  return normalizeToolCalls(rawToolCalls as ToolCall[] | undefined, content, {
    parser,
    recoverBlankStructuredNameFromContent: parser === 'mistral',
  });
}

function adaptOllamaPayload(
  payload: OllamaStreamPayload,
  rawContent: string,
  thinkingText: string,
  rawToolCalls: unknown[] | undefined,
): ChatCompletionResponse {
  const content = finalizeContent(rawContent, thinkingText);
  const normalized = finalizeToolCalls(rawToolCalls, content, payload.model);
  const usage = buildUsage(payload);
  return {
    id: 'ollama',
    model: payload.model || '',
    choices: [
      {
        message: {
          role: payload.message?.role || 'assistant',
          content: normalized.content,
          ...(normalized.toolCalls.length > 0
            ? { tool_calls: normalized.toolCalls }
            : {}),
        },
        finish_reason:
          payload.done_reason ||
          (normalized.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function emitResponseTextDeltas(
  response: ChatCompletionResponse,
  onTextDelta: (delta: string) => void,
): void {
  const content = response.choices[0]?.message?.content;
  if (typeof content === 'string' && content) onTextDelta(content);
}

export async function callOllamaProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${normalizeBaseUrl(args.baseUrl)}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(args.requestHeaders || {}),
    },
    body: JSON.stringify(buildRequestBody(args, false)),
  });

  if (!response.ok) {
    throw new ProviderRequestError(response.status, await response.text());
  }

  const payload = (await response.json()) as OllamaStreamPayload;
  return adaptOllamaPayload(
    payload,
    payload.message?.content || '',
    payload.message?.thinking || '',
    payload.message?.tool_calls,
  );
}

export async function callOllamaProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${normalizeBaseUrl(args.baseUrl)}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson, application/json',
      ...(args.requestHeaders || {}),
    },
    body: JSON.stringify(buildRequestBody(args, true)),
  });

  if (!response.ok) {
    throw new ProviderRequestError(response.status, await response.text());
  }

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (contentType.includes('application/json') || !response.body) {
    const adapted = await callOllamaProvider(args);
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const streamEmitter = createThinkingStreamEmitter(args.onTextDelta);

  let buffer = '';
  let sawPayload = false;
  let rawContent = '';
  let thinkingText = '';
  let latestPayload: OllamaStreamPayload = {};
  let rawToolCalls: unknown[] | undefined;
  let streamDone = false;

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let payload: OllamaStreamPayload;
        try {
          payload = JSON.parse(trimmed) as OllamaStreamPayload;
        } catch {
          continue;
        }

        args.onActivity?.();
        sawPayload = true;
        latestPayload = payload;
        if (
          typeof payload.message?.content === 'string' &&
          payload.message.content
        ) {
          rawContent += payload.message.content;
          if (/[<]\/?think[>]/i.test(payload.message.content)) {
            streamEmitter.pushRaw(payload.message.content);
          } else {
            streamEmitter.pushVisible(payload.message.content);
          }
        }
        if (
          typeof payload.message?.thinking === 'string' &&
          payload.message.thinking
        ) {
          thinkingText += payload.message.thinking;
          streamEmitter.pushThinking(payload.message.thinking);
        }
        if (
          Array.isArray(payload.message?.tool_calls) &&
          payload.message.tool_calls.length > 0
        ) {
          rawToolCalls = payload.message.tool_calls;
        }
        if (payload.done) {
          streamDone = true;
          break;
        }
      }
    }

    if (!streamDone && buffer.trim()) {
      try {
        const payload = JSON.parse(buffer.trim()) as OllamaStreamPayload;
        args.onActivity?.();
        sawPayload = true;
        latestPayload = payload;
        if (
          typeof payload.message?.content === 'string' &&
          payload.message.content
        ) {
          rawContent += payload.message.content;
          if (/[<]\/?think[>]/i.test(payload.message.content)) {
            streamEmitter.pushRaw(payload.message.content);
          } else {
            streamEmitter.pushVisible(payload.message.content);
          }
        }
        if (
          typeof payload.message?.thinking === 'string' &&
          payload.message.thinking
        ) {
          thinkingText += payload.message.thinking;
          streamEmitter.pushThinking(payload.message.thinking);
        }
        if (
          Array.isArray(payload.message?.tool_calls) &&
          payload.message.tool_calls.length > 0
        ) {
          rawToolCalls = payload.message.tool_calls;
        }
      } catch {
        // Ignore trailing parse failure.
      }
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }

  if (!sawPayload) {
    throw new Error('Streaming response ended without payload');
  }

  streamEmitter.close();

  return adaptOllamaPayload(
    latestPayload,
    rawContent,
    thinkingText,
    rawToolCalls,
  );
}
