/**
 * OpenAI-compatible model boundary — normalizes provider variants into HybridClaw types.
 * Unlike provider selection, this module owns request/response wire-shape compatibility.
 * It does not persist usage or decide how token costs are presented.
 */
import { readProviderCacheUsage } from '@hybridclaw/shared/provider-cache-usage';
import {
  adaptResponsesPayload,
  buildResponsesRequestBody,
  buildResponsesStreamResponse,
  consumeResponsesStreamEvent,
  createResponsesStreamState,
  type ResponsesCompletion,
} from '@hybridclaw/shared/provider-wire/codex-responses';
import {
  drainServerSentEventBlocks,
  parseServerSentEventBlock,
} from '@hybridclaw/shared/server-sent-events';
import { stripHybridAIModelPrefix } from '../providers/model-names.js';
import {
  isOpenAICompatProviderId,
  type RuntimeProviderId,
} from '../providers/provider-ids.js';
import type { ResolvedModelRuntimeCredentials } from '../providers/types.js';
import type { ChatMessage, ToolCall } from '../types/api.js';
import type { TokenUsageStats } from '../types/usage.js';
import { isRecord } from '../utils/type-guards.js';

export interface OpenAICompatibleToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type OpenAICompatibleToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | {
      type: 'function';
      function: {
        name: string;
      };
    };

// Upstream usage payload. Cache fields are optional and spelled differently
// per provider family (OpenAI-style prompt_tokens_details.cached_tokens vs
// Anthropic-style cache_read_input_tokens), so accept both spellings rather
// than dropping cache usage for whichever provider did not match.
export interface OpenAICompatibleUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface OpenAICompatibleModelResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: ChatMessage['content'];
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: OpenAICompatibleUsagePayload;
}

interface OpenAICompatibleModelCallParams {
  runtime: ResolvedModelRuntimeCredentials;
  model: string;
  messages: ChatMessage[];
  tools: OpenAICompatibleToolDefinition[];
  toolChoice?: OpenAICompatibleToolChoice;
}

interface OpenAICompatibleModelStreamParams
  extends OpenAICompatibleModelCallParams {
  onTextDelta: (delta: string) => void;
}

function buildHeaders(params: {
  apiKey: string;
  requestHeaders?: Record<string, string>;
  accept?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(params.requestHeaders || {}),
  };
  const apiKey = String(params.apiKey || '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (params.accept) headers.Accept = params.accept;
  return headers;
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
}

function normalizeOpenRouterRuntimeModelName(model: string): string {
  const trimmed = String(model || '').trim();
  const prefix = 'openrouter/';
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  const upstreamModel = trimmed.slice(prefix.length).trim();
  return upstreamModel.includes('/') ? upstreamModel : trimmed;
}

function normalizeOpenAICompatModelName(
  provider: RuntimeProviderId,
  model: string,
): string {
  const trimmed = String(model || '').trim();
  if (provider === 'openrouter') {
    return normalizeOpenRouterRuntimeModelName(trimmed);
  }
  if (provider === 'huggingface') {
    const prefix = 'huggingface/';
    return trimmed.toLowerCase().startsWith(prefix)
      ? trimmed.slice(prefix.length) || trimmed
      : trimmed;
  }
  const prefix = `${provider}/`;
  return trimmed.toLowerCase().startsWith(prefix)
    ? trimmed.slice(prefix.length) || trimmed
    : trimmed;
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const textBlocks: string[] = [];
  for (const part of content) {
    if (part.type !== 'text') continue;
    if (!part.text) continue;
    textBlocks.push(part.text);
  }
  return textBlocks.join('\n');
}

function collapseSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemBlocks: string[] = [];
  const remaining: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'system') {
      remaining.push({ ...message });
      continue;
    }
    const text = contentToText(message.content).trim();
    if (text) systemBlocks.push(text);
  }
  if (systemBlocks.length === 0) {
    return messages.map((message) => ({ ...message }));
  }
  return [
    {
      role: 'system',
      content: systemBlocks.join('\n\n'),
    },
    ...remaining,
  ];
}

function parseErrorText(body: string): string {
  const trimmed = String(body || '').trim();
  if (!trimmed) return 'Unknown provider error';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message =
        typeof parsed.error.message === 'string'
          ? parsed.error.message.trim()
          : '';
      if (message) return message;
    }
  } catch {
    // fall back to raw text
  }
  return trimmed;
}

function createProviderError(status: number, body: string): Error {
  return new Error(
    `OpenAI-compatible model call failed with ${status}: ${parseErrorText(body)}`,
  );
}

