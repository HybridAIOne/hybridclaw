/**
 * Compatible API transport preserves tool calls, reasoning, and finish reasons.
 * Final answers take precedence over reasoning-only call recovery.
 * MLX streams keep thought observable; context budgets remain caller-owned.
 * Explicit vLLM Qwen effort `none` disables thinking on the wire.
 */
import { createHash } from 'node:crypto';
import { resolveModelBehavior } from '@hybridclaw/shared/model-behavior';
import { normalizeOpenAICompatModelName } from '@hybridclaw/shared/model-names';
import { isRecord } from '@hybridclaw/shared/primitive-values';
import {
  applyChatCompletionsChunk,
  buildChatCompletionsBody,
  collapseSystemMessages,
  createChatCompletionsStreamState,
  extractStructuredReasoning,
} from '@hybridclaw/shared/provider-wire/chat-completions';
import { replaceUnpairedSurrogates } from '@hybridclaw/shared/unicode-utils';
import {
  finalizeParsedToolCalls,
  INCOMPLETE_RESPONSE,
} from '../model-response-completion.js';
import { mergeSystemMessage } from '../system-messages.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ToolDefinition,
} from '../types.js';
import { fetchMlx } from './mlx-transport.js';
import {
  emitRawSseLineDebug,
  logLastPrompt,
  logModelResponseDebug,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  ProviderRequestError,
  readRetryAfterMs,
} from './shared.js';
import {
  emitResponseTextDeltas,
  fetchWithHeaderTimeout,
  readJsonWithIdleTimeout,
  readWithIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS,
} from './stream-utils.js';
import {
  createThinkingStreamEmitter,
  extractThinkingBlocks,
} from './thinking-extractor.js';
import {
  normalizeToolCalls,
  resolveToolCallTextParser,
} from './tool-call-normalizer.js';

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

function isMistralCompatModel(
  provider: string | undefined,
  model: string,
): boolean {
  if (
    provider !== 'mistral' &&
    provider !== 'vllm' &&
    provider !== 'lmstudio' &&
    provider !== 'llamacpp'
  ) {
    return false;
  }
  const normalizedModel = normalizeOpenAICompatModelName(provider, model)
    .trim()
    .toLowerCase();
  return (
    normalizedModel.includes('mistral') ||
    normalizedModel.includes('ministral') ||
    normalizedModel.includes('devstral')
  );
}

function usesQwenCompat(args: {
  provider?: string;
  model?: string;
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
  thinkingFormat?: 'qwen';
}): boolean {
  const behavior = resolveModelBehavior({
    model: args.model
      ? normalizeOpenAICompatModelName(args.provider, args.model)
      : undefined,
    configured: args.modelBehavior,
  });
  if (behavior?.thinkingFormat === 'qwen') return true;
  if (args.thinkingFormat === 'qwen') return true;
  return false;
}

function usesLiquidCompat(args: {
  provider: string | undefined;
  model: string;
}): boolean {
  return (
    resolveToolCallTextParser(
      normalizeOpenAICompatModelName(args.provider, args.model),
    ) === 'liquid'
  );
}

function buildLiquidToolCallInstruction(tools: ToolDefinition[]): string {
  const toolList = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  return `List of tools: ${JSON.stringify(toolList)}`;
}

function estimatePromptToolInstructionTokens(instruction: string): number {
  if (!instruction) return 0;
  return Math.max(1, Math.ceil(instruction.length / 4) + 16);
}

export function estimateLocalOpenAICompatPromptOverheadTokens(args: {
  provider: string | undefined;
  model: string;
  tools?: ToolDefinition[];
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
}): number {
  const tools = Array.isArray(args.tools) ? args.tools : [];
  if (tools.length === 0) return 0;
  if (usesLiquidCompat(args)) {
    return estimatePromptToolInstructionTokens(
      buildLiquidToolCallInstruction(tools),
    );
  }
  return 0;
}

