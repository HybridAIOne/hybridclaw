import { getProviderContextError } from '../../container/shared/provider-context.js';
import { extractResponseTextContent } from '../../container/shared/response-text.js';
import {
  drainServerSentEventBlocks,
  parseServerSentEventBlock,
} from '../../container/shared/server-sent-events.js';
import { logger } from '../logger.js';
import type { ChatMessage } from '../types/api.js';
import { resolveModelRuntimeCredentials } from './factory.js';
import type { RuntimeProviderId } from './provider-ids.js';
import {
  type AuxiliaryTask,
  detectRuntimeProviderPrefix,
  normalizeAuxiliaryProviderModel,
  normalizeMaxTokens,
  resolveDefaultAuxiliaryModelForProvider,
  resolveTaskModelPolicy,
} from './task-routing.js';
import { isRecord } from './utils.js';

type AuxiliaryTextTask = Exclude<AuxiliaryTask, 'vision'>;
type RuntimeProvider = RuntimeProviderId;

interface AuxiliaryTextCallContext {
  provider: RuntimeProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders?: Record<string, string>;
  maxTokens?: number;
}

interface AuxiliaryToolSchemaProperty {
  type: string | string[];
  description?: string;
  items?: AuxiliaryToolSchemaProperty;
  properties?: Record<string, AuxiliaryToolSchemaProperty>;
  required?: string[];
  enum?: string[];
  minItems?: number;
  maxItems?: number;
}

interface AuxiliaryToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, AuxiliaryToolSchemaProperty>;
      required: string[];
    };
  };
}

interface AuxiliaryRequestOptions {
  tools: AuxiliaryToolDefinition[];
  temperature?: number;
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
}

export interface AuxiliaryModelCallParams {
  task: AuxiliaryTextTask;
  messages: ChatMessage[];
  fallbackModel?: string;
  fallbackChatbotId?: string;
  fallbackEnableRag?: boolean;
  fallbackMaxTokens?: number;
  agentId?: string;
  provider?: RuntimeProvider | 'auto';
  model?: string;
  tools?: AuxiliaryToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
}

