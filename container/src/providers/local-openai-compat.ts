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
  ChatMessageContent,
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
    provider !== 'llamacpp' &&
    provider !== 'browser'
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

function buildLiquidToolCallInstruction(tools: ToolDefinition[]): string {
  const toolList = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  return `Use tools when needed. Liquid tool call format: <|tool_call_start|>[tools.<tool_name>(key=value)]<|tool_call_end|>. List of tools: ${JSON.stringify(toolList)}`;
}

function estimatePromptToolInstructionTokens(instruction: string): number {
  if (!instruction) return 0;
  return Math.max(1, Math.ceil(instruction.length / 4) + 16);
}

const BROWSER_MODEL_SYSTEM_PROMPT =
  'You are HybridClaw, a concise helpful assistant. Answer directly. ' +
  'Use a tool only when it helps, and only tools that are explicitly listed — ' +
  'never invent tool or function names. If no listed tool fits, answer ' +
  'normally without a tool call.';
const BROWSER_MODEL_HISTORY_LIMIT = 6;
const BROWSER_MODEL_TOTAL_PROMPT_CHARS = 12_000;
const BROWSER_MODEL_MESSAGE_CHARS = 6_000;
const BROWSER_MODEL_TOOL_LIMIT = 64;
const BROWSER_MODEL_TOOL_TOTAL_CHARS = 20_000;
// Browser models get a one-line tool description (NemoClaw-style); per-parameter
// description prose is stripped entirely (see compactBrowserToolProperty).
const BROWSER_MODEL_TOOL_DESCRIPTION_CHARS = 240;
const BROWSER_MODEL_TOOL_PROPERTY_LIMIT = 32;
const BROWSER_MODEL_MAX_REQUEST_TOKENS = 256;
const TRUNCATED_TEXT_SUFFIX = '\n\n[truncated]';

export function estimateLocalOpenAICompatPromptOverheadTokens(args: {
  provider: string | undefined;
  model: string;
  tools?: ToolDefinition[];
  modelBehavior?: NormalizedCallArgs['modelBehavior'];
}): number {
  if (args.provider === 'browser') return 0;
  const tools = Array.isArray(args.tools) ? args.tools : [];
  if (tools.length === 0) return 0;
  if (usesLiquidCompat(args)) {
    return estimatePromptToolInstructionTokens(
      buildLiquidToolCallInstruction(tools),
    );
  }
  return 0;
}

function contentToText(content: ChatMessageContent): string {
  if (typeof content === 'string') return replaceUnpairedSurrogates(content);
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type !== 'text' || !part.text) continue;
    chunks.push(replaceUnpairedSurrogates(part.text));
  }
  return chunks.join('\n');
}

function truncateBrowserPromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_TEXT_SUFFIX.length) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATED_TEXT_SUFFIX.length)}${TRUNCATED_TEXT_SUFFIX}`;
}

function truncateBrowserToolText(text: string, maxChars: number): string {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function browserToolPriority(tool: ToolDefinition, index: number): number {
  const name = tool.function.name.toLowerCase();
  if (name === 'bash' || name === 'shell') return index - 10_000;
  if (
    name.includes('bash') ||
    name.includes('shell') ||
    name.includes('exec') ||
    name.includes('terminal')
  ) {
    return index - 8_000;
  }
  if (
    name.includes('read') ||
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('patch') ||
    name.includes('file')
  ) {
    return index - 6_000;
  }
  if (
    name.includes('web') ||
    name.includes('browser') ||
    name.includes('search') ||
    name.includes('fetch')
  ) {
    return index - 4_000;
  }
  return index;
}

type BrowserToolProperty =
  ToolDefinition['function']['parameters']['properties'][string];

// NemoClaw-style schema compaction: keep the structure a weak model needs to
// emit a valid call (types, enums, nested properties, required, item/array
// bounds) but drop the description prose, which dominates browser prompt size.
function compactBrowserToolProperty(
  property: BrowserToolProperty,
): BrowserToolProperty {
  const compacted: BrowserToolProperty = { type: property.type };
  if (property.enum) compacted.enum = property.enum;
  if (typeof property.minItems === 'number') {
    compacted.minItems = property.minItems;
  }
  if (typeof property.maxItems === 'number') {
    compacted.maxItems = property.maxItems;
  }
  if (property.required) compacted.required = property.required;
  if (property.items) {
    compacted.items = compactBrowserToolProperty(property.items);
  }
  if (property.properties) {
    const nested: Record<string, BrowserToolProperty> = {};
    for (const [key, value] of Object.entries(property.properties)) {
      if (value) nested[key] = compactBrowserToolProperty(value);
    }
    compacted.properties = nested;
  }
  if (typeof property.additionalProperties === 'boolean') {
    compacted.additionalProperties = property.additionalProperties;
  } else if (property.additionalProperties) {
    compacted.additionalProperties = compactBrowserToolProperty(
      property.additionalProperties,
    );
  }
  return compacted;
}

function compactBrowserToolParameters(
  parameters: ToolDefinition['function']['parameters'],
): ToolDefinition['function']['parameters'] {
  const properties: ToolDefinition['function']['parameters']['properties'] = {};
  const propertyNames = Object.keys(parameters.properties || {}).slice(
    0,
    BROWSER_MODEL_TOOL_PROPERTY_LIMIT,
  );
  for (const name of propertyNames) {
    const property = parameters.properties[name];
    if (!property) continue;
    properties[name] = compactBrowserToolProperty(property);
  }
  return {
    type: 'object',
    properties,
    required: (parameters.required || []).filter((name) =>
      Object.hasOwn(properties, name),
    ),
  };
}

function compactBrowserTool(
  tool: ToolDefinition,
  withCallExample = false,
): ToolDefinition | null {
  const name = String(tool.function.name || '').trim();
  if (!name) return null;
  const parameters = compactBrowserToolParameters(tool.function.parameters);
  let description = truncateBrowserToolText(
    tool.function.description,
    BROWSER_MODEL_TOOL_DESCRIPTION_CHARS,
  );
  if (withCallExample) {
    // Small models produce the argument value far more reliably when the
    // description shows the call shape (measured on LFM2.5-350M: without an
    // example it emits empty arguments). Derive the parameter from the
    // COMPACTED schema so the example never names a stripped property.
    const properties = Object.keys(parameters.properties || {});
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter(
          (entry): entry is string =>
            typeof entry === 'string' && properties.includes(entry),
        )
      : [];
    const first = required[0] || properties[0] || '';
    if (first) description = `${description} Example: ${name}(${first}="...")`;
  }
  return {
    type: 'function',
    function: { name, description, parameters },
  };
}

function buildBrowserRequestTools(
  tools: ToolDefinition[],
  toolLimit: number = BROWSER_MODEL_TOOL_LIMIT,
  withCallExamples = false,
): ToolDefinition[] {
  const compactTools = tools
    .map((tool, index) => ({
      index,
      tool: compactBrowserTool(tool, withCallExamples),
    }))
    .filter(
      (entry): entry is { index: number; tool: ToolDefinition } =>
        entry.tool !== null,
    )
    .sort(
      (left, right) =>
        browserToolPriority(left.tool, left.index) -
        browserToolPriority(right.tool, right.index),
    );

  const selected: ToolDefinition[] = [];
  let totalChars = 2;
  for (const entry of compactTools) {
    if (selected.length >= toolLimit) break;
    const serialized = JSON.stringify(entry.tool);
    if (
      selected.length > 0 &&
      totalChars + serialized.length > BROWSER_MODEL_TOOL_TOTAL_CHARS
    ) {
      break;
    }
    selected.push(entry.tool);
    totalChars += serialized.length + 1;
  }
  return selected;
}

// Large-vocabulary models have a tiny in-browser prompt budget: the prefill
// logits overflow caps Gemma's rendered prompt near ~1.7K tokens, so the whole
// conversation (system + tools + messages) must be budgeted to fit.
function isTightBudgetBrowserModel(model: string): boolean {
  return model.toLowerCase().includes('gemma');
}

// Vision-language browser models (e.g. .../LFM2.5-VL-450M-ONNX) accept image
// content parts and load via AutoModelForImageTextToText in the bridge. Their
// message content (including images) must pass through untouched.
function isVisionBrowserModel(model: string): boolean {
  return /(^|[/_.-])vl([/_.-]|$)|vision/i.test(model);
}

// Total char budget for the tight-model message content (system + messages).
// Gemma's ~1740-token guard is on the *rendered* prompt, which also carries the
// chat template scaffolding and the rendered tool declarations; the tool share
// is subtracted per-request (see buildRequestMessages). Measured live with 12
// native tools and a 21-line tool result: 1413/1740 tokens.
const BROWSER_MODEL_TIGHT_CONTENT_CHARS = 3200;

function browserModelContentBudgetChars(model: string): number {
  return isTightBudgetBrowserModel(model)
    ? BROWSER_MODEL_TIGHT_CONTENT_CHARS
    : BROWSER_MODEL_TOTAL_PROMPT_CHARS;
}

// Small Liquid/LFM models (≤~1.2B, including the vision variants) reliably use
// tool calls, but only with a short tool list — Liquid's own guidance is to
// include just the relevant tools. Given a long noisy list (dozens of tools) a
// 350M hallucinates a non-existent tool name (e.g. "browser_watch"). They also
// need the call-shape example in the tool description to produce argument
// values (see compactBrowserTool).
function isSmallLiquidBrowserModel(model: string): boolean {
  const lower = model.toLowerCase();
  if (!(lower.includes('lfm') || lower.includes('liquid'))) return false;
  return /(^|[^0-9])(230m|350m|450m|700m|1\.2b)([^0-9]|$)/.test(lower);
}

// Tool-list caps, applied to the priority-sorted native list (bash and file
// tools first). Small Liquid models get a short list per Liquid's guidance;
// Gemma's cap keeps the rendered declarations inside its token guard (12 tools
// measured ≈500 rendered tokens); everything else keeps the full compacted set.
const BROWSER_MODEL_SMALL_TOOL_LIMIT = 16;
const BROWSER_MODEL_TIGHT_TOOL_LIMIT = 12;
function browserModelToolLimit(model: string): number {
  if (isTightBudgetBrowserModel(model)) return BROWSER_MODEL_TIGHT_TOOL_LIMIT;
  return isSmallLiquidBrowserModel(model)
    ? BROWSER_MODEL_SMALL_TOOL_LIMIT
    : BROWSER_MODEL_TOOL_LIMIT;
}

function normalizeBrowserRequestRole(
  role: ChatMessage['role'],
): 'user' | 'assistant' | 'tool' | null {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role;
  return null;
}

function normalizeBrowserToolCalls(
  toolCalls: ChatMessage['tool_calls'],
): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((toolCall) => ({
      id: String(toolCall.id || ''),
      type: 'function' as const,
      function: {
        name: String(toolCall.function?.name || ''),
        arguments: String(toolCall.function?.arguments || '{}'),
      },
    }))
    .filter((toolCall) => toolCall.function.name);
}

// Newest images win; each one expands into hundreds of prompt tokens.
const BROWSER_MODEL_IMAGE_LIMIT = 2;

// Bounded message builder for vision models: same history/char caps as the
// text path, but image parts are preserved (up to the image limit) instead of
// being flattened away.
function buildVisionBrowserMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const collapsed = collapseSystemMessages(messages);
  const system = collapsed[0]?.role === 'system' ? collapsed[0] : null;
  const rest = system ? collapsed.slice(1) : collapsed;
  const selected: Array<Record<string, unknown>> = [];
  let remainingChars = BROWSER_MODEL_TOTAL_PROMPT_CHARS;
  let imagesKept = 0;

  for (
    let index = rest.length - 1;
    index >= 0 && selected.length < BROWSER_MODEL_HISTORY_LIMIT;
    index -= 1
  ) {
    const message = rest[index];
    if (!message || remainingChars <= 0) break;
    const normalized = normalizeMessageContent(message.content);
    let content: ChatMessage['content'];
    if (Array.isArray(normalized)) {
      const parts: typeof normalized = [];
      for (const part of normalized) {
        if (part.type === 'text') {
          const maxChars = Math.max(
            0,
            Math.min(BROWSER_MODEL_MESSAGE_CHARS, remainingChars),
          );
          const text = truncateBrowserPromptText(part.text, maxChars);
          remainingChars -= text.length;
          parts.push({ ...part, text });
        } else if (part.type === 'image_url') {
          if (imagesKept < BROWSER_MODEL_IMAGE_LIMIT) {
            imagesKept += 1;
            parts.push(part);
          }
        } else {
          parts.push(part);
        }
      }
      content = parts;
    } else {
      const text = contentToText(message.content).trim();
      const maxChars = Math.max(
        0,
        Math.min(BROWSER_MODEL_MESSAGE_CHARS, remainingChars),
      );
      const truncated = truncateBrowserPromptText(text, maxChars);
      remainingChars -= truncated.length;
      content = truncated;
    }
    selected.push({ ...message, content });
  }

  selected.reverse();
  return system
    ? [
        { ...system, content: normalizeMessageContent(system.content) },
        ...selected,
      ]
    : selected;
}

function buildBrowserRequestMessages(
  messages: ChatMessage[],
  messageBudgetChars: number = BROWSER_MODEL_TOTAL_PROMPT_CHARS,
  systemSuffix = '',
): Array<Record<string, unknown>> {
  const selected: Array<Record<string, unknown>> = [];
  let remainingChars = messageBudgetChars;

  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < BROWSER_MODEL_HISTORY_LIMIT;
    index -= 1
  ) {
    const message = messages[index];
    if (!message) continue;
    const role = normalizeBrowserRequestRole(message.role);
    if (!role) continue;
    const text = contentToText(message.content).trim();
    const toolCalls =
      role === 'assistant' ? normalizeBrowserToolCalls(message.tool_calls) : [];
    if (!text && toolCalls.length === 0) continue;
    const maxChars = Math.min(BROWSER_MODEL_MESSAGE_CHARS, remainingChars);
    if (maxChars <= 0) break;
    const content = truncateBrowserPromptText(text, maxChars);
    selected.push({
      role,
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(role === 'tool' && message.tool_call_id
        ? { tool_call_id: message.tool_call_id }
        : {}),
    });
    remainingChars -= content.length;
  }

  selected.reverse();
  return [
    {
      role: 'system',
      content: `${BROWSER_MODEL_SYSTEM_PROMPT}${systemSuffix}`,
    },
    ...selected,
  ];
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

// Assemble the tools and messages of a browser-model request together, so the
// compaction/cap runs once and the tight-model message budget is derived from
// the exact tool list that is sent.
function buildBrowserRequest(args: NormalizedCallArgs): {
  tools: ToolDefinition[];
  messages: Array<Record<string, unknown>>;
} {
  // Vision-language models take image content parts, which must survive (never
  // flatten to text) — but the request still needs bounds: an unbounded
  // history once produced a 91K-char prompt that overflowed the runtime and
  // took the host machine down. Same caps as text models, applied around the
  // image parts.
  if (isVisionBrowserModel(args.model)) {
    return {
      tools: buildBrowserRequestTools(
        args.tools,
        browserModelToolLimit(args.model),
        isSmallLiquidBrowserModel(args.model),
      ),
      messages: buildVisionBrowserMessages(args.messages),
    };
  }
  const tools = buildBrowserRequestTools(
    args.tools,
    browserModelToolLimit(args.model),
    isSmallLiquidBrowserModel(args.model),
  );
  // Tight-budget models (Gemma) must fit system + rendered tools + the whole
  // conversation (including accumulating tool results) under the token guard,
  // so bound the tool declarations and subtract their share from the message
  // budget rather than capping each part independently.
  const contentBudget = browserModelContentBudgetChars(args.model);
  const systemChars = BROWSER_MODEL_SYSTEM_PROMPT.length + 2;
  let toolShareChars = 0;
  if (isTightBudgetBrowserModel(args.model)) {
    // The chat template renders declarations slightly denser than the
    // serialized JSON (measured on gemma-4: ~0.6x the serialized length). A
    // count cap alone doesn't bound verbose schemas, so also shrink the
    // (priority-sorted) list until its rendered share leaves at least half the
    // content budget for messages. Keep a handful of core tools regardless.
    const shareOf = (list: ToolDefinition[]): number =>
      Math.floor(JSON.stringify(list).length * 0.6);
    while (
      tools.length > 4 &&
      shareOf(tools) > (contentBudget - systemChars) / 2
    ) {
      tools.pop();
    }
    toolShareChars = shareOf(tools);
  }
  const dropped = args.tools.length - tools.length;
  if (dropped > 0) {
    console.warn(
      `[local-openai-compat] browser tool list capped for ${args.model}: ` +
        `sending ${tools.length} of ${args.tools.length} tools ` +
        `(priority-ordered).`,
    );
  }
  const messageBudget = Math.max(
    1200,
    contentBudget - systemChars - toolShareChars,
  );
  return {
    tools,
    messages: buildBrowserRequestMessages(
      args.messages,
      messageBudget,
      dropped > 0
        ? ` ${dropped} more tools exist but are not listed; if a needed tool is missing, say so.`
        : '',
    ),
  };
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
  const browserRequest =
    args.provider === 'browser' ? buildBrowserRequest(args) : null;
  const tools = browserRequest ? browserRequest.tools : args.tools;
  const request: Record<string, unknown> = {
    model: normalizeLocalModelName(args.provider, args.model),
    messages: browserRequest
      ? browserRequest.messages
      : buildRequestMessages(args),
  };
  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = 'auto';
  }
  if (
    typeof args.maxTokens === 'number' &&
    Number.isFinite(args.maxTokens) &&
    args.maxTokens > 0
  ) {
    request.max_tokens =
      args.provider === 'browser'
        ? Math.min(Math.floor(args.maxTokens), BROWSER_MODEL_MAX_REQUEST_TOKENS)
        : Math.floor(args.maxTokens);
  }
  if (args.provider === 'browser' && args.debugModelResponses) {
    request.hybridclaw_debug_model_responses = true;
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
  const startMarkers = [
    '<tool_call>',
    '<tool>',
    '[tool_call]',
    '<function=',
    '<|tool_call_start|>',
    'call:',
  ];
  const endMarkerByStartMarker = new Map([
    ['<tool_call>', '</tool_call>'],
    ['<tool>', '</tool>'],
    ['[tool_call]', '[/tool_call]'],
    ['<function=', '</function>'],
    ['<|tool_call_start|>', '<|tool_call_end|>'],
    ['call:', '}'],
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
    text
      .replace(
        /(?:<|<\/|<tool|<tool_|<tool_call|<function=?|<\|?|<\|tool|<\|tool_call|<\|tool_call_start)$/i,
        '',
      )
      .replace(/(?:^|[\s#])call:?$/i, (match) =>
        match.startsWith(' ') ? ' ' : '',
      );

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
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...buildHeaders(args.apiKey),
      ...(args.requestHeaders || {}),
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(requestBody),
  });

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
  const shouldFilterToolMarkup =
    args.modelBehavior?.thinkingFormat === 'qwen' ||
    args.thinkingFormat === 'qwen' ||
    normalizationOptions.parser === 'qwen' ||
    normalizationOptions.parser === 'qwen3_coder' ||
    normalizationOptions.parser === 'hermes' ||
    normalizationOptions.parser === 'liquid';
  const streamEmitter = createThinkingStreamEmitter(args.onTextDelta, {
    onThinkingDelta: args.onThinkingDelta,
  });
  const visibleToolFilter = shouldFilterToolMarkup
    ? createToolMarkupStreamFilter((delta) => streamEmitter.pushVisible(delta))
    : null;
  const reasoningToolFilter = shouldFilterToolMarkup
    ? createToolMarkupStreamFilter((delta) => streamEmitter.pushThinking(delta))
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
