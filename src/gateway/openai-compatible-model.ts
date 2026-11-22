/**
 * OpenAI-compatible model boundary — normalizes provider variants into HybridClaw types.
 * Unlike provider selection, this module owns request/response wire-shape compatibility.
 * It does not persist usage or decide how token costs are presented.
 */
import { readProviderCacheUsage } from '@hybridclaw/shared/provider-cache-usage';
import {
  applyChatCompletionsChunk,
  buildChatCompletionsBody,
  type ChatCompletionsToolChoice,
  createChatCompletionsStreamState,
} from '@hybridclaw/shared/provider-wire/chat-completions';
import {
  adaptResponsesPayload,
  buildResponsesRequestBody,
  buildResponsesStreamResponse,
  consumeResponsesStreamEvent,
  createResponsesStreamState,
  type ResponsesCompletion,
} from '@hybridclaw/shared/provider-wire/codex-responses';
import { buildHybridAIRequestBody } from '@hybridclaw/shared/provider-wire/hybridai-body';
import { normalizeOpenAICompatModelName } from '@hybridclaw/shared/provider-wire/model-names';
import { readServerSentEvents } from '@hybridclaw/shared/provider-wire/server-sent-events';
import { resolveProviderRequestMaxTokens } from '@hybridclaw/shared/request-max-tokens';
import { collapseSystemMessages } from '@hybridclaw/shared/system-messages';
import { isOpenAICompatProviderId } from '../providers/provider-ids.js';
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
  toolChoice?: ChatCompletionsToolChoice;
  promptCacheKey?: string;
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

function buildOpenAICompatRequestBody(
  params: OpenAICompatibleModelCallParams,
): Record<string, unknown> {
  return buildChatCompletionsBody({
    model: normalizeOpenAICompatModelName(
      params.runtime.provider,
      params.runtime.model || params.model,
    ),
    messages: collapseSystemMessages(params.messages),
    tools: params.tools,
    toolChoice: params.toolChoice,
  });
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
  if (params.runtime.provider !== 'hybridai') {
    return buildOpenAICompatRequestBody(params);
  }
  return buildHybridAIRequestBody({
    model: params.model,
    messages: params.messages,
    chatbotId: params.runtime.chatbotId,
    enableRag: params.runtime.enableRag,
    tools: params.tools,
    toolChoice: params.toolChoice,
    maxTokens: resolveProviderRequestMaxTokens({
      model: params.model,
      discoveredMaxTokens: params.runtime.maxTokens,
    }),
  });
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
      promptCacheKey: params.promptCacheKey,
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
    const state = createResponsesStreamState(params.model);
    const handlers = { onTextDelta: params.onTextDelta };
    try {
      for await (const event of readServerSentEvents(() => reader.read())) {
        if (
          consumeResponsesStreamEvent(event.data, event.event, state, handlers)
        )
          break;
      }
    } finally {
      reader.releaseLock();
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
  const state = createChatCompletionsStreamState<OpenAICompatibleUsagePayload>(
    params.model,
  );
  try {
    for await (const event of readServerSentEvents(() => reader.read())) {
      const payloadText = event.data.trim();
      if (payloadText === '[DONE]') break;
      let payload: unknown;
      try {
        payload = JSON.parse(payloadText) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(payload)) continue;
      const added = applyChatCompletionsChunk(state, payload);
      if (added.content) params.onTextDelta(added.content);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    id: state.id || 'stream',
    model: state.model,
    choices: [
      {
        message: {
          role: 'assistant',
          content: state.content || null,
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
