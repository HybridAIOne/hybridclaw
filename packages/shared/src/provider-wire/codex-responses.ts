/**
 * OpenAI Responses wire codec — the one translation between chat messages and
 * the Responses API (API-key OpenAI and Codex) that the gateway and the worker
 * share. Opaque `openai_response_items` (reasoning) replay ahead of the tool
 * calls they produced and are never folded into visible text.
 *
 * Pure: no fetch, timeouts, retries, logging, or credentials. Each side keeps
 * its own transport and decides what to do with an empty completion.
 */
import type {
  ChatContentPart,
  ChatMessage,
  ChatMessageContent,
  ToolCall,
} from '@hybridclaw/contracts/agent-io';
import { isRecord } from '../primitive-values.ts';
import type { ChatCompletionsToolChoice } from './chat-completions.ts';
import { stripProviderPrefix } from './model-names.ts';

const CODEX_DEFAULT_INSTRUCTIONS = 'You are Codex, a coding assistant.';
const OPENAI_DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

export interface ResponsesToolInput {
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ResponsesRequestParams {
  /** `openai` selects the API-key flavour; anything else is Codex. */
  provider: string | undefined;
  model: string;
  messages: ChatMessage[];
  tools: ResponsesToolInput[];
  toolChoice?: ChatCompletionsToolChoice;
  promptCacheKey?: string;
  maxTokens?: number;
}

export interface ResponsesCompletion<TUsage = Record<string, unknown>> {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: ChatMessageContent;
      tool_calls?: ToolCall[];
      openai_response_items?: Array<Record<string, unknown>>;
    };
    finish_reason: string;
  }>;
  usage?: TUsage;
}

export function normalizeCodexModelName(model: string): string {
  const trimmed = String(model || '').trim();
  for (const prefix of ['openai-codex', 'openai']) {
    const stripped = stripProviderPrefix(trimmed, prefix);
    if (stripped !== trimmed) return stripped;
  }
  return trimmed;
}

export function responsesContentText(content: ChatMessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function convertContentPart(
  part: ChatContentPart,
): Record<string, unknown> | null {
  if (part.type === 'text') return { type: 'input_text', text: part.text };
  if (part.type === 'file') return { type: 'input_file', ...part.file };
  if (part.type === 'image_url') {
    return { type: 'input_image', image_url: part.image_url.url };
  }
  return null;
}

export function convertMessageToResponsesInput(
  message: ChatMessage,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (message.role === 'system') return items;

  if (message.role === 'tool') {
    items.push({
      type: 'function_call_output',
      call_id: message.tool_call_id || '',
      output: responsesContentText(message.content),
    });
    return items;
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    if (Array.isArray(message.openai_response_items)) {
      items.push(...message.openai_response_items);
    }
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
    : responsesContentText(message.content);
  const hasContent =
    typeof content === 'string'
      ? content.trim().length > 0
      : content.length > 0;
  if (hasContent) items.push({ role: message.role, content });
  return items;
}

function convertToolsToResponsesTools(
  tools: ResponsesToolInput[],
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function convertToolChoice(
  choice: ChatCompletionsToolChoice | undefined,
): string | Record<string, unknown> {
  if (!choice) return 'auto';
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

function extractInstructions(messages: ChatMessage[], fallback: string) {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => responsesContentText(message.content).trim())
    .filter((message) => message.length > 0)
    .join('\n\n');
  return instructions || fallback;
}

export function buildResponsesRequestBody(
  params: ResponsesRequestParams,
): Record<string, unknown> {
  const isOpenAI = params.provider === 'openai';
  const body: Record<string, unknown> = {
    model: normalizeCodexModelName(params.model),
    store: false,
    instructions: extractInstructions(
      params.messages,
      isOpenAI ? OPENAI_DEFAULT_INSTRUCTIONS : CODEX_DEFAULT_INSTRUCTIONS,
    ),
    input: params.messages.flatMap(convertMessageToResponsesInput),
  };
  if (params.promptCacheKey) {
    // Without a stable key the backend mints a random prompt_cache_key per
    // request, so prefix-cache hits depend on load-balancer routing luck.
    body.prompt_cache_key = params.promptCacheKey;
  }
  if (isOpenAI && params.maxTokens != null) {
    body.max_output_tokens = params.maxTokens;
  }
  if (isOpenAI) body.include = ['reasoning.encrypted_content'];
  if (params.tools.length > 0) {
    body.tools = convertToolsToResponsesTools(params.tools);
    body.tool_choice = convertToolChoice(params.toolChoice);
    body.parallel_tool_calls = true;
  }
  return body;
}

function readPartText(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.output_text === 'string') return part.output_text;
  return '';
}

function normalizeResponseOutput(
  record: Record<string, unknown>,
  fallbackOutput?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const output = Array.isArray(record.output)
    ? record.output.filter(isRecord)
    : [];
  if (output.length > 0) return output;
  if (fallbackOutput && fallbackOutput.length > 0) return fallbackOutput;
  const outputText =
    typeof record.output_text === 'string' ? record.output_text.trim() : '';
  return outputText
    ? [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText }],
        },
      ]
    : [];
}

