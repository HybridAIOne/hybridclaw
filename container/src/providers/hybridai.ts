import { stripHybridAIModelPrefix } from '../../shared/model-names.js';
import type { ChatCompletionResponse, ToolCall } from '../types.js';
import {
  buildRequestHeaders,
  emitRawSseLineDebug,
  logModelResponseDebug,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  ProviderRequestError,
} from './shared.js';
import { readWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from './stream-utils.js';

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface StreamChoiceChunk {
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: StreamToolCallDelta[];
  };
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string | null;
}

interface StreamChunkPayload {
  id?: string;
  model?: string;
  usage?: ChatCompletionResponse['usage'];
  choices?: StreamChoiceChunk[];
}

function buildHybridAIRequestBody(
  args: NormalizedCallArgs,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: stripHybridAIModelPrefix(args.model),
    chatbot_id: args.chatbotId,
    messages: args.messages,
    tools: args.tools,
    tool_choice: 'auto',
    enable_rag: args.enableRag,
  };
  if (
    typeof args.maxTokens === 'number' &&
    Number.isFinite(args.maxTokens) &&
    args.maxTokens > 0
  ) {
    request.max_tokens = Math.floor(args.maxTokens);
  }
  return request;
}

function parseStreamPayloadLine(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(':')) return null;
  if (trimmed.startsWith('event:')) return null;
  if (trimmed.startsWith('id:')) return null;
  if (trimmed.startsWith('data:')) {
    return trimmed.slice(5).trim();
  }
  return trimmed;
}

function ensureToolCall(toolCalls: ToolCall[], index: number): ToolCall {
  while (toolCalls.length <= index) {
    toolCalls.push({
      id: '',
      type: 'function',
      function: {
        name: '',
        arguments: '',
      },
    });
  }
  return toolCalls[index];
}

function mergeToolCallDelta(
  target: ToolCall,
  delta: StreamToolCallDelta,
): void {
  if (typeof delta.id === 'string' && delta.id) {
    target.id = target.id ? `${target.id}${delta.id}` : delta.id;
  }
  if (typeof delta.type === 'string') {
    target.type = delta.type;
  }
  if (!delta.function) return;
  if (typeof delta.function.name === 'string' && delta.function.name) {
    target.function.name = target.function.name
      ? `${target.function.name}${delta.function.name}`
      : delta.function.name;
  }
  if (
    typeof delta.function.arguments === 'string' &&
    delta.function.arguments
  ) {
    target.function.arguments += delta.function.arguments;
  }
}

export async function callHybridAIProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${args.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: buildRequestHeaders(args.apiKey, args.requestHeaders),
    body: JSON.stringify(buildHybridAIRequestBody(args)),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderRequestError(response.status, text);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  if (args.debugModelResponses) {
    logModelResponseDebug({
      provider: args.provider,
      model: args.model,
      kind: 'raw_non_streaming_response',
      response: payload,
    });
  }
  return payload;
}

export async function callHybridAIProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  const body = {
    ...buildHybridAIRequestBody(args),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };

  const response = await fetch(`${args.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      ...buildRequestHeaders(args.apiKey, args.requestHeaders),
      Accept: 'text/event-stream, application/x-ndjson, application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderRequestError(response.status, text);
  }

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    contentType.includes('application/json') &&
    !contentType.includes('ndjson') &&
    !contentType.includes('event-stream')
  ) {
    const payload = (await response.json()) as ChatCompletionResponse;
    if (args.debugModelResponses) {
      logModelResponseDebug({
        provider: args.provider,
        model: args.model,
        kind: 'raw_non_streaming_response',
        response: payload,
      });
    }
    return payload;
  }

  if (!response.body) {
    const payload = (await response.json()) as ChatCompletionResponse;
    if (args.debugModelResponses) {
      logModelResponseDebug({
        provider: args.provider,
        model: args.model,
        kind: 'raw_non_streaming_response',
        response: payload,
      });
    }
    return payload;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let streamId = '';
  let streamModel = stripHybridAIModelPrefix(args.model);
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse['usage'] | undefined;
  let role = 'assistant';
  let textContent = '';
  const toolCalls: ToolCall[] = [];
  const rawStreamPayloads: unknown[] = [];
  let sawPayload = false;
  let streamDone = false;

  const consumePayload = (payloadText: string): void => {
    if (!payloadText || payloadText === '[DONE]') {
      if (payloadText === '[DONE]') streamDone = true;
      return;
    }

    let payload: StreamChunkPayload;
    try {
      payload = JSON.parse(payloadText) as StreamChunkPayload;
    } catch {
      return;
    }

    if (args.debugModelResponses) rawStreamPayloads.push(payload);
    args.onActivity?.();
    sawPayload = true;
    if (typeof payload.id === 'string' && payload.id) streamId = payload.id;
    if (typeof payload.model === 'string' && payload.model) {
      streamModel = payload.model;
    }
    if (payload.usage && typeof payload.usage === 'object') {
      usage = payload.usage;
    }

    const choice = Array.isArray(payload.choices)
      ? payload.choices[0]
      : undefined;
    if (!choice) return;

    let usedMessageContent = false;
    if (choice.message) {
      const message = choice.message;
      if (typeof message.role === 'string' && message.role) role = message.role;
      if (typeof message.content === 'string') {
        const nextContent = message.content;
        const messageDelta = nextContent
          ? nextContent.startsWith(textContent)
            ? nextContent.slice(textContent.length)
            : nextContent
          : '';
        if (messageDelta) {
          textContent = nextContent;
          usedMessageContent = true;
          args.onTextDelta(messageDelta);
        }
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        toolCalls.length = 0;
        for (const call of message.tool_calls) {
          toolCalls.push({
            id: call.id || '',
            type: call.type || 'function',
            function: {
              name: call.function?.name || '',
              arguments: call.function?.arguments || '',
            },
          });
        }
      }
    }

    if (choice.delta) {
      const delta = choice.delta;
      if (typeof delta.role === 'string' && delta.role) role = delta.role;
      if (
        !usedMessageContent &&
        typeof delta.content === 'string' &&
        delta.content
      ) {
        textContent += delta.content;
        args.onTextDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        for (const callDelta of delta.tool_calls) {
          const index =
            typeof callDelta.index === 'number' && callDelta.index >= 0
              ? callDelta.index
              : 0;
          mergeToolCallDelta(ensureToolCall(toolCalls, index), callDelta);
        }
      }
    }

    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  };

  try {
    while (!streamDone) {
      const { done, value } = await readWithIdleTimeout(
        reader,
        STREAM_IDLE_TIMEOUT_MS,
      );
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        emitRawSseLineDebug(args, rawLine);
        const payloadText = parseStreamPayloadLine(rawLine);
        if (!payloadText) continue;
        consumePayload(payloadText);
        if (streamDone) break;
      }
    }

    if (!streamDone && buffer.trim()) {
      emitRawSseLineDebug(args, buffer);
      const payloadText = parseStreamPayloadLine(buffer);
      if (payloadText) consumePayload(payloadText);
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }

  if (!sawPayload) {
    throw new Error('Streaming response ended without payload');
  }

  if (args.debugModelResponses) {
    logModelResponseDebug({
      provider: args.provider,
      model: args.model,
      kind: 'raw_streaming_response',
      response: rawStreamPayloads,
    });
  }

  return {
    id: streamId || 'stream',
    model: streamModel,
    choices: [
      {
        message: {
          role,
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
