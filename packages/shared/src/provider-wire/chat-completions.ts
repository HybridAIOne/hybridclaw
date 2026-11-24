/**
 * OpenAI-compatible chat-completions codec — the base request body and the
 * stream-chunk reducer that the HybridAI and local worker providers and the
 * gateway model client share.
 *
 * The reducer accepts both delta chunks and full-message snapshots; when a
 * chunk carries both, the snapshot wins so text is never counted twice. It
 * returns the new visible and reasoning text and leaves routing it (thinking
 * filters, tool-markup filters, callbacks) and provider error handling to
 * the caller. Pure: no fetch, stream reading, or logging.
 */
import type {
  AnthropicContentBlock,
  ToolCall,
} from '@hybridclaw/contracts/agent-io';
import { isRecord, parseNonNegativeInteger } from '../primitive-values.ts';

export type ChatCompletionsToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatCompletionsRequestParams {
  model: string;
  messages: unknown[];
  tools: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
}

export function buildChatCompletionsBody(
  params: ChatCompletionsRequestParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
  };
  if (params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice || 'auto';
  }
  if (
    typeof params.maxTokens === 'number' &&
    Number.isFinite(params.maxTokens) &&
    params.maxTokens > 0
  ) {
    body.max_tokens = Math.floor(params.maxTokens);
  }
  return body;
}

export function extractStructuredReasoning(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const candidate of [value.reasoning_content, value.reasoning]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

export function readChatCompletionsReasoningTokens(
  usage: unknown,
): number | null {
  if (!isRecord(usage) || !isRecord(usage.completion_tokens_details))
    return null;
  return parseNonNegativeInteger(
    usage.completion_tokens_details.reasoning_tokens,
  );
}

export interface ChatCompletionsStreamState<TUsage = Record<string, unknown>> {
  id: string;
  model: string;
  role: string;
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  anthropicContent: AnthropicContentBlock[];
  finishReason: string | null;
  usage?: TUsage;
}

export function createChatCompletionsStreamState<
  TUsage = Record<string, unknown>,
>(model: string): ChatCompletionsStreamState<TUsage> {
  return {
    id: '',
    model,
    role: 'assistant',
    content: '',
    reasoning: '',
    toolCalls: [],
    anthropicContent: [],
    finishReason: null,
  };
}

function ensureToolCall(toolCalls: ToolCall[], index: number): ToolCall {
  while (toolCalls.length <= index) {
    toolCalls.push({
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    });
  }
  return toolCalls[index];
}

function mergeToolCallDelta(
  target: ToolCall,
  delta: Record<string, unknown>,
): void {
  if (typeof delta.id === 'string') target.id += delta.id;
  if (!isRecord(delta.function)) return;
  if (typeof delta.function.name === 'string') {
    target.function.name += delta.function.name;
  }
  if (typeof delta.function.arguments === 'string') {
    target.function.arguments += delta.function.arguments;
  }
}

function snapshotDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function readToolCallSnapshot(value: unknown): ToolCall {
  const call = isRecord(value) ? value : {};
  const fn = isRecord(call.function) ? call.function : {};
  return {
    id: typeof call.id === 'string' ? call.id : '',
    type: 'function',
    function: {
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
    },
  };
}

/** Folds one parsed chunk into `state` and returns the text it added. */
export function applyChatCompletionsChunk<TUsage>(
  state: ChatCompletionsStreamState<TUsage>,
  payload: Record<string, unknown>,
): { content: string; reasoning: string } {
  const added = { content: '', reasoning: '' };
  if (typeof payload.id === 'string' && payload.id) state.id = payload.id;
  if (typeof payload.model === 'string' && payload.model) {
    state.model = payload.model;
  }
  if (isRecord(payload.usage)) state.usage = payload.usage as TUsage;

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!isRecord(choice)) return added;

  let usedMessageContent = false;
  let usedMessageReasoning = false;
  if (isRecord(choice.message)) {
    const message = choice.message;
    if (typeof message.role === 'string' && message.role) {
      state.role = message.role;
    }
    if (typeof message.content === 'string' && message.content) {
      usedMessageContent = true;
      added.content = snapshotDelta(state.content, message.content);
      state.content = message.content;
    }
    const reasoning = extractStructuredReasoning(message);
    if (reasoning) {
      added.reasoning = snapshotDelta(state.reasoning, reasoning);
      usedMessageReasoning = added.reasoning.length > 0;
      state.reasoning = reasoning;
    }
    if (Array.isArray(message.anthropic_content)) {
      state.anthropicContent = message.anthropic_content;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      state.toolCalls = message.tool_calls.map(readToolCallSnapshot);
    }
  }

  if (isRecord(choice.delta)) {
    const delta = choice.delta;
    if (typeof delta.role === 'string' && delta.role) state.role = delta.role;
    if (
      !usedMessageContent &&
      typeof delta.content === 'string' &&
      delta.content
    ) {
      state.content += delta.content;
      added.content += delta.content;
    }
    const reasoning = extractStructuredReasoning(delta);
    if (!usedMessageReasoning && reasoning) {
      state.reasoning += reasoning;
      added.reasoning += reasoning;
    }
    if (Array.isArray(delta.anthropic_content)) {
      state.anthropicContent = delta.anthropic_content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const callDelta of delta.tool_calls) {
        if (!isRecord(callDelta)) continue;
        const index =
          typeof callDelta.index === 'number' && callDelta.index >= 0
            ? callDelta.index
            : 0;
        mergeToolCallDelta(ensureToolCall(state.toolCalls, index), callDelta);
      }
    }
  }

  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
  return added;
}
