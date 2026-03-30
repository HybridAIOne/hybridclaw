import { createHash } from 'node:crypto';
import { collapseSystemMessages } from '../system-messages.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
} from '../types.js';
import {
  HybridAIRequestError,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  normalizeOpenRouterRuntimeModelName,
} from './shared.js';
import {
  createThinkingStreamEmitter,
  extractThinkingBlocks,
} from './thinking-extractor.js';
import {
  normalizeToolCalls,
  resolveToolCallTextParser,
} from './tool-call-normalizer.js';

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
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: StreamToolCallDelta[];
  };
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string | null;
}

interface StreamChunkPayload {
  id?: string;
  model?: string;
  usage?: ChatCompletionResponse['usage'];
  choices?: StreamChoiceChunk[];
  error?:
    | string
    | {
        message?: string;
        code?: string | number;
        type?: string;
      };
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (String(apiKey || '').trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }
  return headers;
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
}

function normalizeLocalModelName(
  provider: string | undefined,
  model: string,
): string {
  const trimmed = String(model || '').trim();
  if (!provider || provider === 'hybridai' || provider === 'openai-codex') {
    return trimmed;
  }
  if (provider === 'openrouter') {
    return normalizeOpenRouterRuntimeModelName(trimmed);
  }
  if (provider === 'huggingface') {
    const prefix = 'huggingface/';
    if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
    return trimmed.slice(prefix.length) || trimmed;
  }
  const prefix = `${provider}/`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  return trimmed.slice(prefix.length) || trimmed;
}

function isMistralCompatModel(
  provider: string | undefined,
  model: string,
): boolean {
  if (
    provider !== 'mistral' &&
    provider !== 'vllm' &&
    provider !== 'lmstudio'
  ) {
    return false;
  }
  const normalizedModel = normalizeLocalModelName(provider, model)
    .trim()
    .toLowerCase();
  return (
    normalizedModel.includes('mistral') ||
    normalizedModel.includes('ministral') ||
    normalizedModel.includes('devstral')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function usesQwenCompat(args: {
  provider: string | undefined;
  model: string;
  thinkingFormat?: 'qwen';
}): boolean {
  if (args.thinkingFormat === 'qwen') return true;
  if (args.provider !== 'lmstudio' && args.provider !== 'vllm') return false;
  const normalizedModel = normalizeLocalModelName(args.provider, args.model)
    .trim()
    .toLowerCase();
  return normalizedModel.includes('qwen') || normalizedModel.includes('qwq');
}

function resolveStopSequences(args: NormalizedCallArgs): string[] | undefined {
  if (!usesQwenCompat(args)) return undefined;
  return ['<|im_end|>', '<|im_start|>'];
}

function normalizeMessageContent(
  content: ChatMessage['content'],
): ChatMessage['content'] {
  return content;
}

function buildQwenRequestMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  return collapseSystemMessages(messages).map((message) => ({
    ...message,
    content: normalizeMessageContent(message.content),
  }));
}

function shortHash(text: string, length: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

function sanitizeStrict9ToolCallId(value: string, used: Set<string>): string {
  const alphanumeric = String(value || '').replace(/[^a-zA-Z0-9]/g, '');
  if (alphanumeric.length >= 9) {
    const candidate = alphanumeric.slice(0, 9);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  for (let index = 0; index < 1000; index += 1) {
    const candidate = shortHash(`${value}:${index}`, 9);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  const fallback = shortHash(`${value}:${Date.now()}`, 9);
  used.add(fallback);
  return fallback;
}

function sanitizeMistralToolCallIds(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const resolveId = (value: string): string => {
    const existing = idMap.get(value);
    if (existing) return existing;
    const next = sanitizeStrict9ToolCallId(value, used);
    idMap.set(value, next);
    return next;
  };

  return messages.map((message) => {
    let changed = false;
    let nextMessage: Record<string, unknown> = message;

    if (Array.isArray(message.tool_calls)) {
      const nextToolCalls = message.tool_calls.map((toolCall) => {
        if (
          !isRecord(toolCall) ||
          typeof toolCall.id !== 'string' ||
          !toolCall.id
        ) {
          return toolCall;
        }
        const nextId = resolveId(toolCall.id);
        if (nextId === toolCall.id) return toolCall;
        changed = true;
        return { ...toolCall, id: nextId };
      });
      if (changed) {
        nextMessage = { ...nextMessage, tool_calls: nextToolCalls };
      }
    }

    if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
      const nextToolCallId = resolveId(message.tool_call_id);
      if (nextToolCallId !== message.tool_call_id) {
        changed = true;
        nextMessage = { ...nextMessage, tool_call_id: nextToolCallId };
      }
    }

    return nextMessage;
  });
}

function buildRequestMessages(
  args: NormalizedCallArgs,
): Array<Record<string, unknown>> {
  const messages = usesQwenCompat(args)
    ? buildQwenRequestMessages(args.messages)
    : collapseSystemMessages(args.messages).map((message) => ({
        ...message,
        content: normalizeMessageContent(message.content),
      }));
  return isMistralCompatModel(args.provider, args.model)
    ? sanitizeMistralToolCallIds(messages)
    : messages;
}

function buildRequestBody(args: NormalizedCallArgs): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: normalizeLocalModelName(args.provider, args.model),
    messages: buildRequestMessages(args),
    tools: args.tools,
    tool_choice: 'auto',
  };
  const stopSequences = resolveStopSequences(args);
  if (stopSequences && stopSequences.length > 0) {
    request.stop = stopSequences;
  }
  if (
    typeof args.maxTokens === 'number' &&
    Number.isFinite(args.maxTokens) &&
    args.maxTokens > 0
  ) {
    request.max_tokens = Math.floor(args.maxTokens);
  }
  return request;
}

function buildToolCallNormalizationOptions(params: {
  provider: string | undefined;
  model: string;
}) {
  const parser = resolveToolCallTextParser(
    normalizeLocalModelName(params.provider, params.model),
  );
  return {
    parser,
    recoverBlankStructuredNameFromContent: parser === 'mistral',
  };
}

function parseStreamPayloadLine(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) {
    return null;
  }
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

function normalizeContentToText(
  content: ChatMessage['content'],
): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type !== 'text' || !part.text) continue;
    chunks.push(part.text);
  }
  const text = chunks.join('\n');
  return text || null;
}