function buildHybridAIRequestBody(
  params: OpenAICompatibleModelCallParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: stripHybridAIModelPrefix(params.model),
    messages: params.messages,
    // The bot is optional, and RAG searches the bot's knowledge.
    ...(params.runtime.chatbotId
      ? {
          chatbot_id: params.runtime.chatbotId,
          enable_rag: params.runtime.enableRag,
        }
      : {}),
  };
  if (params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice || 'auto';
  }
  return body;
}

function buildOpenAICompatRequestBody(
  params: OpenAICompatibleModelCallParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: normalizeOpenAICompatModelName(
      params.runtime.provider,
      params.runtime.model || params.model,
    ),
    messages: collapseSystemMessages(params.messages),
  };
  if (params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice || 'auto';
  }
  return body;
}

function buildChatCompletionsUrl(
  runtime: ResolvedModelRuntimeCredentials,
): string {
  const baseUrl = normalizeBaseUrl(runtime.baseUrl);
  if (
    runtime.provider === 'anthropic' ||
    isOpenAICompatProviderId(runtime.provider)
  ) {
    return `${baseUrl}/chat/completions`;
  }
  return `${baseUrl}/v1/chat/completions`;
}

function buildChatCompletionsRequestBody(
  params: OpenAICompatibleModelCallParams,
): Record<string, unknown> {
  return params.runtime.provider === 'hybridai'
    ? buildHybridAIRequestBody(params)
    : buildOpenAICompatRequestBody(params);
}

function buildCodexRequest(
  params: OpenAICompatibleModelCallParams,
  stream: boolean,
): string {
  return JSON.stringify({
    ...buildResponsesRequestBody({
      provider: params.runtime.provider,
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      toolChoice: params.toolChoice,
    }),
    ...(stream ? { stream: true } : {}),
  });
}

function toModelResponse(
  completion: ResponsesCompletion<OpenAICompatibleUsagePayload>,
): OpenAICompatibleModelResponse {
  const message = completion.choices[0]?.message;
  const content = Array.isArray(message?.content)
    ? message.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('') || null
    : (message?.content ?? null);
  return {
    id: completion.id,
    model: completion.model,
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          ...(message?.tool_calls ? { tool_calls: message.tool_calls } : {}),
        },
        finish_reason: completion.choices[0]?.finish_reason || 'stop',
      },
    ],
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
}

function adaptCodexResponse(
  payload: unknown,
  model: string,
): OpenAICompatibleModelResponse {
  return toModelResponse(
    adaptResponsesPayload<OpenAICompatibleUsagePayload>(payload, model),
  );
}

export async function callOpenAICompatibleModel(
  params: OpenAICompatibleModelCallParams,
): Promise<OpenAICompatibleModelResponse> {
  if (params.runtime.provider === 'openai-codex') {
    const response = await fetch(
      `${normalizeBaseUrl(params.runtime.baseUrl)}/responses`,
      {
        method: 'POST',
        headers: buildHeaders({
          apiKey: params.runtime.apiKey,
          requestHeaders: params.runtime.requestHeaders,
        }),
        body: buildCodexRequest(params, false),
      },
    );
    if (!response.ok) {
      throw createProviderError(response.status, await response.text());
    }
    return adaptCodexResponse(await response.json(), params.model);
  }

  const url = buildChatCompletionsUrl(params.runtime);
  const body = buildChatCompletionsRequestBody(params);
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders({
      apiKey: params.runtime.apiKey,
      requestHeaders: params.runtime.requestHeaders,
    }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw createProviderError(response.status, await response.text());
  }
  return (await response.json()) as OpenAICompatibleModelResponse;
}

