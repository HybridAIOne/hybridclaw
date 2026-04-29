import { getProviderContextError } from '../../shared/provider-context.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  TaskModelKey,
  TaskModelPolicies,
  ToolDefinition,
} from '../types.js';
import { resolveProviderRequestMaxTokens } from './request-max-tokens.js';
import {
  callRoutedModel,
  callVisionProviderModel,
  extractResponseTextContent,
  type RoutedModelContext,
} from './router.js';

export type AuxiliaryTask = TaskModelKey;

export interface AuxiliaryTaskContext extends RoutedModelContext {
  maxTokens?: number;
}

export interface AuxiliaryVisionTaskCallParams {
  task: 'vision';
  taskModels?: TaskModelPolicies;
  fallbackContext: AuxiliaryTaskContext;
  question: string;
  imageDataUrl: string;
  toolName?: string;
  missingContextSource?: 'active request';
}

export interface AuxiliaryTextTaskCallParams {
  task: Exclude<AuxiliaryTask, 'vision'>;
  taskModels?: TaskModelPolicies;
  fallbackContext: AuxiliaryTaskContext;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  toolName?: string;
}

type AuxiliaryTaskCallParams =
  | AuxiliaryVisionTaskCallParams
  | AuxiliaryTextTaskCallParams;

function cloneAuxiliaryTaskContext(
  context: AuxiliaryTaskContext,
): AuxiliaryTaskContext {
  return {
    ...context,
    requestHeaders: context.requestHeaders
      ? { ...context.requestHeaders }
      : undefined,
  };
}

function resolveTaskOverride(
  task: AuxiliaryTask,
  taskModels?: TaskModelPolicies,
) {
  return taskModels?.[task];
}

function getAuxiliaryContextError(params: {
  context: AuxiliaryTaskContext;
  toolName: string;
  missingContextSource?: 'active request';
}): string | null {
  return getProviderContextError({
    provider: params.context.provider,
    providerMethod: params.context.providerMethod,
    baseUrl: params.context.baseUrl,
    apiKey: params.context.apiKey,
    model: params.context.model,
    chatbotId: params.context.chatbotId,
    toolName: params.toolName,
    missingContextSource: params.missingContextSource,
  });
}

export function resolveAuxiliaryTaskContext(params: {
  task: AuxiliaryTask;
  taskModels?: TaskModelPolicies;
  fallbackContext: AuxiliaryTaskContext;
  toolName?: string;
}): AuxiliaryTaskContext {
  const toolName = (params.toolName ?? params.task).trim() || params.task;
  const taskOverride = resolveTaskOverride(params.task, params.taskModels);
  if (taskOverride?.error) {
    throw new Error(`${toolName} is not configured: ${taskOverride.error}`);
  }
  if (!taskOverride) {
    return cloneAuxiliaryTaskContext(params.fallbackContext);
  }
  return {
    provider: taskOverride.provider,
    providerMethod: taskOverride.providerMethod,
    baseUrl: taskOverride.baseUrl?.trim() ?? '',
    apiKey: taskOverride.apiKey?.trim() ?? '',
    model: taskOverride.model.trim(),
    chatbotId: taskOverride.chatbotId?.trim() ?? '',
    requestHeaders: taskOverride.requestHeaders
      ? { ...taskOverride.requestHeaders }
      : undefined,
    isLocal: taskOverride.isLocal,
    contextWindow: taskOverride.contextWindow,
    thinkingFormat: taskOverride.thinkingFormat,
    debugModelResponses: params.fallbackContext.debugModelResponses,
    maxTokens: taskOverride.maxTokens,
  };
}

export async function callAuxiliaryModel(
  params: AuxiliaryVisionTaskCallParams,
): Promise<{
  model: string;
  analysis: string;
  response: ChatCompletionResponse;
}>;
export async function callAuxiliaryModel(
  params: AuxiliaryTextTaskCallParams,
): Promise<{
  model: string;
  content: string;
  response: ChatCompletionResponse;
}>;
export async function callAuxiliaryModel(
  params: AuxiliaryTaskCallParams,
): Promise<
  | {
      model: string;
      analysis: string;
      response: ChatCompletionResponse;
    }
  | {
      model: string;
      content: string;
      response: ChatCompletionResponse;
    }
> {
  const toolName = (params.toolName ?? params.task).trim() || params.task;
  const context = resolveAuxiliaryTaskContext({
    task: params.task,
    taskModels: params.taskModels,
    fallbackContext: params.fallbackContext,
    toolName,
  });
  const contextError = getAuxiliaryContextError({
    context,
    toolName,
    missingContextSource:
      params.task === 'vision' ? params.missingContextSource : undefined,
  });
  if (contextError) throw new Error(contextError);

  if (params.task !== 'vision') {
    const maxTokens = resolveProviderRequestMaxTokens({
      model: context.model,
      discoveredMaxTokens: context.maxTokens,
    });
    const response = await callRoutedModel({
      provider: context.provider,
      providerMethod: context.providerMethod,
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
      model: context.model,
      chatbotId: context.chatbotId,
      enableRag: false,
      requestHeaders: context.requestHeaders,
      isLocal: context.isLocal,
      contextWindow: context.contextWindow,
      thinkingFormat: context.thinkingFormat,
      debugModelResponses: context.debugModelResponses,
      messages: params.messages,
      tools: Array.isArray(params.tools) ? params.tools : [],
      maxTokens,
    });
    const content = extractResponseTextContent(
      response.choices[0]?.message?.content,
    );
    if (!content) {
      throw new Error(`${toolName} returned empty content`);
    }
    return {
      model: context.model.trim(),
      content,
      response,
    };
  }

  try {
    const maxTokens = resolveProviderRequestMaxTokens({
      model: context.model,
      discoveredMaxTokens: context.maxTokens,
    });
    return await callVisionProviderModel({
      provider: context.provider,
      providerMethod: context.providerMethod,
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
      model: context.model,
      chatbotId: context.chatbotId,
      requestHeaders: context.requestHeaders,
      isLocal: context.isLocal,
      contextWindow: context.contextWindow,
      thinkingFormat: context.thinkingFormat,
      debugModelResponses: context.debugModelResponses,
      question: params.question,
      imageDataUrl: params.imageDataUrl,
      maxTokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface a clearer error when the model simply cannot handle images.
    if (
      /does not support image/i.test(message) ||
      /not.*vision/i.test(message)
    ) {
      throw new Error(
        `Model "${context.model}" does not support vision/image inputs. ` +
          'Configure a vision-capable model via auxiliaryModels.vision in runtime config, ' +
          `or use a vision-enabled session model. Original error: ${message}`,
        { cause: err },
      );
    }
    throw err;
  }
}