function normalizeMessageContent(
  content: ChatMessage['content'],
): ChatMessage['content'] {
  if (typeof content === 'string') return replaceUnpairedSurrogates(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === 'text') {
      return { ...part, text: replaceUnpairedSurrogates(part.text) };
    }
    if (part.type === 'image_url') {
      return {
        ...part,
        image_url: {
          url: replaceUnpairedSurrogates(part.image_url.url),
        },
      };
    }
    if (part.type === 'audio_url') {
      return {
        ...part,
        audio_url: {
          url: replaceUnpairedSurrogates(part.audio_url.url),
        },
      };
    }
    return part;
  });
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
  let messages = usesQwenCompat(args)
    ? buildQwenRequestMessages(args.messages)
    : collapseSystemMessages(args.messages).map((message) => ({
        ...message,
        content: normalizeMessageContent(message.content),
      }));
  if (
    usesLiquidCompat(args) &&
    Array.isArray(args.tools) &&
    args.tools.length
  ) {
    messages = mergeSystemMessage(
      messages as ChatMessage[],
      buildLiquidToolCallInstruction(args.tools),
    ).map((message) => ({
      ...message,
      content: normalizeMessageContent(message.content),
    }));
  }
  return isMistralCompatModel(args.provider, args.model)
    ? sanitizeMistralToolCallIds(messages)
    : messages;
}

function buildRequestBody(args: NormalizedCallArgs): Record<string, unknown> {
  const request = buildChatCompletionsBody({
    model: normalizeOpenAICompatModelName(args.provider, args.model),
    messages: buildRequestMessages(args),
    tools: args.tools,
    maxTokens: args.maxTokens,
  });
  // Owner experiment, 2026-11-08: explicit non-thinking Qwen calls on vLLM.
  if (
    args.provider === 'vllm' &&
    usesQwenCompat(args) &&
    args.reasoningEffort === 'none'
  ) {
    request.chat_template_kwargs = { enable_thinking: false };
  }
  return request;
}