function normalizeTemperature(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function buildRequestOptions(
  params: AuxiliaryModelCallParams,
): AuxiliaryRequestOptions {
  return {
    tools: Array.isArray(params.tools) ? params.tools : [],
    temperature: normalizeTemperature(params.temperature),
    timeoutMs: normalizeTimeoutMs(params.timeoutMs),
    extraBody: isRecord(params.extraBody) ? { ...params.extraBody } : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateContext(
  task: AuxiliaryTextTask,
  context: Partial<AuxiliaryTextCallContext>,
): asserts context is AuxiliaryTextCallContext {
  const contextError = getProviderContextError({
    provider: context.provider,
    baseUrl: context.baseUrl,
    apiKey: context.apiKey,
    model: context.model,
    chatbotId: context.chatbotId,
    toolName: task,
  });
  if (contextError) throw new Error(contextError);
}

function buildResolvedContext(params: {
  task: AuxiliaryTextTask;
  provider: RuntimeProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders?: Record<string, string>;
  maxTokens?: number;
}): AuxiliaryTextCallContext {
  const context: Partial<AuxiliaryTextCallContext> = {
    provider: params.provider,
    baseUrl: params.baseUrl.trim(),
    apiKey: params.apiKey.trim(),
    model: params.model.trim(),
    chatbotId: params.chatbotId.trim(),
    enableRag: params.enableRag,
    requestHeaders: params.requestHeaders ? { ...params.requestHeaders } : {},
    maxTokens: normalizeMaxTokens(params.maxTokens),
  };
  validateContext(params.task, context);
  return context;
}

async function resolveContextFromModel(params: {
  task: AuxiliaryTextTask;
  model: string;
  agentId?: string;
  chatbotId?: string;
  enableRag: boolean;
  maxTokens?: number;
  expectedProvider?: RuntimeProvider;
}): Promise<AuxiliaryTextCallContext> {
  const model = params.model.trim();
  if (!model) {
    throw new Error(`${params.task} is not configured: missing model context.`);
  }
  const resolved = await resolveModelRuntimeCredentials({
    model,
    chatbotId: params.chatbotId,
    enableRag: params.enableRag,
    agentId: params.agentId,
  });
  if (
    params.expectedProvider &&
    resolved.provider !== params.expectedProvider
  ) {
    throw new Error(
      `Provider "${params.expectedProvider}" is not available for model "${model}".`,
    );
  }
  return buildResolvedContext({
    task: params.task,
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model,
    chatbotId: resolved.chatbotId,
    enableRag: resolved.enableRag,
    requestHeaders: resolved.requestHeaders,
    maxTokens: params.maxTokens,
  });
}

async function resolveExplicitTextCallContext(
  params: AuxiliaryModelCallParams,
): Promise<AuxiliaryTextCallContext | null> {
  if (typeof params.provider !== 'string' && !params.model?.trim()) {
    return null;
  }

  const providerSelection = params.provider || 'auto';
  const explicitModel = params.model?.trim() ?? '';
  if (providerSelection === 'auto' && !explicitModel) return null;

  const model =
    providerSelection === 'auto'
      ? explicitModel
      : normalizeAuxiliaryProviderModel({
          provider: providerSelection,
          model: explicitModel,
        });

  if (!model) {
    throw new Error(
      `Provider "${providerSelection}" is selected for task "${params.task}", but no default model is configured.`,
    );
  }

  return resolveContextFromModel({
    task: params.task,
    model,
    agentId: params.agentId,
    chatbotId: params.fallbackChatbotId,
    enableRag: false,
    maxTokens: params.maxTokens,
    expectedProvider:
      providerSelection === 'auto'
        ? detectRuntimeProviderPrefix(model)
        : providerSelection,
  });
}

function buildOpenRouterFallbackModel(modelHint?: string): string | undefined {
  const trimmed = modelHint?.trim() ?? '';
  if (!trimmed) {
    return resolveDefaultAuxiliaryModelForProvider('openrouter');
  }

  const providerPrefix = detectRuntimeProviderPrefix(trimmed);
  if (providerPrefix === 'openrouter') return trimmed;
  if (providerPrefix) {
    return resolveDefaultAuxiliaryModelForProvider('openrouter');
  }
  return normalizeAuxiliaryProviderModel({
    provider: 'openrouter',
    model: trimmed,
  });
}

async function resolveOpenRouterFallbackContext(params: {
  task: AuxiliaryTextTask;
  agentId?: string;
  maxTokens?: number;
  modelHint?: string;
}): Promise<AuxiliaryTextCallContext | null> {
  const fallbackModel = buildOpenRouterFallbackModel(params.modelHint);
  if (!fallbackModel) return null;

  return resolveContextFromModel({
    task: params.task,
    model: fallbackModel,
    agentId: params.agentId,
    enableRag: false,
    maxTokens: params.maxTokens,
    expectedProvider: 'openrouter',
  });
}

async function withOpenRouterFallback(
  params: AuxiliaryModelCallParams,
  primaryError: unknown,
  modelHint?: string,
  primaryProvider?: RuntimeProvider,
): Promise<AuxiliaryTextCallContext> {
  if (
    params.provider === 'openrouter' ||
    primaryProvider === 'openrouter' ||
    (modelHint?.trim().toLowerCase() ?? '').startsWith('openrouter/')
  ) {
    throw primaryError;
  }

  try {
    const fallback = await resolveOpenRouterFallbackContext({
      task: params.task,
      agentId: params.agentId,
      maxTokens:
        normalizeMaxTokens(params.maxTokens) ??
        normalizeMaxTokens(params.fallbackMaxTokens),
      modelHint,
    });
    if (fallback) {
      logger.warn(
        {
          task: params.task,
          primaryProvider: primaryProvider || params.provider || 'auto',
          fallbackProvider: 'openrouter',
          modelHint: modelHint?.trim() || undefined,
          primaryError,
        },
        'Auxiliary provider resolution failed; using OpenRouter fallback',
      );
      return fallback;
    }
  } catch (fallbackError) {
    throw new Error(
      `${errorMessage(primaryError)} OpenRouter fallback also failed: ${errorMessage(fallbackError)}`,
    );
  }

  throw primaryError;
}

async function resolveExplicitTextCallContextWithFallback(
  params: AuxiliaryModelCallParams,
): Promise<AuxiliaryTextCallContext | null> {
  try {
    return await resolveExplicitTextCallContext(params);
  } catch (error) {
    return withOpenRouterFallback(
      params,
      error,
      params.model || params.fallbackModel,
      params.provider === 'auto' ? undefined : params.provider,
    );
  }
}

async function resolveTaskOverrideTextCallContext(
  params: AuxiliaryModelCallParams,
  requestedMaxTokens: number | undefined,
): Promise<AuxiliaryTextCallContext | null> {
  const taskOverride = await resolveTaskModelPolicy(params.task, {
    agentId: params.agentId,
    chatbotId: params.fallbackChatbotId,
  });
  if (!taskOverride) return null;
  if (taskOverride?.error) {
    return withOpenRouterFallback(
      params,
      new Error(`${params.task} is not configured: ${taskOverride.error}`),
      taskOverride.model,
      taskOverride.provider,
    );
  }
  if (!taskOverride.provider) return null;
  return buildResolvedContext({
    task: params.task,
    provider: taskOverride.provider,
    baseUrl: taskOverride.baseUrl?.trim() ?? '',
    apiKey: taskOverride.apiKey?.trim() ?? '',
    model: taskOverride.model.trim(),
    chatbotId: taskOverride.chatbotId?.trim() ?? '',
    enableRag: false,
    requestHeaders: taskOverride.requestHeaders,
    maxTokens: requestedMaxTokens ?? taskOverride.maxTokens,
  });
}

async function resolveFallbackModelTextCallContext(
  params: AuxiliaryModelCallParams,
  requestedMaxTokens: number | undefined,
): Promise<AuxiliaryTextCallContext> {
  const fallbackModel = params.fallbackModel?.trim() ?? '';
  try {
    return await resolveContextFromModel({
      task: params.task,
      model: fallbackModel,
      agentId: params.agentId,
      chatbotId: params.fallbackChatbotId,
      enableRag: params.fallbackEnableRag ?? false,
      maxTokens: requestedMaxTokens ?? params.fallbackMaxTokens,
      expectedProvider: detectRuntimeProviderPrefix(fallbackModel),
    });
  } catch (error) {
    return withOpenRouterFallback(
      params,
      error,
      params.fallbackModel,
      detectRuntimeProviderPrefix(fallbackModel),
    );
  }
}

async function resolveTextCallContext(
  params: AuxiliaryModelCallParams,
): Promise<AuxiliaryTextCallContext> {
  const requestedMaxTokens = normalizeMaxTokens(params.maxTokens);

  // 1. Respect explicit provider/model overrides first.
  const explicit = await resolveExplicitTextCallContextWithFallback(params);
  if (explicit) return explicit;

  // 2. Then prefer the configured auxiliary task model, if any.
  const taskOverride = await resolveTaskOverrideTextCallContext(
    params,
    requestedMaxTokens,
  );
  if (taskOverride) return taskOverride;

  // 3. Finally fall back to the session model, with OpenRouter as recovery.
  return resolveFallbackModelTextCallContext(params, requestedMaxTokens);
}

function buildJsonHeaders(params: {
  apiKey?: string;
  requestHeaders?: Record<string, string>;
  includeAuthorization?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = params.apiKey?.trim() ?? '';
  if (params.includeAuthorization !== false && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return {
    ...headers,
    ...(params.requestHeaders || {}),
  };
}

function createTimeoutSignal(
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  return timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
}

function normalizeOpenRouterRuntimeModelName(model: string): string {
  const trimmed = model.trim();
  const prefix = 'openrouter/';
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  const upstreamModel = trimmed.slice(prefix.length).trim();
  if (!upstreamModel) return trimmed;
  // OpenRouter-native ids like `openrouter/free` and `openrouter/hunter-alpha`
  // keep their namespace. Vendor-scoped ids use the upstream path.
  return upstreamModel.includes('/') ? upstreamModel : trimmed;
}

function normalizeOpenAICompatModelName(
  provider: RuntimeProvider,
  model: string,
): string {
  const trimmed = model.trim();
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

function normalizeCodexModelName(model: string): string {
  const trimmed = model.trim();
  const prefix = 'openai-codex/';
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  return trimmed.slice(prefix.length) || trimmed;
}

function normalizeOllamaModelName(model: string): string {
  const trimmed = model.trim();
  const prefix = 'ollama/';
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  return trimmed.slice(prefix.length) || trimmed;
}

function normalizeOllamaBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/g, '').replace(/\/v1$/i, '');
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const chunks: string[] = [];
  for (const part of content) {
    if (part.type !== 'text' || !part.text) continue;
    chunks.push(part.text);
  }
  return chunks.join('\n');
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

async function parseError(response: Response): Promise<never> {
  throw new Error(
    `Auxiliary provider call failed with ${response.status}: ${await response.text()}`,
  );
}

function withCoreRequestBody(
  coreBody: Record<string, unknown>,
  options: AuxiliaryRequestOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(options.extraBody || {}),
    ...coreBody,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}

async function callHybridAITextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<string> {
  const body = withCoreRequestBody(
    {
      model: context.model,
      chatbot_id: context.chatbotId,
      messages,
      tools: options.tools,
      tool_choice: 'auto',
      enable_rag: context.enableRag,
      ...(context.maxTokens ? { max_tokens: context.maxTokens } : {}),
    },
    options,
  );

  const response = await fetch(`${context.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: buildJsonHeaders({
      apiKey: context.apiKey,
      requestHeaders: context.requestHeaders,
    }),
    body: JSON.stringify(body),
    signal: createTimeoutSignal(options.timeoutMs),
  });
  if (!response.ok) await parseError(response);

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  return extractResponseTextContent(payload.choices?.[0]?.message?.content);
}

function shouldRetryWithMaxCompletionTokens(
  responseText: string,
  maxTokens: number | undefined,
): boolean {
  if (!maxTokens) return false;
  const normalized = responseText.toLowerCase();
  return (
    normalized.includes('max_tokens') ||
    normalized.includes('max completion tokens') ||
    normalized.includes('max_completion_tokens')
  );
}

async function callOpenAICompatTextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<string> {
  const body = withCoreRequestBody(
    {
      model: normalizeOpenAICompatModelName(context.provider, context.model),
      messages: collapseSystemMessages(messages),
      tools: options.tools,
      tool_choice: 'auto',
      ...(context.maxTokens ? { max_tokens: context.maxTokens } : {}),
    },
    options,
  );

  let response = await fetch(`${context.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildJsonHeaders({
      apiKey: context.apiKey,
      requestHeaders: context.requestHeaders,
      includeAuthorization: Boolean(context.apiKey),
    }),
    body: JSON.stringify(body),
    signal: createTimeoutSignal(options.timeoutMs),
  });

  if (!response.ok) {
    const responseText = await response.text();
    if (shouldRetryWithMaxCompletionTokens(responseText, context.maxTokens)) {
      delete body.max_tokens;
      body.max_completion_tokens = context.maxTokens;
      response = await fetch(`${context.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildJsonHeaders({
          apiKey: context.apiKey,
          requestHeaders: context.requestHeaders,
          includeAuthorization: Boolean(context.apiKey),
        }),
        body: JSON.stringify(body),
        signal: createTimeoutSignal(options.timeoutMs),
      });
      if (!response.ok) await parseError(response);
    } else {
      throw new Error(
        `Auxiliary provider call failed with ${response.status}: ${responseText}`,
      );
    }
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  return extractResponseTextContent(payload.choices?.[0]?.message?.content);
}

function convertMessageToCodexInput(
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

  const text = contentToText(message.content);
  if (text.trim()) {
    items.push({
      role: message.role,
      content: text,
    });
  }
  return items;
}

function convertToolsToCodexTools(
  tools: AuxiliaryToolDefinition[],
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

async function callCodexTextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<string> {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => contentToText(message.content).trim())
    .filter((message) => message.length > 0)
    .join('\n\n');
  const body: Record<string, unknown> = {
    ...(options.extraBody || {}),
    model: normalizeCodexModelName(context.model),
    store: false,
    stream: true,
    instructions: instructions || 'You are Codex, a coding assistant.',
    input: messages.flatMap(convertMessageToCodexInput),
    tools: convertToolsToCodexTools(options.tools),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    ...(context.maxTokens ? { max_output_tokens: context.maxTokens } : {}),
  };

  const response = await fetch(`${context.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      ...buildJsonHeaders({
        apiKey: context.apiKey,
        requestHeaders: context.requestHeaders,
      }),
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(body),
    signal: createTimeoutSignal(options.timeoutMs),
  });
  if (!response.ok) await parseError(response);

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    contentType.includes('application/json') &&
    !contentType.includes('event-stream')
  ) {
    const payload = (await response.json()) as {
      output?: Array<{
        type?: string;
        content?: Array<{
          text?: string;
          output_text?: string;
        }>;
      }>;
    };
    const chunks: string[] = [];
    for (const entry of payload.output || []) {
      if (entry.type !== 'message' || !Array.isArray(entry.content)) continue;
      for (const part of entry.content) {
        const text =
          typeof part.text === 'string'
            ? part.text
            : typeof part.output_text === 'string'
              ? part.output_text
              : '';
        if (text.trim()) chunks.push(text.trim());
      }
    }
    return chunks.join('\n').trim();
  }

  if (!response.body) {
    throw new Error('Auxiliary provider returned no response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  const applyCodexEvent = (payload: Record<string, unknown>): void => {
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'response.output_text.delta') {
      const delta =
        typeof payload.delta === 'string'
          ? payload.delta
          : typeof payload.text === 'string'
            ? payload.text
            : '';
      if (delta) text += delta;
      return;
    }
    if (type === 'response.output_text.done') {
      const finalText =
        typeof payload.text === 'string'
          ? payload.text
          : typeof payload.output_text === 'string'
            ? payload.output_text
            : '';
      if (finalText && finalText.length >= text.length) {
        text = finalText;
      }
      return;
    }
    if (type !== 'response.completed') return;
    const responsePayload = payload.response;
    if (
      typeof responsePayload !== 'object' ||
      responsePayload === null ||
      !Array.isArray((responsePayload as { output?: unknown }).output)
    ) {
      return;
    }
    const completedText = extractResponseTextContent(
      (
        responsePayload as { output: Array<{ content?: unknown }> }
      ).output.flatMap((entry) => entry.content ?? []),
    );
    if (completedText && completedText.length >= text.length) {
      text = completedText;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const drained = drainServerSentEventBlocks(buffer);
    buffer = drained.remainder;
    for (const block of drained.blocks) {
      const event = parseServerSentEventBlock(block);
      if (!event || !event.data || event.data === '[DONE]') continue;
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      applyCodexEvent(payload);
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const event = parseServerSentEventBlock(buffer);
    if (event?.data && event.data !== '[DONE]') {
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      applyCodexEvent(payload);
    }
  }

  return text.trim();
}

async function callOllamaTextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<string> {
  const { options: extraBodyOptions, ...extraBody } = options.extraBody ?? {};
  const rawOptions = isRecord(extraBodyOptions)
    ? { ...extraBodyOptions }
    : undefined;

  const body: Record<string, unknown> = {
    ...extraBody,
    model: normalizeOllamaModelName(context.model),
    messages: messages.map((message) => ({
      role: message.role,
      content: contentToText(message.content),
    })),
    tools: options.tools,
    stream: false,
  };
  const ollamaOptions: Record<string, unknown> = {
    ...(rawOptions || {}),
  };
  if (context.maxTokens) {
    ollamaOptions.num_predict = context.maxTokens;
  }
  if (options.temperature !== undefined) {
    ollamaOptions.temperature = options.temperature;
  }
  if (Object.keys(ollamaOptions).length > 0) {
    body.options = ollamaOptions;
  }

  const response = await fetch(
    `${normalizeOllamaBaseUrl(context.baseUrl)}/api/chat`,
    {
      method: 'POST',
      headers: buildJsonHeaders({
        requestHeaders: context.requestHeaders,
        includeAuthorization: false,
      }),
      body: JSON.stringify(body),
      signal: createTimeoutSignal(options.timeoutMs),
    },
  );
  if (!response.ok) await parseError(response);

  const payload = (await response.json()) as {
    message?: {
      content?: unknown;
    };
  };
  return extractResponseTextContent(payload.message?.content);
}

async function callAuxiliaryTextProvider(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<string> {
  if (context.provider === 'openai-codex') {
    return callCodexTextModel(context, messages, options);
  }
  if (context.provider === 'ollama') {
    return callOllamaTextModel(context, messages, options);
  }
  if (
    context.provider === 'openrouter' ||
    context.provider === 'huggingface' ||
    context.provider === 'lmstudio' ||
    context.provider === 'llamacpp' ||
    context.provider === 'vllm'
  ) {
    return callOpenAICompatTextModel(context, messages, options);
  }
  return callHybridAITextModel(context, messages, options);
}

export async function callAuxiliaryModel(
  params: AuxiliaryModelCallParams,
): Promise<{ provider: RuntimeProvider; model: string; content: string }> {
  const options = buildRequestOptions(params);
  const context = await resolveTextCallContext(params);
  const content = (
    await callAuxiliaryTextProvider(
      context,
      Array.isArray(params.messages) ? params.messages : [],
      options,
    )
  ).trim();
  if (!content) {
    throw new Error(`${params.task} returned an empty response.`);
  }
  return {
    provider: context.provider,
    model: context.model,
    content,
  };
}
