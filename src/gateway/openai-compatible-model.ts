import { normalizeHybridAIModelForRuntime } from '../providers/model-names.js';
import {
  isOpenAICompatProviderId,
  type RuntimeProviderId,
} from '../providers/provider-ids.js';
import type { ResolvedModelRuntimeCredentials } from '../providers/types.js';
import type { ChatMessage, ToolCall } from '../types/api.js';
import type { TokenUsageStats } from '../types/usage.js';

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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
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
  abortSignal?: AbortSignal;
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

function normalizeCodexModelName(model: string): string {
  const trimmed = String(model || '').trim();
  const prefix = 'openai-codex/';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  return {
    model: normalizeHybridAIModelForRuntime(params.model),
    chatbot_id: params.runtime.chatbotId,
    messages: params.messages,
    tools: params.tools,
    tool_choice: params.toolChoice || 'auto',
    enable_rag: params.runtime.enableRag,
  };
}

function buildOpenAICompatRequestBody(
  params: OpenAICompatibleModelCallParams,
): Record<string, unknown> {
  return {
    model: normalizeOpenAICompatModelName(
      params.runtime.provider,
      params.model,
    ),
    messages: collapseSystemMessages(params.messages),
    tools: params.tools,
    tool_choice: params.toolChoice || 'auto',
  };
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
      output: contentToText(message.content),
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
  if (typeof message.content === 'string') {
    if (message.content.trim()) {
      items.push({ role: message.role, content: message.content });
    }
    return items;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    const content: Array<Record<string, unknown>> = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        content.push({ type: 'input_text', text: part.text });
        continue;
      }
      if (part.type === 'image_url') {
        content.push({ type: 'input_image', image_url: part.image_url.url });
      }
    }
    if (content.length > 0) {
      items.push({ role: message.role, content });
    }
  }
  return items;
}

function buildCodexRequestBody(
  params: OpenAICompatibleModelCallParams,
): Record<string, unknown> {
  const instructions = params.messages
    .filter((message) => message.role === 'system')
    .map((message) => contentToText(message.content).trim())
    .filter(Boolean)
    .join('\n\n');
  return {
    model: normalizeCodexModelName(params.model),
    store: false,
    instructions: instructions || 'You are Codex, a coding assistant.',
    input: params.messages.flatMap(convertMessageToResponsesInput),
    tools: params.tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
    tool_choice: params.toolChoice || 'auto',
    parallel_tool_calls: true,
  };
}

function adaptCodexResponse(
  payload: unknown,
  fallbackModel: string,
): OpenAICompatibleModelResponse {
  const record = isRecord(payload) ? payload : {};
  const output = Array.isArray(record.output) ? record.output : [];
  const toolCalls: ToolCall[] = [];
  const textChunks: string[] = [];

  for (const entry of output) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (type === 'message' && Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (!isRecord(part)) continue;
        const text =
          typeof part.text === 'string'
            ? part.text
            : typeof part.output_text === 'string'
              ? part.output_text
              : '';
        if (text) textChunks.push(text);
      }
      continue;
    }
    if (type === 'function_call') {
      toolCalls.push({
        id:
          (typeof entry.call_id === 'string' && entry.call_id) ||
          (typeof entry.id === 'string' && entry.id) ||
          '',
        type: 'function',
        function: {
          name: typeof entry.name === 'string' ? entry.name : '',
          arguments:
            typeof entry.arguments === 'string'
              ? entry.arguments
              : JSON.stringify(entry.arguments || {}),
        },
      });
    }
  }

  return {
    id: typeof record.id === 'string' ? record.id : 'response',
    model:
      typeof record.model === 'string' && record.model
        ? record.model
        : normalizeCodexModelName(fallbackModel),
    choices: [
      {
        message: {
          role: 'assistant',
          content: textChunks.join('') || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    ...(isRecord(record.usage)
      ? {
          usage: record.usage as OpenAICompatibleModelResponse['usage'],
        }
      : {}),
  };
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
        body: JSON.stringify(buildCodexRequestBody(params)),
      },
    );
    if (!response.ok) {
      throw createProviderError(response.status, await response.text());
    }
    return adaptCodexResponse(await response.json(), params.model);
  }

  const url = isOpenAICompatProviderId(params.runtime.provider)
    ? `${normalizeBaseUrl(params.runtime.baseUrl)}/chat/completions`
    : `${normalizeBaseUrl(params.runtime.baseUrl)}/v1/chat/completions`;
  const body = isOpenAICompatProviderId(params.runtime.provider)
    ? buildOpenAICompatRequestBody(params)
    : buildHybridAIRequestBody(params);
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
        signal: params.abortSignal,
        body: JSON.stringify({
          ...buildCodexRequestBody(params),
          stream: true,
        }),
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
    let buffer = '';
    let text = '';
    let done = false;
    let completedPayload: unknown = null;
    try {
      while (!done) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const dataLines = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          const payloadText = dataLines.join('\n').trim();
          if (!payloadText) continue;
          if (payloadText === '[DONE]') {
            done = true;
            break;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(payloadText) as unknown;
          } catch {
            continue;
          }
          if (!isRecord(payload)) continue;
          if (payload.type === 'response.output_text.delta') {
            const delta =
              typeof payload.delta === 'string' ? payload.delta : '';
            if (delta) {
              text += delta;
              params.onTextDelta(delta);
            }
          }
          if (
            payload.type === 'response.completed' &&
            isRecord(payload.response)
          ) {
            completedPayload = payload.response;
            done = true;
            break;
          }
        }
      }
    } finally {
      reader.releaseLock();
      decoder.decode();
    }
    return completedPayload
      ? adaptCodexResponse(completedPayload, params.model)
      : {
          id: 'response',
          model: normalizeCodexModelName(params.model),
          choices: [
            {
              message: { role: 'assistant', content: text || null },
              finish_reason: 'stop',
            },
          ],
        };
  }

  const url = isOpenAICompatProviderId(params.runtime.provider)
    ? `${normalizeBaseUrl(params.runtime.baseUrl)}/chat/completions`
    : `${normalizeBaseUrl(params.runtime.baseUrl)}/v1/chat/completions`;
  const body = isOpenAICompatProviderId(params.runtime.provider)
    ? buildOpenAICompatRequestBody(params)
    : buildHybridAIRequestBody(params);
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders({
      apiKey: params.runtime.apiKey,
      requestHeaders: params.runtime.requestHeaders,
      accept: 'text/event-stream, application/json',
    }),
    signal: params.abortSignal,
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
    if (typeof content === 'string' && content) params.onTextDelta(content);
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
        if (!trimmed || !trimmed.startsWith('data:')) continue;
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

export function mapOpenAICompatibleUsageToTokenStats(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}): TokenUsageStats | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  return {
    modelCalls: 1,
    apiUsageAvailable: true,
    apiPromptTokens: promptTokens,
    apiCompletionTokens: completionTokens,
    apiTotalTokens: totalTokens,
    apiCacheUsageAvailable: false,
    apiCacheReadTokens: 0,
    apiCacheWriteTokens: 0,
    estimatedPromptTokens: promptTokens,
    estimatedCompletionTokens: completionTokens,
    estimatedTotalTokens: totalTokens,
  };
}