export function adaptResponsesPayload<TUsage = Record<string, unknown>>(
  payload: unknown,
  fallbackModel: string,
  fallbackOutput?: Array<Record<string, unknown>>,
): ResponsesCompletion<TUsage> {
  const record = isRecord(payload) ? payload : {};
  const output = normalizeResponseOutput(record, fallbackOutput);
  let role = 'assistant';
  const contentParts: Array<{ type: 'text'; text: string }> = [];
  const toolCalls: ToolCall[] = [];
  const responseItems: Array<Record<string, unknown>> = [];

  for (const item of output) {
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'reasoning') responseItems.push(item);

    if (type === 'message') {
      if (typeof item.role === 'string' && item.role) role = item.role;
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        const text =
          readPartText(part) ||
          (typeof part.refusal === 'string' ? part.refusal : '');
        if (text) contentParts.push({ type: 'text', text });
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

  const content =
    contentParts.length === 0
      ? null
      : contentParts.length === 1
        ? contentParts[0].text
        : contentParts;
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
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(responseItems.length > 0
            ? { openai_response_items: responseItems }
            : {}),
        },
        finish_reason:
          record.status === 'incomplete'
            ? 'length'
            : toolCalls.length > 0
              ? 'tool_calls'
              : 'stop',
      },
    ],
    ...(isRecord(record.usage) ? { usage: record.usage as TUsage } : {}),
  };
}

interface AccumulatedMessageItem {
  type: 'message';
  id: string;
  role: string;
  content: Array<{ type: string; text: string }>;
}

interface AccumulatedFunctionCallItem {
  type: 'function_call';
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

type AccumulatedOutputItem =
  | AccumulatedMessageItem
  | AccumulatedFunctionCallItem;

export interface ResponsesStreamState {
  id: string;
  model: string;
  usage?: Record<string, unknown>;
  output: Array<AccumulatedOutputItem | null>;
  completedResponse?: Record<string, unknown>;
}

export interface ResponsesStreamHandlers {
  onTextDelta: (delta: string) => void;
  onActivity?: () => void;
}

export function createResponsesStreamState(
  model: string,
): ResponsesStreamState {
  return { id: '', model: normalizeCodexModelName(model), output: [] };
}

function resolveOutputIndex(
  output: Array<AccumulatedOutputItem | null>,
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

function ensureMessageItem(
  output: Array<AccumulatedOutputItem | null>,
  outputIndex?: number,
  itemId?: string,
): AccumulatedMessageItem {
  if (outputIndex === undefined && !itemId) {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const existing = output[index];
      if (existing?.type === 'message') return existing;
    }
  }
  const index = resolveOutputIndex(output, outputIndex, itemId);
  const existing = output[index];
  if (existing && existing.type === 'message') {
    if (itemId && !existing.id) existing.id = itemId;
    return existing;
  }
  const next: AccumulatedMessageItem = {
    type: 'message',
    id: itemId || (existing?.id ?? ''),
    role: 'assistant',
    content: [],
  };
  output[index] = next;
  return next;
}

function ensureFunctionCallItem(
  output: Array<AccumulatedOutputItem | null>,
  outputIndex?: number,
  itemId?: string,
): AccumulatedFunctionCallItem {
  if (outputIndex === undefined && !itemId) {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const existing = output[index];
      if (existing?.type === 'function_call') return existing;
    }
  }
  const index = resolveOutputIndex(output, outputIndex, itemId);
  const existing = output[index];
  if (existing && existing.type === 'function_call') {
    if (itemId && !existing.id) existing.id = itemId;
    if (itemId && !existing.callId) existing.callId = itemId;
    return existing;
  }
  const next: AccumulatedFunctionCallItem = {
    type: 'function_call',
    id: itemId || (existing?.id ?? ''),
    callId: itemId || '',
    name: '',
    arguments: '',
  };
  output[index] = next;
  return next;
}