export async function callOpenAICompatibleModelStream(
  params: OpenAICompatibleModelStreamParams,
): Promise<OpenAICompatibleModelResponse> {
  if (params.runtime.provider === 'openai-codex') {
    const response = await fetch(
      `${normalizeBaseUrl(params.runtime.baseUrl)}/responses`,
      {
        method: 'POST',
        headers: buildHeaders({
          apiKey: params.runtime.apiKey,
          requestHeaders: params.runtime.requestHeaders,
          accept: 'text/event-stream, application/json',
        }),
        body: buildCodexRequest(params, true),
      },
    );
    if (!response.ok) {
      throw createProviderError(response.status, await response.text());
    }
    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    if (
      contentType.includes('application/json') &&
      !contentType.includes('event-stream')
    ) {
      const adapted = adaptCodexResponse(await response.json(), params.model);
      const content = adapted.choices[0]?.message.content;
      if (typeof content === 'string' && content) params.onTextDelta(content);
      return adapted;
    }
    if (!response.body) {
      return adaptCodexResponse(await response.json(), params.model);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = createResponsesStreamState(params.model);
    const handlers = { onTextDelta: params.onTextDelta };
    let buffer = '';
    let done = false;
    try {
      while (!done) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const drained = drainServerSentEventBlocks(buffer);
        buffer = drained.remainder;
        for (const block of drained.blocks) {
          const event = parseServerSentEventBlock(block);
          if (!event) continue;
          done = consumeResponsesStreamEvent(
            event.data,
            event.event,
            state,
            handlers,
          );
          if (done) break;
        }
      }
      const tail = done ? null : parseServerSentEventBlock(buffer);
      if (tail)
        consumeResponsesStreamEvent(tail.data, tail.event, state, handlers);
    } finally {
      reader.releaseLock();
      decoder.decode();
    }
    return toModelResponse(
      buildResponsesStreamResponse<OpenAICompatibleUsagePayload>(
        state,
        params.model,
      ),
    );
  }

  const url = buildChatCompletionsUrl(params.runtime);
  const body = buildChatCompletionsRequestBody(params);
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders({
      apiKey: params.runtime.apiKey,
      requestHeaders: params.runtime.requestHeaders,
      accept: 'text/event-stream, application/json',
    }),
    body: JSON.stringify({
      ...body,
      stream: true,
      stream_options: {
        include_usage: true,
      },
    }),
  });
  if (!response.ok) {
    throw createProviderError(response.status, await response.text());
  }
  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    contentType.includes('application/json') &&
    !contentType.includes('event-stream')
  ) {
    const payload = (await response.json()) as OpenAICompatibleModelResponse;
    const content = payload.choices[0]?.message.content;
    const toolCalls = payload.choices[0]?.message.tool_calls || [];
    if (toolCalls.length === 0 && typeof content === 'string' && content) {
      params.onTextDelta(content);
    }
    return payload;
  }
  if (!response.body) {
    return (await response.json()) as OpenAICompatibleModelResponse;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamId = '';
  let streamModel = params.model;
  let text = '';
  let usage: OpenAICompatibleModelResponse['usage'] | undefined;
  const toolCalls: ToolCall[] = [];
  let finishReason = 'stop';

  const ensureToolCall = (index: number): ToolCall => {
    while (toolCalls.length <= index) {
      toolCalls.push({
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
    }
    return toolCalls[index] as ToolCall;
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed?.startsWith('data:')) continue;
        const payloadText = trimmed.slice(5).trim();
        if (!payloadText || payloadText === '[DONE]') continue;
        let payload: unknown;
        try {
          payload = JSON.parse(payloadText) as unknown;
        } catch {
          continue;
        }
        if (!isRecord(payload)) continue;
        if (typeof payload.id === 'string' && payload.id) streamId = payload.id;
        if (typeof payload.model === 'string' && payload.model) {
          streamModel = payload.model;
        }
        if (isRecord(payload.usage)) {
          usage = payload.usage as OpenAICompatibleModelResponse['usage'];
        }
        const choice = Array.isArray(payload.choices)
          ? payload.choices[0]
          : undefined;
        if (!isRecord(choice)) continue;
        if (isRecord(choice.delta)) {
          const delta = choice.delta;
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            params.onTextDelta(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const rawToolCall of delta.tool_calls) {
              if (!isRecord(rawToolCall)) continue;
              const index =
                typeof rawToolCall.index === 'number' && rawToolCall.index >= 0
                  ? rawToolCall.index
                  : 0;
              const target = ensureToolCall(index);
              if (typeof rawToolCall.id === 'string' && rawToolCall.id) {
                target.id += rawToolCall.id;
              }
              if (isRecord(rawToolCall.function)) {
                if (
                  typeof rawToolCall.function.name === 'string' &&
                  rawToolCall.function.name
                ) {
                  target.function.name += rawToolCall.function.name;
                }
                if (
                  typeof rawToolCall.function.arguments === 'string' &&
                  rawToolCall.function.arguments
                ) {
                  target.function.arguments += rawToolCall.function.arguments;
                }
              }
            }
          }
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }

  return {
    id: streamId || 'stream',
    model: streamModel,
    choices: [
      {
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

export function mapOpenAICompatibleUsageToTokenStats(
  usage?: OpenAICompatibleUsagePayload,
): TokenUsageStats | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const { cacheReadTokens, cacheWriteTokens } = readProviderCacheUsage(usage);
  const cacheUsageAvailable =
    cacheReadTokens !== undefined || cacheWriteTokens !== undefined;
  return {
    modelCalls: 1,
    modelRetries: 0,
    apiUsageAvailable: true,
    apiPromptTokens: promptTokens,
    apiCompletionTokens: completionTokens,
    apiTotalTokens: totalTokens,
    apiCacheUsageAvailable: cacheUsageAvailable,
    apiCacheReadTokens: cacheReadTokens ?? 0,
    apiCacheWriteTokens: cacheWriteTokens ?? 0,
    estimatedPromptTokens: promptTokens,
    estimatedCompletionTokens: completionTokens,
    estimatedTotalTokens: totalTokens,
  };
}
