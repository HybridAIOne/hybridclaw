import { getProviderContextError } from '../../shared/provider-context.js';
import { extractResponseTextContent } from '../../shared/response-text.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ToolDefinition,
} from '../types.js';

export { extractResponseTextContent } from '../../shared/response-text.js';

import {
  callHybridAIProvider,
  callHybridAIProviderStream,
} from './hybridai.js';
import {
  callOllamaProvider,
  callOllamaProviderStream,
} from './local-ollama.js';
import {
  callLocalOpenAICompatProvider,
  callLocalOpenAICompatProviderStream,
} from './local-openai-compat.js';
import {
  callOpenAICodexProvider,
  callOpenAICodexProviderStream,
} from './openai-codex.js';
import type {
  NormalizedCallArgs,
  NormalizedStreamCallArgs,
  RuntimeProvider,
} from './shared.js';

const DEFAULT_VISION_INSTRUCTIONS =
  'You are Codex, a coding assistant. Analyze the provided image and answer the user question using only visible evidence. If text is unreadable or missing, say so.';

export interface RoutedModelContext {
  provider: RuntimeProvider | undefined;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag?: boolean;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
}

export interface RoutedModelCallParams extends RoutedModelContext {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}

export interface RoutedModelStreamCallParams extends RoutedModelCallParams {
  onTextDelta: (delta: string) => void;
  onActivity?: () => void;
}

export interface RoutedVisionCallParams extends RoutedModelContext {
  question: string;
  imageDataUrl: string;
  instructions?: string;
  maxTokens?: number;
}

function buildCallArgs(params: RoutedModelCallParams): NormalizedCallArgs {
  return {
    provider: params.provider,
    baseUrl: params.baseUrl.trim(),
    apiKey: params.apiKey.trim(),
    model: params.model.trim(),
    chatbotId: params.chatbotId.trim(),
    enableRag: params.enableRag ?? false,
    requestHeaders: params.requestHeaders
      ? { ...params.requestHeaders }
      : undefined,
    messages: Array.isArray(params.messages) ? params.messages : [],
    tools: Array.isArray(params.tools) ? params.tools : [],
    maxTokens: params.maxTokens,
    isLocal: Boolean(params.isLocal),
    contextWindow: params.contextWindow,
    thinkingFormat: params.thinkingFormat,
  };
}

function buildStreamCallArgs(
  params: RoutedModelStreamCallParams,
): NormalizedStreamCallArgs {
  return {
    ...buildCallArgs(params),
    onTextDelta: params.onTextDelta,
    onActivity: params.onActivity,
  };
}

export async function callProviderModel(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  if (args.provider === 'openai-codex') {
    return callOpenAICodexProvider(args);
  }
  if (args.provider === 'ollama') {
    return callOllamaProvider(args);
  }
  if (
    args.provider === 'openrouter' ||
    args.provider === 'mistral' ||
    args.provider === 'huggingface' ||
    args.provider === 'lmstudio' ||
    args.provider === 'vllm'
  ) {
    return callLocalOpenAICompatProvider(args);
  }
  return callHybridAIProvider(args);
}

export async function callProviderModelStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  if (args.provider === 'openai-codex') {
    return callOpenAICodexProviderStream(args);
  }
  if (args.provider === 'ollama') {
    return callOllamaProviderStream(args);
  }
  if (
    args.provider === 'openrouter' ||
    args.provider === 'mistral' ||
    args.provider === 'huggingface' ||
    args.provider === 'lmstudio' ||
    args.provider === 'vllm'
  ) {
    return callLocalOpenAICompatProviderStream(args);
  }
  return callHybridAIProviderStream(args);
}

export async function callRoutedModel(
  params: RoutedModelCallParams,
): Promise<ChatCompletionResponse> {
  return callProviderModel(buildCallArgs(params));
}

export async function callRoutedModelStream(
  params: RoutedModelStreamCallParams,
): Promise<ChatCompletionResponse> {
  return callProviderModelStream(buildStreamCallArgs(params));
}

function normalizeVisionBaseUrl(
  provider: RuntimeProvider | undefined,
  baseUrl: string,
): string {
  const normalized = baseUrl.trim().replace(/\/+$/g, '');
  if (provider === 'ollama') {
    return normalized.replace(/\/v1$/i, '');
  }
  if (
    provider === 'openrouter' ||
    provider === 'mistral' ||
    provider === 'huggingface' ||
    provider === 'lmstudio' ||
    provider === 'vllm'
  ) {
    return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
  }
  return normalized;
}

function shouldStreamVisionRequest(
  provider: RuntimeProvider | undefined,
): boolean {
  return (
    provider === undefined ||
    provider === 'hybridai' ||
    provider === 'openai-codex'
  );
}

function buildVisionMessages(params: RoutedVisionCallParams): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (params.provider === 'openai-codex') {
    messages.push({
      role: 'system',
      content: params.instructions?.trim() || DEFAULT_VISION_INSTRUCTIONS,
    });
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: params.question },
      {
        type: 'image_url',
        image_url: { url: params.imageDataUrl },
      },
    ],
  });
  return messages;
}

export function getVisionModelContextError(
  params: RoutedModelContext,
): string | null {
  return getProviderContextError({
    provider: params.provider,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    chatbotId: params.chatbotId,
    toolName: 'vision_analyze',
  });
}

export async function callVisionProviderModel(
  params: RoutedVisionCallParams,
): Promise<{
  model: string;
  analysis: string;
  response: ChatCompletionResponse;
}> {
  const contextError = getVisionModelContextError(params);
  if (contextError) throw new Error(contextError);

  const request = {
    provider: params.provider,
    baseUrl: normalizeVisionBaseUrl(params.provider, params.baseUrl),
    apiKey: params.apiKey,
    model: params.model,
    chatbotId: params.chatbotId,
    enableRag: false,
    requestHeaders: params.requestHeaders,
    isLocal: params.isLocal,
    contextWindow: params.contextWindow,
    thinkingFormat: params.thinkingFormat,
    messages: buildVisionMessages(params),
    tools: [],
    maxTokens: params.maxTokens,
  };
  const response = shouldStreamVisionRequest(params.provider)
    ? await callRoutedModelStream({
        ...request,
        onTextDelta: () => undefined,
      })
    : await callRoutedModel(request);

  const analysis = extractResponseTextContent(
    response.choices[0]?.message?.content,
  );
  if (!analysis) {
    throw new Error('vision API returned empty analysis');
  }

  return {
    model: params.model.trim(),
    analysis,
    response,
  };
}