function buildToolCallNormalizationOptions(params: {
  provider: string | undefined;
  model: string;
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
}) {
  const parser =
    params.modelBehavior?.thinkingFormat === 'qwen'
      ? 'qwen'
      : resolveToolCallTextParser(
          normalizeOpenAICompatModelName(params.provider, params.model),
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
    modelBehavior?: NormalizedCallArgs['modelBehavior'];
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
  const normalizationOptions = buildToolCallNormalizationOptions(params);
  const hasStructuredToolCalls =
    Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  let normalized = normalizeToolCalls(
    message?.tool_calls,
    hasStructuredToolCalls && thinking.thinkingOnly ? null : thinking.content,
    normalizationOptions,
  );
  if (
    normalized.toolCalls.length === 0 &&
    thinking.thinkingOnly &&
    thinking.thinking &&
    (normalizationOptions.parser === 'qwen' ||
      normalizationOptions.parser === 'qwen3_coder')
  ) {
    const thinkingToolCalls = normalizeToolCalls(
      undefined,
      thinking.thinking,
      normalizationOptions,
    );
    if (thinkingToolCalls.toolCalls.length > 0) {
      normalized = { content: null, toolCalls: thinkingToolCalls.toolCalls };
    }
  }
  const { content, toolCalls, finishReason } = finalizeParsedToolCalls(
    normalized,
    choice?.finish_reason,
  );
  return {
    ...payload,
    choices: [
      {
        ...choice,
        message: {
          role: message?.role || 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
  };
}

function createToolMarkupStreamFilter(onTextDelta: (delta: string) => void): {
  push: (delta: string) => void;
  close: () => void;
} {
  const startMarkers = ['<tool_call>', '<tool>', '[tool_call]', '<function='];
  const endMarkerByStartMarker = new Map([
    ['<tool_call>', '</tool_call>'],
    ['<tool>', '</tool>'],
    ['[tool_call]', '[/tool_call]'],
    ['<function=', '</function>'],
  ]);
  let buffer = '';
  let insideToolMarkup = false;
  let currentEndMarker = '';

  const findEarliestMarker = (
    markers: string[],
  ): { index: number; marker: string } | null => {
    let earliest: { index: number; marker: string } | null = null;
    const lower = buffer.toLowerCase();
    for (const marker of markers) {
      const index = lower.indexOf(marker);
      if (index < 0) continue;
      if (!earliest || index < earliest.index) {
        earliest = { index, marker };
      }
    }
    return earliest;
  };
  const findPartialStartSuffixLength = (): number => {
    const lower = buffer.toLowerCase();
    let longest = 0;
    for (const marker of startMarkers) {
      const normalizedMarker = marker.toLowerCase();
      const maxLength = Math.min(normalizedMarker.length - 1, lower.length);
      for (let length = maxLength; length > longest; length -= 1) {
        if (lower.endsWith(normalizedMarker.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  };

  const stripTrailingPartialToolMarker = (text: string): string =>
    text.replace(/(?:<|<\/|<tool|<tool_|<tool_call|<function=?)$/i, '');

  const emit = (text: string): void => {
    if (text) onTextDelta(text);
  };

  const flush = (final = false): void => {
    while (buffer) {
      if (insideToolMarkup) {
        const end = findEarliestMarker([currentEndMarker]);
        if (!end) {
          buffer = final ? '' : buffer.slice(-(currentEndMarker.length - 1));
          return;
        }
        buffer = buffer.slice(end.index + end.marker.length);
        insideToolMarkup = false;
        currentEndMarker = '';
        continue;
      }

      const start = findEarliestMarker(startMarkers);
      if (start) {
        emit(stripTrailingPartialToolMarker(buffer.slice(0, start.index)));
        buffer = buffer.slice(start.index + start.marker.length);
        insideToolMarkup = true;
        currentEndMarker = endMarkerByStartMarker.get(start.marker) || '';
        continue;
      }

      const holdbackChars = final ? 0 : findPartialStartSuffixLength();
      if (!final && buffer.length <= holdbackChars) return;
      const emitLength = buffer.length - holdbackChars;
      emit(
        final
          ? stripTrailingPartialToolMarker(buffer.slice(0, emitLength))
          : buffer.slice(0, emitLength),
      );
      buffer = buffer.slice(emitLength);
      if (!final) return;
    }
  };

  return {
    push(delta: string): void {
      if (!delta) return;
      buffer += delta;
      flush();
    },
    close(): void {
      flush(true);
    },
  };
}

export async function callLocalOpenAICompatProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  if (args.provider === 'mlx') {
    return callLocalOpenAICompatProviderStream({
      ...args,
      onTextDelta: () => undefined,
    });
  }
  const requestBody = buildRequestBody(args);
  const url = `${normalizeBaseUrl(args.baseUrl)}/chat/completions`;
  if (args.debugModelResponses) {
    logLastPrompt({
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      kind: 'openai_compatible_non_streaming_request',
      request: {
        method: 'POST',
        url,
        body: requestBody,
      },
    });
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...buildHeaders(args.apiKey),
      ...(args.requestHeaders || {}),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new ProviderRequestError(
      response.status,
      await response.text(),
      readRetryAfterMs(response.headers),
    );
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
  assertNoProviderError(payload);
  return adaptLocalOpenAICompatResponse(payload, {
    provider: args.provider,
    model: args.model,
    modelBehavior: args.modelBehavior,
  });
}

export async function callLocalOpenAICompatProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  const requestBody = {
    ...buildRequestBody(args),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };
  const url = `${normalizeBaseUrl(args.baseUrl)}/chat/completions`;
  if (args.debugModelResponses) {
    logLastPrompt({
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      kind: 'openai_compatible_streaming_request',
      request: {
        method: 'POST',
        url,
        body: requestBody,
      },
    });
  }
  const requestFetch =
    args.provider === 'mlx'
      ? (url: string, init: RequestInit) => fetchMlx(url, init, args.sessionId)
      : fetch;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      ...buildHeaders(args.apiKey),
      ...(args.requestHeaders || {}),
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(requestBody),
  };
  // Local servers hold their headers through model load and prefill, which can
  // outlast the stream idle bound, so they keep the transport's own timeout.
  const response = args.isLocal
    ? await requestFetch(url, init)
    : await fetchWithHeaderTimeout((signal) =>
        requestFetch(url, { ...init, signal }),
      );

  if (!response.ok) {
    throw new ProviderRequestError(
      response.status,
      await response.text(),
      readRetryAfterMs(response.headers),
    );
  }

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    (contentType.includes('application/json') &&
      !contentType.includes('event-stream')) ||
    !response.body
  ) {
    const payload = (await readJsonWithIdleTimeout(
      response,
    )) as ChatCompletionResponse;
    if (args.debugModelResponses) {
      logModelResponseDebug({
        provider: args.provider,
        model: args.model,
        kind: 'raw_non_streaming_response',
        response: payload,
      });
    }
    assertNoProviderError(payload);
    const adapted = adaptLocalOpenAICompatResponse(payload, {
      provider: args.provider,
      model: args.model,
      modelBehavior: args.modelBehavior,
    });
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const normalizationOptions = buildToolCallNormalizationOptions({
    provider: args.provider,
    model: args.model,
    modelBehavior: args.modelBehavior,
  });
  const shouldFilterQwenMarkup =
    args.modelBehavior?.thinkingFormat === 'qwen' ||
    args.thinkingFormat === 'qwen' ||
    normalizationOptions.parser === 'qwen' ||
    normalizationOptions.parser === 'qwen3_coder';
  const streamEmitter = createThinkingStreamEmitter(args.onTextDelta, {
    onThinkingDelta: args.onThinkingDelta,
  });
  const visibleToolFilter = shouldFilterQwenMarkup
    ? createToolMarkupStreamFilter((delta) => streamEmitter.pushVisible(delta))
    : null;
  const reasoningToolFilter = shouldFilterQwenMarkup
    ? createToolMarkupStreamFilter((delta) => streamEmitter.pushThinking(delta))
    : null;
  const flushReasoningPreview = (): void => {
    reasoningToolFilter?.close();
  };

  let buffer = '';
  const state = createChatCompletionsStreamState<
    ChatCompletionResponse['usage']
  >(normalizeOpenAICompatModelName(args.provider, args.model));
  let sawPayload = false;
  let streamDone = false;

  const consumePayload = (payloadText: string): void => {
    if (payloadText === '[DONE]') {
      streamDone = true;
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText) as unknown;
    } catch {
      return;
    }
    if (!isRecord(payload)) return;

    assertNoProviderError(payload);
    args.onActivity?.();
    sawPayload = true;
    const added = applyChatCompletionsChunk(state, payload);
    if (added.content) {
      flushReasoningPreview();
      if (visibleToolFilter) {
        visibleToolFilter.push(added.content);
      } else if (/[<]\/?think[>]/i.test(added.content)) {
        streamEmitter.pushRaw(added.content);
      } else {
        streamEmitter.pushVisible(added.content);
      }
    }
    if (added.reasoning) {
      if (reasoningToolFilter) {
        reasoningToolFilter.push(added.reasoning);
      } else {
        streamEmitter.pushThinking(added.reasoning);
      }
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

  if (!sawPayload) throw new Error('Streaming response ended without payload');
  if (!streamDone && !state.finishReason) {
    state.finishReason = INCOMPLETE_RESPONSE;
  }

  visibleToolFilter?.close();
  reasoningToolFilter?.close();
  streamEmitter.close();

  return adaptLocalOpenAICompatResponse(
    {
      id: state.id || 'stream',
      model: state.model,
      choices: [
        {
          message: {
            role: state.role,
            content: combineReasoningAndContent(
              state.content || null,
              state.reasoning || null,
            ),
            ...(state.toolCalls.length > 0
              ? { tool_calls: state.toolCalls }
              : {}),
          },
          finish_reason:
            state.finishReason ||
            (state.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        },
      ],
      ...(state.usage ? { usage: state.usage } : {}),
    },
    {
      provider: args.provider,
      model: args.model,
      modelBehavior: args.modelBehavior,
    },
  );
}
