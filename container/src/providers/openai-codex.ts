import type {
  ChatCompletionResponse,
  ChatContentPart,
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import {
  buildRequestHeaders,
  HybridAIRequestError,
  isRecord,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
} from './shared.js';

interface ServerSentEvent {
  event: string | null;
  data: string;
}

interface CodexAccumulatedContentPart {
  type: string;
  text: string;
}

interface CodexAccumulatedMessageItem {
  type: 'message';
  id: string;
  role: string;
  content: CodexAccumulatedContentPart[];
}

interface CodexAccumulatedFunctionCallItem {
  type: 'function_call';
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

type CodexAccumulatedOutputItem =
  | CodexAccumulatedMessageItem
  | CodexAccumulatedFunctionCallItem;

interface CodexStreamAccumulator {
  id: string;
  model: string;
  usage?: ChatCompletionResponse['usage'];
  output: Array<CodexAccumulatedOutputItem | null>;
  completedResponse?: Record<string, unknown>;
}

const CODEX_DEFAULT_INSTRUCTIONS = 'You are Codex, a coding assistant.';

function normalizeCodexModelName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed.toLowerCase().startsWith('openai-codex/')) return trimmed;
  return trimmed.slice('openai-codex/'.length) || trimmed;
}

function normalizeMessageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function logCodexTransport(message: string): void {
  console.error(`[codex] ${message}`);
}

function convertContentPart(
  part: ChatContentPart,
): Record<string, unknown> | null {
  if (part.type === 'text') {
    return { type: 'input_text', text: part.text };
  }
  if (part.type === 'image_url') {
    return { type: 'input_image', image_url: part.image_url.url };
  }
  return null;
}

function convertMessageToResponsesInput(
  message: ChatMessage,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  if (message.role === 'system') return items;

  if (message.role === 'tool') {
    items.push({
      type: 'function_call_output',
      call_id: message.tool_call_id || '',
      output: normalizeMessageText(message.content),
    });
    return items;
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      items.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }

  const content = Array.isArray(message.content)
    ? message.content
        .map(convertContentPart)
        .filter((part): part is Record<string, unknown> => part !== null)
    : normalizeMessageText(message.content);
  const hasContent =
    typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content) && content.length > 0;
  if (hasContent) {
    items.push({
      role: message.role,
      content,
    });
  }

  return items;
}

function convertToolsToResponsesTools(
  tools: ToolDefinition[],
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function extractCodexInstructions(messages: ChatMessage[]): string {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => normalizeMessageText(message.content).trim())
    .filter((message) => message.length > 0)
    .join('\n\n');

  return instructions || CODEX_DEFAULT_INSTRUCTIONS;
}

function buildCodexRequestBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Record<string, unknown> {
  return {
    model: normalizeCodexModelName(model),
    store: false,
    instructions: extractCodexInstructions(messages),
    input: messages.flatMap(convertMessageToResponsesInput),
    tools: convertToolsToResponsesTools(tools),
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
}

function adaptCodexResponse(
  payload: unknown,
  fallbackModel: string,
): ChatCompletionResponse {
  const record = payload as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  let role = 'assistant';
  const contentParts: Array<{ type: 'text'; text: string }> = [];
  const toolCalls: ToolCall[] = [];

  for (const entry of output) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : '';

    if (type === 'message') {
      if (typeof item.role === 'string' && item.role) role = item.role;
      const content = Array.isArray(item.content) ? item.content : [];
      for (const rawContent of content) {
        if (
          rawContent &&
          typeof rawContent === 'object' &&
          !Array.isArray(rawContent)
        ) {
          const part = rawContent as Record<string, unknown>;
          const text =
            typeof part.text === 'string'
              ? part.text
              : typeof part.output_text === 'string'
                ? part.output_text
                : '';
          if (text) contentParts.push({ type: 'text', text });
        }
      }
    }

    if (type === 'function_call') {
      toolCalls.push({
        id:
          (typeof item.call_id === 'string' && item.call_id) ||
          (typeof item.id === 'string' && item.id) ||
          '',
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : '',
          arguments:
            typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {}),
        },
      });
    }
  }

  const textContent =
    contentParts.length === 0
      ? null
      : contentParts.length === 1
        ? contentParts[0].text
        : contentParts;
  const usage =
    record.usage && typeof record.usage === 'object'
      ? (record.usage as ChatCompletionResponse['usage'])
      : undefined;

  return {
    id: typeof record.id === 'string' ? record.id : 'response',
    model:
      typeof record.model === 'string' && record.model
        ? record.model
        : normalizeCodexModelName(fallbackModel),
    choices: [
      {
        message: {
          role,
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function parseServerSentEventBlock(block: string): ServerSentEvent | null {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  let event: string | null = null;

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(':')) continue;

    const separatorIndex = rawLine.indexOf(':');
    const field =
      separatorIndex === -1 ? rawLine.trim() : rawLine.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? ''
        : rawLine.slice(separatorIndex + 1).replace(/^ /, '');

    if (field === 'event') {
      event = value || null;
      continue;
    }
    if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return {
    event,
    data: dataLines.join('\n'),
  };
}

function resolveCodexOutputIndex(
  output: Array<CodexAccumulatedOutputItem | null>,
  outputIndex?: number,
  itemId?: string,
): number {
  if (typeof outputIndex === 'number' && outputIndex >= 0) return outputIndex;
  if (itemId) {
    const existingIndex = output.findIndex((item) => item?.id === itemId);
    if (existingIndex >= 0) return existingIndex;
  }
  return output.length;
}

function ensureCodexMessageItem(
  output: Array<CodexAccumulatedOutputItem | null>,
  outputIndex?: number,
  itemId?: string,
): CodexAccumulatedMessageItem {
  const index = resolveCodexOutputIndex(output, outputIndex, itemId);
  const existing = output[index];
  if (existing && existing.type === 'message') {
    if (itemId && !existing.id) existing.id = itemId;
    return existing;
  }

  const next: CodexAccumulatedMessageItem = {
    type: 'message',
    id: itemId || (existing?.id ?? ''),
    role: 'assistant',
    content: [],
  };
  output[index] = next;
  return next;
}

function ensureCodexFunctionCallItem(
  output: Array<CodexAccumulatedOutputItem | null>,
  outputIndex?: number,
  itemId?: string,
): CodexAccumulatedFunctionCallItem {
  const index = resolveCodexOutputIndex(output, outputIndex, itemId);
  const existing = output[index];
  if (existing && existing.type === 'function_call') {
    if (itemId && !existing.id) existing.id = itemId;
    if (itemId && !existing.callId) existing.callId = itemId;
    return existing;
  }

  const next: CodexAccumulatedFunctionCallItem = {
    type: 'function_call',
    id: itemId || (existing?.id ?? ''),
    callId: itemId || '',
    name: '',
    arguments: '',
  };
  output[index] = next;
  return next;
}

function ensureCodexContentPart(
  item: CodexAccumulatedMessageItem,
  contentIndex?: number,
  type = 'output_text',
): CodexAccumulatedContentPart {
  const index =
    typeof contentIndex === 'number' && contentIndex >= 0 ? contentIndex : 0;
  while (item.content.length <= index) {
    item.content.push({ type, text: '' });
  }
  const part = item.content[index];
  if (!part.type) part.type = type;
  return part;
}

function normalizeCodexPartText(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.output_text === 'string') return part.output_text;
  return '';
}

function normalizeCodexUsage(
  value: unknown,
): ChatCompletionResponse['usage'] | undefined {
  return isRecord(value)
    ? (value as ChatCompletionResponse['usage'])
    : undefined;
}

function mergeCodexMessageItem(
  target: CodexAccumulatedMessageItem,
  item: Record<string, unknown>,
): void {
  if (typeof item.id === 'string' && item.id) target.id = item.id;
  if (typeof item.role === 'string' && item.role) target.role = item.role;
  if (!Array.isArray(item.content)) return;

  const nextParts: CodexAccumulatedContentPart[] = [];
  for (const rawPart of item.content) {
    if (!isRecord(rawPart)) continue;
    const text = normalizeCodexPartText(rawPart);
    const type =
      typeof rawPart.type === 'string' && rawPart.type
        ? rawPart.type
        : 'output_text';
    nextParts.push({ type, text });
  }
  if (nextParts.length > 0) target.content = nextParts;
}

function mergeCodexFunctionCallItem(
  target: CodexAccumulatedFunctionCallItem,
  item: Record<string, unknown>,
): void {
  if (typeof item.id === 'string' && item.id) target.id = item.id;
  if (typeof item.call_id === 'string' && item.call_id) {
    target.callId = item.call_id;
  }
  if (typeof item.name === 'string' && item.name) target.name = item.name;
  if (typeof item.arguments === 'string') {
    target.arguments = item.arguments;
  } else if (item.arguments !== undefined) {
    target.arguments = JSON.stringify(item.arguments);
  }
}

function mergeCodexOutputItem(
  output: Array<CodexAccumulatedOutputItem | null>,
  item: Record<string, unknown>,
  outputIndex?: number,
): void {
  const itemId = typeof item.id === 'string' ? item.id : undefined;
  if (item.type === 'function_call') {
    mergeCodexFunctionCallItem(
      ensureCodexFunctionCallItem(output, outputIndex, itemId),
      item,
    );
    return;
  }
  if (item.type === 'message') {
    mergeCodexMessageItem(
      ensureCodexMessageItem(output, outputIndex, itemId),
      item,
    );
  }
}

function updateCodexResponseMetadata(
  state: CodexStreamAccumulator,
  response: Record<string, unknown>,
): void {
  if (typeof response.id === 'string' && response.id) state.id = response.id;
  if (typeof response.model === 'string' && response.model) {
    state.model = response.model;
  }
  const usage = normalizeCodexUsage(response.usage);
  if (usage) state.usage = usage;
}

function parseCodexStreamError(payload: Record<string, unknown>): string {
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  if (isRecord(payload.error)) {
    if (
      typeof payload.error.message === 'string' &&
      payload.error.message.trim()
    ) {
      return payload.error.message.trim();
    }
    if (typeof payload.error.code === 'string' && payload.error.code.trim()) {
      return payload.error.code.trim();
    }
  }
  if (
    isRecord(payload.response) &&
    typeof payload.response.status === 'string'
  ) {
    return `Codex stream ended with status ${payload.response.status}`;
  }
  return 'Codex streaming request failed';
}

function serializeCodexOutput(
  output: Array<CodexAccumulatedOutputItem | null>,
): Array<Record<string, unknown>> {
  const serialized: Array<Record<string, unknown>> = [];
  for (const item of output) {
    if (!item) continue;
    if (item.type === 'message') {
      serialized.push({
        type: 'message',
        ...(item.id ? { id: item.id } : {}),
        role: item.role,
        content: item.content.map((part) => ({
          type: part.type,
          text: part.text,
        })),
      });
      continue;
    }
    serialized.push({
      type: 'function_call',
      ...(item.id ? { id: item.id } : {}),
      ...(item.callId ? { call_id: item.callId } : {}),
      name: item.name,
      arguments: item.arguments,
    });
  }
  return serialized;
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

function buildCodexStreamResponse(
  state: CodexStreamAccumulator,
  fallbackModel: string,
): ChatCompletionResponse {
  if (state.completedResponse) {
    return adaptCodexResponse(state.completedResponse, fallbackModel);
  }
  return adaptCodexResponse(
    {
      id: state.id || 'response',
      model: state.model || normalizeCodexModelName(fallbackModel),
      output: serializeCodexOutput(state.output),
      ...(state.usage ? { usage: state.usage } : {}),
    },
    fallbackModel,
  );
}

function consumeCodexStreamPayload(
  payloadText: string,
  eventName: string | null,
  state: CodexStreamAccumulator,
  onTextDelta: (delta: string) => void,
): boolean {
  const trimmed = payloadText.trim();
  if (!trimmed) return false;
  if (trimmed === '[DONE]') return true;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(payload)) return false;

  const type =
    typeof payload.type === 'string' && payload.type
      ? payload.type
      : eventName || '';

  if (
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.error' ||
    type === 'response.incomplete'
  ) {
    throw new Error(parseCodexStreamError(payload));
  }

  if (isRecord(payload.response)) {
    updateCodexResponseMetadata(state, payload.response);
  }

  if (type === 'response.created' || type === 'response.in_progress') {
    return false;
  }

  const outputIndex =
    typeof payload.output_index === 'number' && payload.output_index >= 0
      ? payload.output_index
      : undefined;
  const itemId =
    typeof payload.item_id === 'string' ? payload.item_id : undefined;

  if (
    (type === 'response.output_item.added' ||
      type === 'response.output_item.done') &&
    isRecord(payload.item)
  ) {
    mergeCodexOutputItem(state.output, payload.item, outputIndex);
    return false;
  }

  if (type === 'response.content_part.added' && isRecord(payload.part)) {
    const item = ensureCodexMessageItem(state.output, outputIndex, itemId);
    const part = ensureCodexContentPart(
      item,
      typeof payload.content_index === 'number' ? payload.content_index : 0,
      typeof payload.part.type === 'string' && payload.part.type
        ? payload.part.type
        : 'output_text',
    );
    const text = normalizeCodexPartText(payload.part);
    if (text) part.text = text;
    return false;
  }

  if (type === 'response.output_text.delta') {
    const item = ensureCodexMessageItem(state.output, outputIndex, itemId);
    const part = ensureCodexContentPart(
      item,
      typeof payload.content_index === 'number' ? payload.content_index : 0,
    );
    const delta =
      typeof payload.delta === 'string'
        ? payload.delta
        : typeof payload.text === 'string'
          ? payload.text
          : '';
    if (delta) {
      part.text += delta;
      onTextDelta(delta);
    }
    return false;
  }

  if (type === 'response.output_text.done') {
    const item = ensureCodexMessageItem(state.output, outputIndex, itemId);
    const part = ensureCodexContentPart(
      item,
      typeof payload.content_index === 'number' ? payload.content_index : 0,
    );
    const finalText =
      typeof payload.text === 'string'
        ? payload.text
        : typeof payload.output_text === 'string'
          ? payload.output_text
          : '';
    if (finalText && (!part.text || finalText.length >= part.text.length)) {
      part.text = finalText;
    }
    return false;
  }

  if (type === 'response.function_call_arguments.delta') {
    const item = ensureCodexFunctionCallItem(state.output, outputIndex, itemId);
    const delta = typeof payload.delta === 'string' ? payload.delta : '';
    if (delta) item.arguments += delta;
    return false;
  }

  if (type === 'response.function_call_arguments.done') {
    const item = ensureCodexFunctionCallItem(state.output, outputIndex, itemId);
    const finalArguments =
      typeof payload.arguments === 'string'
        ? payload.arguments
        : typeof payload.output === 'string'
          ? payload.output
          : '';
    if (finalArguments) item.arguments = finalArguments;
    return false;
  }

  if (type === 'response.completed') {
    if (isRecord(payload.response)) {
      state.completedResponse = payload.response;
      updateCodexResponseMetadata(state, payload.response);
    }
    return true;
  }

  return false;
}

export async function callOpenAICodexProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  const startedAt = Date.now();
  logCodexTransport(
    `request start model=${normalizeCodexModelName(args.model)} messages=${args.messages.length} tools=${args.tools.length}`,
  );
  const response = await fetch(`${args.baseUrl}/responses`, {
    method: 'POST',
    headers: buildRequestHeaders(args.apiKey, args.requestHeaders),
    body: JSON.stringify(
      buildCodexRequestBody(args.model, args.messages, args.tools),
    ),
  });
  logCodexTransport(
    `response headers model=${normalizeCodexModelName(args.model)} status=${response.status} durationMs=${Date.now() - startedAt} contentType=${response.headers.get('content-type') || '<missing>'}`,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new HybridAIRequestError(response.status, text);
  }

  const adapted = adaptCodexResponse(
    (await response.json()) as unknown,
    args.model,
  );
  logCodexTransport(
    `request complete model=${normalizeCodexModelName(args.model)} durationMs=${Date.now() - startedAt}`,
  );
  return adapted;
}

export async function callOpenAICodexProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  const startedAt = Date.now();
  logCodexTransport(
    `stream request start model=${normalizeCodexModelName(args.model)} messages=${args.messages.length} tools=${args.tools.length}`,
  );
  const response = await fetch(`${args.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      ...buildRequestHeaders(args.apiKey, args.requestHeaders),
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify({
      ...buildCodexRequestBody(args.model, args.messages, args.tools),
      stream: true,
    }),
  });
  logCodexTransport(
    `stream response headers model=${normalizeCodexModelName(args.model)} status=${response.status} durationMs=${Date.now() - startedAt} contentType=${response.headers.get('content-type') || '<missing>'}`,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new HybridAIRequestError(response.status, text);
  }

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    contentType.includes('application/json') &&
    !contentType.includes('event-stream')
  ) {
    const adapted = adaptCodexResponse(
      (await response.json()) as unknown,
      args.model,
    );
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
  }

  if (!response.body) {
    const adapted = adaptCodexResponse(
      (await response.json()) as unknown,
      args.model,
    );
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const streamState: CodexStreamAccumulator = {
    id: '',
    model: normalizeCodexModelName(args.model),
    output: [],
  };
  let buffer = '';
  let sawPayload = false;
  let streamDone = false;
  let firstEventMs: number | null = null;

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        const event = parseServerSentEventBlock(block);
        if (!event) continue;
        sawPayload = true;
        if (firstEventMs == null) {
          firstEventMs = Date.now() - startedAt;
          logCodexTransport(
            `stream first event model=${normalizeCodexModelName(args.model)} durationMs=${firstEventMs} event=${event.event || '<default>'}`,
          );
        }
        streamDone = consumeCodexStreamPayload(
          event.data,
          event.event,
          streamState,
          args.onTextDelta,
        );
        if (streamDone) break;
      }
    }

    if (!streamDone && buffer.trim()) {
      const event = parseServerSentEventBlock(buffer);
      if (event) {
        sawPayload = true;
        if (firstEventMs == null) {
          firstEventMs = Date.now() - startedAt;
          logCodexTransport(
            `stream first event model=${normalizeCodexModelName(args.model)} durationMs=${firstEventMs} event=${event.event || '<default>'}`,
          );
        }
        streamDone = consumeCodexStreamPayload(
          event.data,
          event.event,
          streamState,
          args.onTextDelta,
        );
      }
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }

  if (!sawPayload) {
    throw new Error('Codex streaming response ended without payload');
  }

  logCodexTransport(
    `stream complete model=${normalizeCodexModelName(args.model)} durationMs=${Date.now() - startedAt}`,
  );
  return buildCodexStreamResponse(streamState, args.model);
}