function ensureContentPart(
  item: AccumulatedMessageItem,
  contentIndex?: number,
  type = 'output_text',
): { type: string; text: string } {
  const index =
    typeof contentIndex === 'number' && contentIndex >= 0 ? contentIndex : 0;
  while (item.content.length <= index) item.content.push({ type, text: '' });
  const part = item.content[index];
  if (!part.type) part.type = type;
  return part;
}

function mergeOutputItem(
  output: Array<AccumulatedOutputItem | null>,
  item: Record<string, unknown>,
  outputIndex?: number,
): void {
  const itemId = typeof item.id === 'string' ? item.id : undefined;
  if (item.type === 'function_call') {
    const target = ensureFunctionCallItem(output, outputIndex, itemId);
    if (itemId) target.id = itemId;
    if (typeof item.call_id === 'string' && item.call_id) {
      target.callId = item.call_id;
    }
    if (typeof item.name === 'string' && item.name) target.name = item.name;
    if (typeof item.arguments === 'string') {
      target.arguments = item.arguments;
    } else if (item.arguments !== undefined) {
      target.arguments = JSON.stringify(item.arguments);
    }
    return;
  }
  if (item.type !== 'message') return;
  const target = ensureMessageItem(output, outputIndex, itemId);
  if (itemId) target.id = itemId;
  if (typeof item.role === 'string' && item.role) target.role = item.role;
  if (!Array.isArray(item.content)) return;
  const nextParts: Array<{ type: string; text: string }> = [];
  for (const rawPart of item.content) {
    if (!isRecord(rawPart)) continue;
    const type =
      typeof rawPart.type === 'string' && rawPart.type
        ? rawPart.type
        : 'output_text';
    nextParts.push({ type, text: readPartText(rawPart) });
  }
  if (nextParts.length > 0) target.content = nextParts;
}

function updateResponseMetadata(
  state: ResponsesStreamState,
  response: Record<string, unknown>,
): void {
  if (typeof response.id === 'string' && response.id) state.id = response.id;
  if (typeof response.model === 'string' && response.model) {
    state.model = response.model;
  }
  if (isRecord(response.usage)) state.usage = response.usage;
}

