import { createHash } from 'node:crypto';
import { replaceUnpairedSurrogates } from '../../shared/unicode-utils.js';
import { resolveModelBehavior } from '../model-behavior.js';
import {
  collapseSystemMessages,
  mergeSystemMessage,
} from '../system-messages.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import {
  emitRawSseLineDebug,
  logLastPrompt,
  logModelResponseDebug,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  normalizeOpenRouterRuntimeModelName,
  ProviderRequestError,
} from './shared.js';
import { readWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from './stream-utils.js';
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

const vllmModelsWithoutNativeTools = new Set<string>();
const CALL_PREFIX_TOOL_CALL_OPEN = '<|tool_call>';
const CALL_PREFIX_TOOL_CALL_CLOSE = '<tool_call|>';
const CALL_PREFIX_TOOL_RESPONSE_OPEN = '<|tool_response>';
const CALL_PREFIX_TOOL_RESPONSE_CLOSE = '<tool_response|>';

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
    provider !== 'lmstudio' &&
    provider !== 'llamacpp'
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
  provider?: string;
  model?: string;
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
  thinkingFormat?: 'qwen';
}): boolean {
  const behavior = resolveModelBehavior({
    model: args.model
      ? normalizeLocalModelName(args.provider, args.model)
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
      normalizeLocalModelName(args.provider, args.model),
    ) === 'liquid'
  );
}

function usesCallPrefixToolCompat(args: {
  provider?: string;
  model?: string;
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
}): boolean {
  return (
    resolveModelBehavior({
      model: args.model
        ? normalizeLocalModelName(args.provider, args.model)
        : undefined,
      configured: args.modelBehavior,
    })?.toolCallFormat === 'gemma'
  );
}

function usesPromptToolCompat(args: {
  provider: string | undefined;
  model: string;
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
}): boolean {
  return usesCallPrefixToolCompat(args) || usesLiquidCompat(args);
}

function buildLiquidToolCallInstruction(tools: ToolDefinition[]): string {
  const toolList = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  return `List of tools: ${JSON.stringify(toolList)}`;
}

function gemmaToolString(value: string): string {
  return `<|"|>${String(value || '').replace(/<\|"\|>/g, '"')}<|"|>`;
}