function extractStructuredReasoning(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidates = [value.reasoning_content, value.reasoning];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

function combineReasoningAndContent(
  content: ChatMessage['content'],
  reasoning: string | null,
): string | null {
  const visibleContent = normalizeContentToText(content) || null;
  if (!reasoning) return visibleContent;
  return visibleContent
    ? `<think>${reasoning}</think>${visibleContent}`
    : `<think>${reasoning}</think>`;
}

function extractProviderErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const errorValue = payload.error;
  if (typeof errorValue === 'string' && errorValue.trim()) {
    return errorValue.trim();
  }
  if (!isRecord(errorValue)) return null;
  const message =
    typeof errorValue.message === 'string' ? errorValue.message.trim() : '';
  if (message) return message;
  const type =
    typeof errorValue.type === 'string' ? errorValue.type.trim() : '';
  const code =
    typeof errorValue.code === 'string' || typeof errorValue.code === 'number'
      ? String(errorValue.code).trim()
      : '';
  const detail = [type, code].filter(Boolean).join(' ');
  return detail || null;
}

function assertNoProviderError(payload: unknown): void {
  const errorMessage = extractProviderErrorMessage(payload);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
}

function adaptLocalOpenAICompatResponse(
  payload: ChatCompletionResponse,
  params: {
    provider: string | undefined;
    model: string;
  },
): ChatCompletionResponse {
  assertNoProviderError(payload);
  const choice = payload.choices[0];
  const message = choice?.message;
  const rawContent = combineReasoningAndContent(
    message?.content,
    extractStructuredReasoning(message),
  );
  const thinking = extractThinkingBlocks(rawContent);
  const normalized = normalizeToolCalls(
    message?.tool_calls,
    thinking.content,
    buildToolCallNormalizationOptions(params),
  );
  return {
    ...payload,
    choices: [
      {
        ...choice,
        message: {
          role: message?.role || 'assistant',
          content: normalized.content,
          ...(normalized.toolCalls.length > 0
            ? { tool_calls: normalized.toolCalls }
            : {}),
        },
        finish_reason:
          choice?.finish_reason ||
          (normalized.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      },
    ],
  };
}

function emitResponseTextDeltas(
  response: ChatCompletionResponse,
  onTextDelta: (delta: string) => void,
): void {
  const content = response.choices[0]?.message?.content;
  if (typeof content === 'string') {
    if (content) onTextDelta(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part.type === 'text' && part.text) onTextDelta(part.text);
  }
}

export async function callLocalOpenAICompatProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  const response = await fetch(
    `${normalizeBaseUrl(args.baseUrl)}/chat/completions`,
    {
      method: 'POST',
      headers: {
        ...buildHeaders(args.apiKey),
        ...(args.requestHeaders || {}),
      },
      body: JSON.stringify(buildRequestBody(args)),
    },
  );

  if (!response.ok) {
    throw new HybridAIRequestError(response.status, await response.text());
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  assertNoProviderError(payload);
  return adaptLocalOpenAICompatResponse(payload, {
    provider: args.provider,
    model: args.model,
  });
}

export async function callLocalOpenAICompatProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  const response = await fetch(
    `${normalizeBaseUrl(args.baseUrl)}/chat/completions`,
    {
      method: 'POST',
      headers: {
        ...buildHeaders(args.apiKey),
        ...(args.requestHeaders || {}),
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({
        ...buildRequestBody(args),
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new HybridAIRequestError(response.status, await response.text());
  }

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    contentType.includes('application/json') &&
    !contentType.includes('event-stream')
  ) {
    const payload = (await response.json()) as ChatCompletionResponse;
    assertNoProviderError(payload);
    const adapted = adaptLocalOpenAICompatResponse(payload, {
      provider: args.provider,
      model: args.model,
    });
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
  }

  if (!response.body) {
    const payload = (await response.json()) as ChatCompletionResponse;
    assertNoProviderError(payload);
    const adapted = adaptLocalOpenAICompatResponse(payload, {
      provider: args.provider,
      model: args.model,
    });
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const streamEmitter = createThinkingStreamEmitter(args.onTextDelta);

  let buffer = '';
  let streamId = '';
  let streamModel = normalizeLocalModelName(args.provider, args.model);
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse['usage'] | undefined;
  let role = 'assistant';
  let rawTextContent = '';
  let rawReasoningContent = '';
  const toolCalls: ToolCall[] = [];
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

    assertNoProviderError(payload);
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

    if (choice.message) {
      if (typeof choice.message.role === 'string' && choice.message.role) {
        role = choice.message.role;
      }
      if (typeof choice.message.content === 'string') {
        const nextRawContent = choice.message.content;
        const delta = nextRawContent.startsWith(rawTextContent)
          ? nextRawContent.slice(rawTextContent.length)
          : nextRawContent;
        rawTextContent = nextRawContent;
        if (delta) {
          if (/[<]\/?think[>]/i.test(delta)) {
            streamEmitter.pushRaw(delta);
          } else {
            streamEmitter.pushVisible(delta);
          }
        }
      }
      const messageReasoning = extractStructuredReasoning(choice.message);
      if (messageReasoning) {
        const reasoningDelta = messageReasoning.startsWith(rawReasoningContent)
          ? messageReasoning.slice(rawReasoningContent.length)
          : messageReasoning;
        rawReasoningContent = messageReasoning;
        if (reasoningDelta) {
          streamEmitter.pushThinking(reasoningDelta);
        }
      }
      if (
        Array.isArray(choice.message.tool_calls) &&
        choice.message.tool_calls.length > 0
      ) {
        toolCalls.length = 0;
        for (const call of choice.message.tool_calls) {
          toolCalls.push({
            id: call.id || '',
            type: 'function',
            function: {
              name: call.function?.name || '',
              arguments: call.function?.arguments || '',
            },
          });
        }
      }
    }

    if (choice.delta) {
      if (typeof choice.delta.role === 'string' && choice.delta.role) {
        role = choice.delta.role;
      }
      if (typeof choice.delta.content === 'string' && choice.delta.content) {
        rawTextContent += choice.delta.content;
        if (/[<]\/?think[>]/i.test(choice.delta.content)) {
          streamEmitter.pushRaw(choice.delta.content);
        } else {
          streamEmitter.pushVisible(choice.delta.content);
        }
      }
      const deltaReasoning = extractStructuredReasoning(choice.delta);
      if (deltaReasoning) {
        rawReasoningContent += deltaReasoning;
        streamEmitter.pushThinking(deltaReasoning);
      }
      if (
        Array.isArray(choice.delta.tool_calls) &&
        choice.delta.tool_calls.length > 0
      ) {
        for (const callDelta of choice.delta.tool_calls) {
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
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const payloadText = parseStreamPayloadLine(rawLine);
        if (!payloadText) continue;
        consumePayload(payloadText);
        if (streamDone) break;
      }
    }

    if (!streamDone && buffer.trim()) {
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

  streamEmitter.close();

  return adaptLocalOpenAICompatResponse(
    {
      id: streamId || 'stream',
      model: streamModel,
      choices: [
        {
          message: {
            role,
            content: combineReasoningAndContent(
              rawTextContent || null,
              rawReasoningContent || null,
            ),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason:
            finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        },
      ],
      ...(usage ? { usage } : {}),
    },
    {
      provider: args.provider,
      model: args.model,
    },
  );
}