function parseStreamError(payload: Record<string, unknown>): string {
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  // `response.failed` carries its error on the response object.
  const error = isRecord(payload.error)
    ? payload.error
    : isRecord(payload.response)
      ? payload.response.error
      : undefined;
  if (isRecord(error)) {
    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    if (typeof error.code === 'string' && error.code.trim()) {
      return error.code.trim();
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

/**
 * Folds one stream event into `state`. Returns true on a terminal event;
 * throws on a provider error event.
 */
export function consumeResponsesStreamEvent(
  payloadText: string,
  eventName: string | null,
  state: ResponsesStreamState,
  handlers: ResponsesStreamHandlers,
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
  handlers.onActivity?.();

  const type =
    typeof payload.type === 'string' && payload.type
      ? payload.type
      : eventName || '';

  if (
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.error'
  ) {
    throw new Error(parseStreamError(payload));
  }

  if (isRecord(payload.response)) {
    updateResponseMetadata(state, payload.response);
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    if (isRecord(payload.response)) state.completedResponse = payload.response;
    return true;
  }

  const outputIndex =
    typeof payload.output_index === 'number' && payload.output_index >= 0
      ? payload.output_index
      : undefined;
  const itemId =
    typeof payload.item_id === 'string' ? payload.item_id : undefined;
  const contentIndex =
    typeof payload.content_index === 'number' ? payload.content_index : 0;

  if (
    (type === 'response.output_item.added' ||
      type === 'response.output_item.done') &&
    isRecord(payload.item)
  ) {
    mergeOutputItem(state.output, payload.item, outputIndex);
    return false;
  }

  if (type === 'response.content_part.added' && isRecord(payload.part)) {
    const item = ensureMessageItem(state.output, outputIndex, itemId);
    const part = ensureContentPart(
      item,
      contentIndex,
      typeof payload.part.type === 'string' && payload.part.type
        ? payload.part.type
        : 'output_text',
    );
    const text = readPartText(payload.part);
    if (text) part.text = text;
    return false;
  }

  if (type === 'response.output_text.delta') {
    const item = ensureMessageItem(state.output, outputIndex, itemId);
    const part = ensureContentPart(item, contentIndex);
    const delta =
      typeof payload.delta === 'string'
        ? payload.delta
        : typeof payload.text === 'string'
          ? payload.text
          : '';
    if (delta) {
      part.text += delta;
      handlers.onTextDelta(delta);
    }
    return false;
  }

  if (type === 'response.output_text.done') {
    const item = ensureMessageItem(state.output, outputIndex, itemId);
    const part = ensureContentPart(item, contentIndex);
    const finalText = readPartText(payload);
    if (finalText && (!part.text || finalText.length >= part.text.length)) {
      part.text = finalText;
    }
    return false;
  }

  if (type === 'response.function_call_arguments.delta') {
    const item = ensureFunctionCallItem(state.output, outputIndex, itemId);
    if (typeof payload.delta === 'string') item.arguments += payload.delta;
    return false;
  }

  if (type === 'response.function_call_arguments.done') {
    const item = ensureFunctionCallItem(state.output, outputIndex, itemId);
    const finalArguments =
      typeof payload.arguments === 'string'
        ? payload.arguments
        : typeof payload.output === 'string'
          ? payload.output
          : '';
    if (finalArguments) item.arguments = finalArguments;
  }
  return false;
}

function serializeOutput(
  output: Array<AccumulatedOutputItem | null>,
): Array<Record<string, unknown>> {
  const serialized: Array<Record<string, unknown>> = [];
  for (const item of output) {
    if (!item) continue;
    if (item.type === 'message') {
      serialized.push({
        type: 'message',
        ...(item.id ? { id: item.id } : {}),
        role: item.role,
        content: item.content.map((part) => ({ ...part })),
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

/**
 * The final completion: the terminal response object when one arrived, with
 * the streamed items standing in for an empty `output`.
 */
export function buildResponsesStreamResponse<TUsage = Record<string, unknown>>(
  state: ResponsesStreamState,
  fallbackModel: string,
): ResponsesCompletion<TUsage> {
  const streamedOutput = serializeOutput(state.output);
  if (state.completedResponse) {
    return adaptResponsesPayload<TUsage>(
      state.completedResponse,
      fallbackModel,
      streamedOutput,
    );
  }
  return adaptResponsesPayload<TUsage>(
    {
      id: state.id || 'response',
      model: state.model || normalizeCodexModelName(fallbackModel),
      output: streamedOutput,
      ...(state.usage ? { usage: state.usage } : {}),
    },
    fallbackModel,
  );
}