function gemmaToolLiteral(value: unknown, key = ''): string {
  if (value == null) return 'null';
  if (typeof value === 'string') {
    return gemmaToolString(key === 'type' ? value.toUpperCase() : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => gemmaToolLiteral(item, key)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(
        ([entryKey, entry]) =>
          `${entryKey}:${gemmaToolLiteral(entry, entryKey)}`,
      )
      .join(',')}}`;
  }
  return gemmaToolString(String(value));
}

function buildCallPrefixToolCallInstruction(tools: ToolDefinition[]): string {
  const declarations = tools
    .map(
      (tool) =>
        `<|tool>declaration:${tool.function.name}{description:${gemmaToolString(
          tool.function.description,
        )},parameters:${gemmaToolLiteral(tool.function.parameters)}}<tool|>`,
    )
    .join('\n');
  return [
    declarations,
    'When a tool is needed, emit only a Gemma tool call in this form: <|tool_call>call:TOOL_NAME{ARGUMENT_NAME:ARGUMENT_VALUE}<tool_call|><|tool_response>',
    'Do not write a shell command, Markdown code block, or prose instead of a tool call.',
  ].join('\n');
}

function estimatePromptToolInstructionTokens(instruction: string): number {
  if (!instruction) return 0;
  return Math.max(1, Math.ceil(instruction.length / 2) + 32);
}

export function estimateLocalOpenAICompatPromptOverheadTokens(args: {
  provider: string | undefined;
  model: string;
  tools?: ToolDefinition[];
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
}): number {
  const tools = Array.isArray(args.tools) ? args.tools : [];
  if (tools.length === 0) return 0;
  if (usesCallPrefixToolCompat(args)) {
    return estimatePromptToolInstructionTokens(
      buildCallPrefixToolCallInstruction(tools),
    );
  }
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

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function contentToCallPrefixText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return replaceUnpairedSurrogates(content);
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) =>
      part.type === 'text' ? replaceUnpairedSurrogates(part.text) : '',
    )
    .join('\n');
}

function renderCallPrefixToolCall(toolCall: ToolCall): string {
  return `${CALL_PREFIX_TOOL_CALL_OPEN}call:${toolCall.function.name}${gemmaToolLiteral(
    parseJsonObject(toolCall.function.arguments),
  )}${CALL_PREFIX_TOOL_CALL_CLOSE}`;
}

function renderCallPrefixToolResponse(name: string, response: unknown): string {
  return `${CALL_PREFIX_TOOL_RESPONSE_OPEN}response:${name}${gemmaToolLiteral(
    response,
  )}${CALL_PREFIX_TOOL_RESPONSE_CLOSE}`;
}

function buildCallPrefixRequestMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const collapsed = collapseSystemMessages(messages);
  const result: Array<Record<string, unknown>> = [];
  let pendingAssistant: { role: 'assistant'; content: string } | null = null;
  let pendingCalls: Array<{
    id: string;
    name: string;
    used: boolean;
  }> = [];
  const flushPendingAssistant = (): void => {
    if (pendingAssistant) result.push(pendingAssistant);
    pendingAssistant = null;
    pendingCalls = [];
  };

  for (const message of collapsed) {
    if (
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      flushPendingAssistant();
      pendingCalls = message.tool_calls.map((toolCall) => ({
        id: toolCall.id || '',
        name: toolCall.function.name,
        used: false,
      }));
      pendingAssistant = {
        role: 'assistant',
        content: [
          contentToCallPrefixText(message.content).trim(),
          message.tool_calls.map(renderCallPrefixToolCall).join(''),
        ]
          .filter(Boolean)
          .join('\n'),
      };
      continue;
    }

    if (message.role === 'tool' && pendingAssistant) {
      const responseCall =
        pendingCalls.find(
          (call) =>
            !call.used &&
            call.id &&
            message.tool_call_id &&
            call.id === message.tool_call_id,
        ) || pendingCalls.find((call) => !call.used);
      if (responseCall) {
        responseCall.used = true;
        pendingAssistant.content += renderCallPrefixToolResponse(
          responseCall.name,
          typeof message.content === 'string'
            ? parseJsonObject(message.content)
            : normalizeMessageContent(message.content),
        );
        continue;
      }
    }

    flushPendingAssistant();
    result.push({
      ...message,
      content: normalizeMessageContent(message.content),
    });
  }

  flushPendingAssistant();
  return result;
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
  const useCallPrefixToolCompat = usesCallPrefixToolCompat(args);
  let messages = useCallPrefixToolCompat
    ? buildCallPrefixRequestMessages(args.messages)
    : usesQwenCompat(args)
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
  if (
    useCallPrefixToolCompat &&
    Array.isArray(args.tools) &&
    args.tools.length
  ) {
    messages = mergeSystemMessage(
      messages as ChatMessage[],
      buildCallPrefixToolCallInstruction(args.tools),
    ).map((message) => ({
      ...message,
      content: normalizeMessageContent(message.content),
    }));
  }
  return isMistralCompatModel(args.provider, args.model)
    ? sanitizeMistralToolCallIds(messages)
    : messages;
}

function buildRequestBody(
  args: NormalizedCallArgs,
  options: { includeTools?: boolean } = {},
): Record<string, unknown> {
  const includeTools =
    (options.includeTools ?? true) && !usesCallPrefixToolCompat(args);
  const request: Record<string, unknown> = {
    model: normalizeLocalModelName(args.provider, args.model),
    messages: buildRequestMessages(args),
  };
  if (includeTools && args.tools.length > 0) {
    request.tools = args.tools;
    request.tool_choice = 'auto';
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

function vllmNativeToolCacheKey(args: {
  provider: string | undefined;
  baseUrl: string;
  model: string;
}): string | null {
  if (args.provider !== 'vllm') return null;
  return `${normalizeBaseUrl(args.baseUrl)}\n${normalizeLocalModelName(
    args.provider,
    args.model,
  )}`;
}

function shouldRetryVllmWithoutNativeTools(params: {
  provider: string | undefined;
  tools: ToolDefinition[];
  status: number;
  errorText: string;
  nativeToolsSent: boolean;
}): boolean {
  if (!params.nativeToolsSent) return false;
  if (params.provider !== 'vllm') return false;
  if (params.tools.length === 0) return false;
  if (params.status !== 400) return false;
  const normalized = params.errorText.toLowerCase();
  return (
    normalized.includes('enable-auto-tool-choice') ||
    normalized.includes('tool-call-parser') ||
    normalized.includes('"auto" tool choice')
  );
}

function buildToolCallNormalizationOptions(params: {
  provider: string | undefined;
  model: string;
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
}) {
  const parser =
    params.modelBehavior?.toolCallFormat === 'gemma'
      ? 'call_prefix'
      : params.modelBehavior?.thinkingFormat === 'qwen'
        ? 'qwen'
        : resolveToolCallTextParser(
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
  const normalizedContentInput =
    hasStructuredToolCalls && thinking.thinkingOnly ? null : thinking.content;
  let normalized = normalizeToolCalls(
    message?.tool_calls,
    normalizedContentInput,
    normalizationOptions,
  );
  if (
    normalized.toolCalls.length === 0 &&
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
      normalized = {
        content: thinking.thinkingOnly ? null : normalized.content,
        toolCalls: thinkingToolCalls.toolCalls,
      };
    }
  }
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
          normalized.toolCalls.length > 0
            ? 'tool_calls'
            : choice?.finish_reason || 'stop',
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

function createCallPrefixStreamFilter(onTextDelta: (delta: string) => void): {
  push: (delta: string) => void;
  close: () => void;
} {
  const gemmaToolCallOpen = '<|tool_call>';
  const gemmaToolCallClose = '<tool_call|>';
  const gemmaToolResponseOpen = '<|tool_response>';
  let buffer = '';
  let insideToolCall = false;
  let markerToolCallClose: string | null = null;
  let braceDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const emit = (text: string): void => {
    if (text) onTextDelta(text);
  };

  const emitBeforeToolCall = (text: string): void => {
    emit(text.trim() ? text.replace(/\s+$/g, '') : '');
  };

  const isCallPrefixBoundary = (index: number): boolean => {
    if (index <= 0) return true;
    const previous = buffer[index - 1] || '';
    return /\s/.test(previous) || !/[A-Za-z0-9_]/.test(previous);
  };

  const findCallPrefixStart = (): number => {
    const lower = buffer.toLowerCase();
    let index = lower.indexOf('call:');
    while (index >= 0) {
      if (isCallPrefixBoundary(index)) return index;
      index = lower.indexOf('call:', index + 1);
    }
    return -1;
  };

  const findNextSuppressedStart = (): {
    index: number;
    kind: 'call' | 'tool_call_marker' | 'tool_response_marker';
  } | null => {
    const lower = buffer.toLowerCase();
    const candidates: Array<{
      index: number;
      kind: 'call' | 'tool_call_marker' | 'tool_response_marker';
    }> = [];
    const callIndex = findCallPrefixStart();
    if (callIndex >= 0) candidates.push({ index: callIndex, kind: 'call' });
    const toolCallMarkerIndex = lower.indexOf(gemmaToolCallOpen);
    if (toolCallMarkerIndex >= 0) {
      candidates.push({
        index: toolCallMarkerIndex,
        kind: 'tool_call_marker',
      });
    }
    const responseMarkerIndex = lower.indexOf(gemmaToolResponseOpen);
    if (responseMarkerIndex >= 0) {
      candidates.push({
        index: responseMarkerIndex,
        kind: 'tool_response_marker',
      });
    }
    return (
      candidates.sort((left, right) => left.index - right.index)[0] || null
    );
  };

  const findPartialCallPrefixSuffixLength = (): number => {
    const lower = buffer.toLowerCase();
    const markers = ['call:', gemmaToolCallOpen, gemmaToolResponseOpen];
    let longest = 0;
    for (const marker of markers) {
      const maxLength = Math.min(marker.length - 1, lower.length);
      for (let length = maxLength; length > longest; length -= 1) {
        if (lower.endsWith(marker.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  };

  const consumeToolCallBuffer = (): void => {
    if (markerToolCallClose) {
      const lower = buffer.toLowerCase();
      const end = lower.indexOf(markerToolCallClose);
      if (end < 0) {
        buffer = '';
        return;
      }
      let nextStart = end + markerToolCallClose.length;
      if (lower.startsWith(gemmaToolResponseOpen, nextStart)) {
        nextStart += gemmaToolResponseOpen.length;
      }
      buffer = buffer.slice(nextStart);
      insideToolCall = false;
      markerToolCallClose = null;
      return;
    }

    let index = 0;
    while (index < buffer.length) {
      const char = buffer[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        index += 1;
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        index += 1;
        continue;
      }
      if (char === '{') {
        braceDepth += 1;
      } else if (char === '}') {
        braceDepth -= 1;
        if (braceDepth <= 0) {
          buffer = buffer.slice(index + 1);
          insideToolCall = false;
          braceDepth = 0;
          quote = null;
          escaped = false;
          return;
        }
      }
      index += 1;
    }

    buffer = '';
  };

  const flush = (final = false): void => {
    while (buffer) {
      if (insideToolCall) {
        consumeToolCallBuffer();
        if (insideToolCall) return;
        continue;
      }

      const start = findNextSuppressedStart();
      if (!start) {
        const holdbackChars = final ? 0 : findPartialCallPrefixSuffixLength();
        if (!final && buffer.length <= holdbackChars) return;
        const emitLength = buffer.length - holdbackChars;
        emit(buffer.slice(0, emitLength));
        buffer = buffer.slice(emitLength);
        if (!final) return;
        continue;
      }

      const beforeCall = buffer.slice(0, start.index);
      const candidate = buffer.slice(start.index);
      if (start.kind === 'tool_response_marker') {
        emitBeforeToolCall(beforeCall);
        buffer = candidate.slice(gemmaToolResponseOpen.length);
        continue;
      }
      if (start.kind === 'tool_call_marker') {
        emitBeforeToolCall(beforeCall);
        buffer = candidate.slice(gemmaToolCallOpen.length);
        insideToolCall = true;
        markerToolCallClose = gemmaToolCallClose;
        continue;
      }

      const callMatch = candidate.match(
        /^call:\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\{/i,
      );
      if (callMatch) {
        emitBeforeToolCall(beforeCall);
        buffer = candidate.slice(callMatch[0].length);
        insideToolCall = true;
        braceDepth = 1;
        quote = null;
        escaped = false;
        continue;
      }

      if (!final && /^call:\s*[A-Za-z_][A-Za-z0-9_.-]*\s*$/i.test(candidate)) {
        emitBeforeToolCall(beforeCall);
        buffer = candidate;
        return;
      }

      emit(buffer.slice(0, start.index + 'call:'.length));
      buffer = buffer.slice(start.index + 'call:'.length);
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
  const nativeToolCacheKey = vllmNativeToolCacheKey(args);
  const promptToolCompat = usesPromptToolCompat(args);
  const includeNativeTools =
    !nativeToolCacheKey ||
    !vllmModelsWithoutNativeTools.has(nativeToolCacheKey) ||
    !promptToolCompat;
  let requestBody = buildRequestBody(args, {
    includeTools: includeNativeTools,
  });
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
  let response = await fetch(url, {
    method: 'POST',
    headers: {
      ...buildHeaders(args.apiKey),
      ...(args.requestHeaders || {}),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (
      shouldRetryVllmWithoutNativeTools({
        provider: args.provider,
        tools: args.tools,
        status: response.status,
        errorText,
        nativeToolsSent: includeNativeTools,
      }) &&
      promptToolCompat
    ) {
      if (nativeToolCacheKey) {
        vllmModelsWithoutNativeTools.add(nativeToolCacheKey);
      }
      requestBody = buildRequestBody(args, { includeTools: false });
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
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...buildHeaders(args.apiKey),
          ...(args.requestHeaders || {}),
        },
        body: JSON.stringify(requestBody),
      });
    } else {
      throw new ProviderRequestError(response.status, errorText);
    }
  }

  if (!response.ok) {
    throw new ProviderRequestError(response.status, await response.text());
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
  const buildStreamRequestBody = (includeTools: boolean) => ({
    ...buildRequestBody(args, { includeTools }),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  });
  const nativeToolCacheKey = vllmNativeToolCacheKey(args);
  const promptToolCompat = usesPromptToolCompat(args);
  const includeNativeTools =
    !nativeToolCacheKey ||
    !vllmModelsWithoutNativeTools.has(nativeToolCacheKey) ||
    !promptToolCompat;
  let requestBody = buildStreamRequestBody(includeNativeTools);
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
  let response = await fetch(url, {
    method: 'POST',
    headers: {
      ...buildHeaders(args.apiKey),
      ...(args.requestHeaders || {}),
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (
      shouldRetryVllmWithoutNativeTools({
        provider: args.provider,
        tools: args.tools,
        status: response.status,
        errorText,
        nativeToolsSent: includeNativeTools,
      }) &&
      promptToolCompat
    ) {
      if (nativeToolCacheKey) {
        vllmModelsWithoutNativeTools.add(nativeToolCacheKey);
      }
      requestBody = buildStreamRequestBody(false);
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
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...buildHeaders(args.apiKey),
          ...(args.requestHeaders || {}),
          Accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } else {
      throw new ProviderRequestError(response.status, errorText);
    }
  }

  if (!response.ok) {
    throw new ProviderRequestError(response.status, await response.text());
  }

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    contentType.includes('application/json') &&
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
    assertNoProviderError(payload);
    const adapted = adaptLocalOpenAICompatResponse(payload, {
      provider: args.provider,
      model: args.model,
      modelBehavior: args.modelBehavior,
    });
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
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
  const shouldFilterCallPrefix = normalizationOptions.parser === 'call_prefix';
  const streamEmitter = createThinkingStreamEmitter(args.onTextDelta, {
    onThinkingDelta: args.onThinkingDelta,
  });
  const visibleToolFilter = shouldFilterQwenMarkup
    ? createToolMarkupStreamFilter((delta) => streamEmitter.pushVisible(delta))
    : shouldFilterCallPrefix
      ? createCallPrefixStreamFilter((delta) =>
          streamEmitter.pushVisible(delta),
        )
      : null;
  const reasoningToolFilter = shouldFilterQwenMarkup
    ? createToolMarkupStreamFilter((delta) => streamEmitter.pushThinking(delta))
    : shouldFilterCallPrefix
      ? createCallPrefixStreamFilter((delta) =>
          streamEmitter.pushThinking(delta),
        )
      : null;
  const flushReasoningPreview = (): void => {
    reasoningToolFilter?.close();
  };

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

    let usedMessageContent = false;
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
          usedMessageContent = true;
          flushReasoningPreview();
          if (visibleToolFilter) {
            visibleToolFilter.push(delta);
          } else if (/[<]\/?think[>]/i.test(delta)) {
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
          if (reasoningToolFilter) {
            reasoningToolFilter.push(reasoningDelta);
          } else {
            streamEmitter.pushThinking(reasoningDelta);
          }
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
      if (
        !usedMessageContent &&
        typeof choice.delta.content === 'string' &&
        choice.delta.content
      ) {
        rawTextContent += choice.delta.content;
        flushReasoningPreview();
        if (visibleToolFilter) {
          visibleToolFilter.push(choice.delta.content);
        } else if (/[<]\/?think[>]/i.test(choice.delta.content)) {
          streamEmitter.pushRaw(choice.delta.content);
        } else {
          streamEmitter.pushVisible(choice.delta.content);
        }
      }
      const deltaReasoning = extractStructuredReasoning(choice.delta);
      if (deltaReasoning) {
        rawReasoningContent += deltaReasoning;
        if (reasoningToolFilter) {
          reasoningToolFilter.push(deltaReasoning);
        } else {
          streamEmitter.pushThinking(deltaReasoning);
        }
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

  visibleToolFilter?.close();
  reasoningToolFilter?.close();
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
      modelBehavior: args.modelBehavior,
    },
  );
}
