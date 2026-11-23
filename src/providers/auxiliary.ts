import { fetchHybridAIDestination } from '@hybridclaw/shared/hybridai-destination';
import { chatContentText } from '@hybridclaw/shared/message-text';
import { readProviderCacheUsage } from '@hybridclaw/shared/provider-cache-usage';
import { getProviderContextError } from '@hybridclaw/shared/provider-context';
import { buildChatCompletionsBody } from '@hybridclaw/shared/provider-wire/chat-completions';
import {
  adaptResponsesPayload,
  buildResponsesRequestBody,
  buildResponsesStreamResponse,
  consumeResponsesStreamEvent,
  createResponsesStreamState,
  type ResponsesCompletion,
} from '@hybridclaw/shared/provider-wire/codex-responses';
import { buildHybridAIRequestBody } from '@hybridclaw/shared/provider-wire/hybridai-body';
import {
  normalizeOpenAICompatModelName,
  stripProviderPrefix,
} from '@hybridclaw/shared/provider-wire/model-names';
import { readServerSentEvents } from '@hybridclaw/shared/provider-wire/server-sent-events';
import {
  isAnthropicProviderModel,
  resolveProviderRequestMaxTokens,
} from '@hybridclaw/shared/request-max-tokens';
import { extractResponseTextContent } from '@hybridclaw/shared/response-text';
import { collapseSystemMessages } from '@hybridclaw/shared/system-messages';
import { toGatewayModelProviderKey } from '../gateway/model-provider-keys.js';
import { getGatewayAdminProviderStatus } from '../gateway/provider-status.js';
import { logger } from '../logger.js';
import type { ChatMessage } from '../types/api.js';
import {
  finishRoutingTraceAttempt,
  startRoutingTraceAttempt,
} from '../usage/routing-trace.js';
import {
  buildAnthropicSupportingHeaders,
  isAnthropicOAuthToken,
  normalizeAnthropicBaseUrl,
  stripAnthropicModelPrefix,
} from './anthropic-utils.js';
import {
  resolveModelProvider,
  resolveModelRuntimeCredentials,
} from './factory.js';
import {
  defaultOllamaContextWindow,
  discoverAllLocalModels,
  getLocalModelInfo,
} from './local-discovery.js';
import { localBackendsProbe } from './local-health.js';
import {
  inferProviderFromModelPrefix,
  isLocalBackendType,
  isOpenAICompatProviderId,
  type RuntimeProviderId,
} from './provider-ids.js';
import {
  type AuxiliaryTask,
  isAuxiliaryTaskDisabled,
  normalizeAuxiliaryProviderModel,
  normalizeMaxTokens,
  resolveDefaultAuxiliaryModelForProvider,
  resolveTaskModelPolicy,
} from './task-routing.js';
import { formatUnknownError, isRecord } from './utils.js';

type AuxiliaryTextTask = Exclude<AuxiliaryTask, 'vision'>;
type RuntimeProvider = RuntimeProviderId;

const REMOTE_AUXILIARY_FALLBACKS: Array<{
  provider: RuntimeProvider;
  model: string;
}> = [
  {
    provider: 'openrouter',
    model: 'openrouter/google/gemini-2.5-flash-lite',
  },
  {
    provider: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
  },
  {
    provider: 'openai-codex',
    model: 'openai-codex/gpt-5.4-mini',
  },
  {
    provider: 'gemini',
    model: 'gemini/gemini-2.5-flash-lite',
  },
];
const LOCAL_AUXILIARY_FALLBACK_ORDER: RuntimeProvider[] = [
  'vllm',
  'mlx',
  'lmstudio',
  'llamacpp',
  'ollama',
];
const FALLBACK_PROVIDER_STATUS_TTL_MS = 30_000;

interface AuxiliaryTextCallContext {
  provider: RuntimeProvider;
  providerMethod?: string;
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
  task: AuxiliaryTextTask;
  tools: AuxiliaryToolDefinition[];
  temperature?: number;
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
}

export interface AuxiliaryModelCallParams {
  task: AuxiliaryTextTask;
  traceReason?: string;
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
  allowFallback?: boolean;
}

export interface AuxiliaryModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

interface AuxiliaryTextResponse {
  content: string;
  usage?: AuxiliaryModelUsage;
}

let fallbackProviderStatusCache: {
  at: number;
  promise: ReturnType<typeof getGatewayAdminProviderStatus>;
} | null = null;

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
    task: params.task,
    tools: Array.isArray(params.tools) ? params.tools : [],
    temperature: normalizeTemperature(params.temperature),
    timeoutMs: normalizeTimeoutMs(params.timeoutMs),
    extraBody: isRecord(params.extraBody) ? { ...params.extraBody } : undefined,
  };
}

function errorMessage(error: unknown): string {
  return formatUnknownError(error);
}

function serializeAuxiliaryError(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {
    message: errorMessage(error),
  };

  if (error instanceof Error) {
    details.type = error.name || error.constructor.name || 'Error';
    if ('code' in error && typeof error.code === 'string') {
      details.code = error.code;
    }
    if (error.cause !== undefined) {
      details.cause = errorMessage(error.cause);
    }
    return details;
  }

  if (!isRecord(error)) return details;

  for (const key of ['type', 'name', 'code', 'status', 'statusCode']) {
    const value = error[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      details[key] = value;
    }
  }

  return details;
}

function readFiniteNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readAuxiliaryModelUsage(
  value: unknown,
): AuxiliaryModelUsage | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens = readFiniteNumber([
    value.inputTokens,
    value.input_tokens,
    value.promptTokens,
    value.prompt_tokens,
  ]);
  const outputTokens = readFiniteNumber([
    value.outputTokens,
    value.output_tokens,
    value.completionTokens,
    value.completion_tokens,
  ]);
  const totalTokens =
    readFiniteNumber([value.totalTokens, value.total_tokens]) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const { cacheReadTokens, cacheWriteTokens } = readProviderCacheUsage(value);
  const costUsd = readFiniteNumber([value.costUsd, value.cost_usd]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function validateContext(
  task: AuxiliaryTextTask,
  context: Partial<AuxiliaryTextCallContext>,
): asserts context is AuxiliaryTextCallContext {
  const contextError = getProviderContextError({
    provider: context.provider,
    providerMethod: context.providerMethod,
    baseUrl: context.baseUrl,
    apiKey: context.apiKey,
    model: context.model,
    toolName: task,
  });
  if (contextError) throw new Error(contextError);
}

function buildResolvedContext(params: {
  task: AuxiliaryTextTask;
  provider: RuntimeProvider;
  providerMethod?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders?: Record<string, string>;
  maxTokens?: number;
  discoveredMaxTokens?: number;
  isLocal?: boolean;
}): AuxiliaryTextCallContext {
  const providerMaxTokens = resolveProviderRequestMaxTokens({
    model: params.model,
    discoveredMaxTokens: params.discoveredMaxTokens,
  });
  const context: Partial<AuxiliaryTextCallContext> = {
    provider: params.provider,
    providerMethod: params.providerMethod,
    baseUrl: params.baseUrl.trim(),
    apiKey: params.apiKey.trim(),
    model: params.model.trim(),
    chatbotId: params.chatbotId.trim(),
    enableRag: params.enableRag,
    requestHeaders: params.requestHeaders ? { ...params.requestHeaders } : {},
    maxTokens: normalizeMaxTokens(params.maxTokens) ?? providerMaxTokens,
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
    providerMethod: resolved.providerMethod,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model || model,
    chatbotId: resolved.chatbotId,
    enableRag: resolved.enableRag,
    requestHeaders: resolved.requestHeaders,
    maxTokens: params.maxTokens,
    discoveredMaxTokens: resolved.maxTokens,
    isLocal: resolved.isLocal,
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
        ? inferProviderFromModelPrefix(model)
        : providerSelection,
  });
}

async function resolveRemoteFallbackContext(params: {
  params: AuxiliaryModelCallParams;
  primaryError: unknown;
  modelHint?: string;
  primaryProvider?: RuntimeProvider;
  logMessage?: string;
  maxTokens?: number;
}): Promise<AuxiliaryTextCallContext> {
  const errors: string[] = [];
  const unhealthyProviders: RuntimeProvider[] = [];
  for (const candidate of REMOTE_AUXILIARY_FALLBACKS) {
    if (!(await isFallbackProviderHealthy(candidate.provider))) {
      unhealthyProviders.push(candidate.provider);
      continue;
    }
    try {
      const fallback = await resolveContextFromModel({
        task: params.params.task,
        model: candidate.model,
        agentId: params.params.agentId,
        enableRag: false,
        maxTokens:
          normalizeMaxTokens(params.maxTokens) ??
          normalizeMaxTokens(params.params.maxTokens) ??
          normalizeMaxTokens(params.params.fallbackMaxTokens),
        expectedProvider: candidate.provider,
      });
      logger.warn(
        {
          task: params.params.task,
          primaryProvider:
            params.primaryProvider || params.params.provider || 'auto',
          fallbackProvider: fallback.provider,
          modelHint: candidate.model,
          primaryModelHint: params.modelHint?.trim() || undefined,
          primaryError: serializeAuxiliaryError(params.primaryError),
        },
        params.logMessage ??
          'Auxiliary provider resolution failed; using remote fallback',
      );
      return fallback;
    } catch (error) {
      errors.push(`${candidate.provider}: ${errorMessage(error)}`);
    }
  }

  throw new Error(
    errors.join('; ') ||
      (unhealthyProviders.length > 0
        ? `no healthy remote fallback provider available; unhealthy providers: ${unhealthyProviders.join(', ')}`
        : 'no remote fallback configured'),
  );
}

async function resolveRemoteFallbackContexts(params: {
  params: AuxiliaryModelCallParams;
  maxTokens?: number;
}): Promise<AuxiliaryTextCallContext[]> {
  const contexts: AuxiliaryTextCallContext[] = [];
  for (const candidate of REMOTE_AUXILIARY_FALLBACKS) {
    if (!(await isFallbackProviderHealthy(candidate.provider))) {
      continue;
    }
    try {
      contexts.push(
        await resolveContextFromModel({
          task: params.params.task,
          model: candidate.model,
          agentId: params.params.agentId,
          enableRag: false,
          maxTokens:
            normalizeMaxTokens(params.maxTokens) ??
            normalizeMaxTokens(params.params.maxTokens) ??
            normalizeMaxTokens(params.params.fallbackMaxTokens),
          expectedProvider: candidate.provider,
        }),
      );
    } catch {
      // Keep collecting configured remote candidates.
    }
  }
  return contexts;
}

async function getFallbackProviderStatus() {
  const now = Date.now();
  if (
    fallbackProviderStatusCache &&
    now - fallbackProviderStatusCache.at < FALLBACK_PROVIDER_STATUS_TTL_MS
  ) {
    return fallbackProviderStatusCache.promise;
  }
  const promise = getGatewayAdminProviderStatus();
  fallbackProviderStatusCache = { at: now, promise };
  return promise;
}

async function isFallbackProviderHealthy(
  provider: RuntimeProvider,
): Promise<boolean> {
  const status = await getFallbackProviderStatus();
  return status[toGatewayModelProviderKey(provider)]?.reachable === true;
}

async function resolveSessionFallbackContext(params: {
  params: AuxiliaryModelCallParams;
  maxTokens?: number;
}): Promise<AuxiliaryTextCallContext | null> {
  const model = params.params.fallbackModel?.trim() ?? '';
  if (!model) return null;
  return resolveContextFromModel({
    task: params.params.task,
    model,
    agentId: params.params.agentId,
    chatbotId: params.params.fallbackChatbotId,
    enableRag: params.params.fallbackEnableRag ?? false,
    maxTokens:
      normalizeMaxTokens(params.maxTokens) ??
      normalizeMaxTokens(params.params.maxTokens) ??
      normalizeMaxTokens(params.params.fallbackMaxTokens),
  });
}

async function withAuxiliaryFallbackChain(
  params: AuxiliaryModelCallParams,
  primaryError: unknown,
  modelHint?: string,
  primaryProvider?: RuntimeProvider,
  remoteLogMessage = 'Auxiliary provider resolution failed; using remote fallback',
  localLogMessage = 'Auxiliary provider resolution failed; using local model fallback',
  maxTokens?: number,
): Promise<AuxiliaryTextCallContext> {
  if (params.allowFallback === false) throw primaryError;
  const localFallback = await resolveLocalFallbackContext({
    params,
    primaryError,
    modelHint,
    primaryProvider,
    logMessage: localLogMessage,
    maxTokens,
  });
  if (localFallback) return localFallback;

  try {
    return await resolveRemoteFallbackContext({
      params,
      primaryError,
      modelHint,
      primaryProvider,
      logMessage: remoteLogMessage,
      maxTokens,
    });
  } catch (fallbackError) {
    try {
      const sessionFallback = await resolveSessionFallbackContext({
        params,
        maxTokens,
      });
      if (sessionFallback) return sessionFallback;
    } catch (sessionFallbackError) {
      throw new Error(
        `${errorMessage(primaryError)} Remote fallback also failed: ${errorMessage(fallbackError)} Session fallback also failed: ${errorMessage(sessionFallbackError)}`,
      );
    }
    throw new Error(
      `${errorMessage(primaryError)} Remote fallback also failed: ${errorMessage(fallbackError)} No session fallback model available.`,
    );
  }
}

function auxiliaryContextKey(context: AuxiliaryTextCallContext): string {
  return `${context.provider}:${context.baseUrl}:${context.model}`;
}

function resolveLocalProviderForModel(
  model: string | null | undefined,
): RuntimeProvider | undefined {
  const trimmed = model?.trim() ?? '';
  if (!trimmed) return undefined;
  const explicitProvider = inferProviderFromModelPrefix(trimmed);
  if (explicitProvider) {
    return isLocalBackendType(explicitProvider) ? explicitProvider : undefined;
  }
  const resolvedProvider = resolveModelProvider(trimmed);
  return isLocalBackendType(resolvedProvider) ? resolvedProvider : undefined;
}

function resolveLocalFallbackProviderOrder(params: {
  params: AuxiliaryModelCallParams;
  modelHint?: string;
}): RuntimeProvider[] {
  const providers: RuntimeProvider[] = [];
  const seen = new Set<string>();
  const pushProvider = (provider: RuntimeProvider | undefined): void => {
    if (!provider || !isLocalBackendType(provider) || seen.has(provider)) {
      return;
    }
    seen.add(provider);
    providers.push(provider);
  };

  for (const provider of LOCAL_AUXILIARY_FALLBACK_ORDER) {
    pushProvider(provider);
  }
  pushProvider(resolveLocalProviderForModel(params.params.fallbackModel));
  pushProvider(resolveLocalProviderForModel(params.modelHint));
  return providers;
}

function resolveLocalCandidateProvider(
  model: string,
  expectedProvider?: RuntimeProvider,
): RuntimeProvider | undefined {
  const explicitProvider = inferProviderFromModelPrefix(model);
  if (explicitProvider) {
    return isLocalBackendType(explicitProvider) ? explicitProvider : undefined;
  }
  if (expectedProvider) {
    return isLocalBackendType(expectedProvider) ? expectedProvider : undefined;
  }
  return resolveLocalProviderForModel(model);
}

function hasCachedReachableLocalBackend(): boolean {
  const cached = localBackendsProbe.peek();
  if (!cached) return false;
  for (const status of cached.values()) {
    if (status.reachable) return true;
  }
  return false;
}

async function discoverLocalModelsForAuxFallback(): Promise<void> {
  if (!hasCachedReachableLocalBackend()) return;
  await discoverAllLocalModels();
}

async function collectLocalFallbackCandidates(params: {
  params: AuxiliaryModelCallParams;
  modelHint?: string;
}): Promise<
  Array<{
    model: string;
    expectedProvider?: RuntimeProvider;
  }>
> {
  await discoverLocalModelsForAuxFallback();

  const candidates: Array<{
    model: string;
    expectedProvider?: RuntimeProvider;
  }> = [];
  const seen = new Set<string>();
  const pushCandidate = (
    model: string | undefined,
    expectedProvider?: RuntimeProvider,
  ): void => {
    const trimmed = model?.trim() ?? '';
    if (!trimmed) return;
    const provider = resolveLocalCandidateProvider(trimmed, expectedProvider);
    if (!provider) return;
    const explicitProvider = inferProviderFromModelPrefix(trimmed);
    const normalized = !explicitProvider
      ? normalizeAuxiliaryProviderModel({ provider, model: trimmed })
      : trimmed;
    const key = `${provider}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ model: normalized, expectedProvider: provider });
  };

  for (const provider of resolveLocalFallbackProviderOrder(params)) {
    pushCandidate(resolveDefaultAuxiliaryModelForProvider(provider), provider);
  }
  pushCandidate(params.params.fallbackModel);
  pushCandidate(params.modelHint);

  return candidates;
}

async function resolveLocalFallbackContext(params: {
  params: AuxiliaryModelCallParams;
  primaryError: unknown;
  modelHint?: string;
  primaryProvider?: RuntimeProvider;
  logMessage?: string;
  maxTokens?: number;
}): Promise<AuxiliaryTextCallContext | null> {
  const candidates = await collectLocalFallbackCandidates(params);

  for (const candidate of candidates) {
    try {
      const providerHint =
        candidate.expectedProvider ??
        inferProviderFromModelPrefix(candidate.model);
      if (
        providerHint &&
        isLocalBackendType(providerHint) &&
        !(await isFallbackProviderHealthy(providerHint))
      ) {
        continue;
      }
      const fallback = await resolveContextFromModel({
        task: params.params.task,
        model: candidate.model,
        agentId: params.params.agentId,
        chatbotId: params.params.fallbackChatbotId,
        enableRag: params.params.fallbackEnableRag ?? false,
        maxTokens:
          normalizeMaxTokens(params.maxTokens) ??
          normalizeMaxTokens(params.params.maxTokens) ??
          normalizeMaxTokens(params.params.fallbackMaxTokens),
        expectedProvider: candidate.expectedProvider,
      });
      if (!isLocalBackendType(fallback.provider)) continue;
      if (!(await isFallbackProviderHealthy(fallback.provider))) continue;
      logger.debug(
        {
          task: params.params.task,
          primaryProvider:
            params.primaryProvider || params.params.provider || 'auto',
          fallbackProvider: fallback.provider,
          modelHint: candidate.model,
          primaryError: serializeAuxiliaryError(params.primaryError),
        },
        params.logMessage ??
          'Auxiliary provider resolution failed; using local model fallback',
      );
      return fallback;
    } catch {
      // Keep trying configured local candidates before falling back to remote.
    }
  }
  return null;
}

async function resolveLocalFallbackContexts(params: {
  params: AuxiliaryModelCallParams;
  modelHint?: string;
  maxTokens?: number;
}): Promise<AuxiliaryTextCallContext[]> {
  const candidates = await collectLocalFallbackCandidates(params);

  const contexts: AuxiliaryTextCallContext[] = [];
  for (const candidate of candidates) {
    try {
      const providerHint =
        candidate.expectedProvider ??
        inferProviderFromModelPrefix(candidate.model);
      if (
        providerHint &&
        isLocalBackendType(providerHint) &&
        !(await isFallbackProviderHealthy(providerHint))
      ) {
        continue;
      }
      const fallback = await resolveContextFromModel({
        task: params.params.task,
        model: candidate.model,
        agentId: params.params.agentId,
        chatbotId: params.params.fallbackChatbotId,
        enableRag: params.params.fallbackEnableRag ?? false,
        maxTokens:
          normalizeMaxTokens(params.maxTokens) ??
          normalizeMaxTokens(params.params.maxTokens) ??
          normalizeMaxTokens(params.params.fallbackMaxTokens),
        expectedProvider: candidate.expectedProvider,
      });
      if (!isLocalBackendType(fallback.provider)) continue;
      if (!(await isFallbackProviderHealthy(fallback.provider))) continue;
      contexts.push(fallback);
    } catch {
      // Keep collecting configured local candidates before remote fallback.
    }
  }
  return contexts;
}

async function resolveAuxiliaryFallbackContexts(params: {
  params: AuxiliaryModelCallParams;
  modelHint?: string;
  maxTokens?: number;
}): Promise<AuxiliaryTextCallContext[]> {
  const sessionFallback = await resolveSessionFallbackContext(params).catch(
    () => null,
  );
  const contexts = [
    ...(await resolveLocalFallbackContexts(params)),
    ...(await resolveRemoteFallbackContexts(params)),
    ...(sessionFallback ? [sessionFallback] : []),
  ];
  const seen = new Set<string>();
  return contexts.filter((context) => {
    const key = auxiliaryContextKey(context);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveExplicitTextCallContextWithFallback(
  params: AuxiliaryModelCallParams,
): Promise<AuxiliaryTextCallContext | null> {
  try {
    return await resolveExplicitTextCallContext(params);
  } catch (error) {
    if (params.allowFallback === false) throw error;
    return withAuxiliaryFallbackChain(
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
    sessionModel: params.fallbackModel,
  });
  if (!taskOverride) return null;
  if (taskOverride?.error) {
    return withAuxiliaryFallbackChain(
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

async function resolveTextCallContext(
  params: AuxiliaryModelCallParams,
): Promise<AuxiliaryTextCallContext> {
  if (isAuxiliaryTaskDisabled(params.task)) {
    throw new Error(`${params.task} auxiliary model is disabled.`);
  }

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
  if (params.allowFallback === false) {
    // An unconfigured task uses the caller's own model, never a provider chain.
    const ownModel = await resolveSessionFallbackContext({
      params,
      maxTokens: requestedMaxTokens,
    });
    if (ownModel) return ownModel;
    throw new Error(
      `${params.task} requires a configured auxiliary model when fallback is disabled.`,
    );
  }

  // 3. Auto-routed auxiliary calls prefer concrete, healthy local candidates
  // before any remote fallback/session model. The resolver only checks health
  // after it finds a local model candidate, avoiding unrelated backend probes.
  const preferredLocal =
    (
      await resolveLocalFallbackContexts({
        params,
        maxTokens: requestedMaxTokens,
      })
    )[0] ?? null;
  if (preferredLocal) return preferredLocal;

  // 4. Then use the fixed remote auxiliary chain.
  try {
    return await resolveRemoteFallbackContext({
      params,
      primaryError: new Error(
        `${params.task} has no configured local auxiliary model.`,
      ),
      modelHint: params.fallbackModel,
      maxTokens: requestedMaxTokens,
    });
  } catch (remoteFallbackError) {
    const sessionFallback = await resolveSessionFallbackContext({
      params,
      maxTokens: requestedMaxTokens,
    });
    if (sessionFallback) return sessionFallback;
    throw remoteFallbackError;
  }
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

function normalizeOllamaBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/g, '').replace(/\/v1$/i, '');
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
): Promise<AuxiliaryTextResponse> {
  const body = withCoreRequestBody(
    buildHybridAIRequestBody({
      model: context.model,
      messages,
      chatbotId: context.chatbotId,
      enableRag: context.enableRag,
      tools: options.tools,
      maxTokens: context.maxTokens,
    }),
    options,
  );

  const response = await fetchHybridAIDestination(
    `${context.baseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: buildJsonHeaders({
        apiKey: context.apiKey,
        requestHeaders: context.requestHeaders,
      }),
      body: JSON.stringify(body),
      signal: createTimeoutSignal(options.timeoutMs),
    },
    context.requestHeaders,
  );
  if (!response.ok) await parseError(response);

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
    usage?: unknown;
  };
  return {
    content: extractResponseTextContent(payload.choices?.[0]?.message?.content),
    usage: readAuxiliaryModelUsage(payload.usage),
  };
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

function openAICompatRequestMaxTokens(
  context: AuxiliaryTextCallContext,
): number | undefined {
  if (
    context.provider === 'openrouter' &&
    !isAnthropicProviderModel(context.model)
  ) {
    return undefined;
  }
  return context.maxTokens;
}

async function callOpenAICompatTextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<AuxiliaryTextResponse> {
  const maxTokens = openAICompatRequestMaxTokens(context);
  const body = withCoreRequestBody(
    buildChatCompletionsBody({
      model: normalizeOpenAICompatModelName(context.provider, context.model),
      messages: collapseSystemMessages(messages),
      tools: options.tools,
      maxTokens,
    }),
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
    if (shouldRetryWithMaxCompletionTokens(responseText, maxTokens)) {
      delete body.max_tokens;
      body.max_completion_tokens = maxTokens;
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
    usage?: unknown;
  };
  return {
    content: extractResponseTextContent(payload.choices?.[0]?.message?.content),
    usage: readAuxiliaryModelUsage(payload.usage),
  };
}

function buildAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const system: string[] = [];
  const anthropicMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }> = [];

  for (const message of messages) {
    const content = chatContentText(message.content).trim();
    if (!content) continue;
    if (message.role === 'system') {
      system.push(content);
      continue;
    }
    anthropicMessages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  return {
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    messages:
      anthropicMessages.length > 0
        ? anthropicMessages
        : [{ role: 'user', content: 'Continue.' }],
  };
}

async function callAnthropicTextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<AuxiliaryTextResponse> {
  if (context.providerMethod === 'claude-cli') {
    throw new Error(
      'Anthropic claude-cli is not supported for host auxiliary calls.',
    );
  }
  const anthropicMessages = buildAnthropicMessages(messages);
  const body = withCoreRequestBody(
    {
      model: stripAnthropicModelPrefix(context.model),
      ...anthropicMessages,
      max_tokens: context.maxTokens ?? 1024,
    },
    options,
  );
  const apiKey = context.apiKey.trim();
  const response = await fetch(
    `${normalizeAnthropicBaseUrl(context.baseUrl)}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(isAnthropicOAuthToken(apiKey)
          ? { Authorization: `Bearer ${apiKey}` }
          : { 'x-api-key': apiKey }),
        ...buildAnthropicSupportingHeaders({ apiKey }),
        ...(context.requestHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: createTimeoutSignal(options.timeoutMs),
    },
  );
  if (!response.ok) await parseError(response);

  const payload = (await response.json()) as {
    content?: unknown;
    usage?: unknown;
  };
  return {
    content: extractResponseTextContent(payload.content),
    usage: readAuxiliaryModelUsage(payload.usage),
  };
}

async function callCodexTextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<AuxiliaryTextResponse> {
  const body: Record<string, unknown> = {
    ...(options.extraBody || {}),
    ...buildResponsesRequestBody({
      provider: context.provider,
      model: context.model,
      messages,
      tools: options.tools,
      // Each task's instructions are the shared prefix, across sessions.
      promptCacheKey: `hybridclaw-aux-${options.task}`,
    }),
    stream: true,
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
  let completion: ResponsesCompletion;
  if (
    contentType.includes('application/json') &&
    !contentType.includes('event-stream')
  ) {
    completion = adaptResponsesPayload(await response.json(), context.model);
  } else {
    if (!response.body) {
      throw new Error('Auxiliary provider returned no response body.');
    }
    const reader = response.body.getReader();
    const state = createResponsesStreamState(context.model);
    const handlers = { onTextDelta: () => undefined };
    try {
      for await (const event of readServerSentEvents(() => reader.read())) {
        if (
          consumeResponsesStreamEvent(event.data, event.event, state, handlers)
        )
          break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    completion = buildResponsesStreamResponse(state, context.model);
  }

  return {
    content: extractResponseTextContent(completion.choices[0]?.message.content),
    usage: readAuxiliaryModelUsage(completion.usage),
  };
}

async function callOllamaTextModel(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<AuxiliaryTextResponse> {
  const { options: extraBodyOptions, ...extraBody } = options.extraBody ?? {};
  const rawOptions = isRecord(extraBodyOptions)
    ? { ...extraBodyOptions }
    : undefined;

  const body: Record<string, unknown> = {
    ...extraBody,
    model: stripProviderPrefix(context.model, 'ollama'),
    messages: messages.map((message) => ({
      role: message.role,
      content: chatContentText(message.content),
    })),
    stream: false,
  };
  if (options.tools.length > 0) {
    body.tools = options.tools;
  }
  const ollamaOptions: Record<string, unknown> = {
    // The window the agent loop sends; another num_ctx makes Ollama reload the
    // model.
    num_ctx:
      getLocalModelInfo(context.model)?.contextWindow ??
      defaultOllamaContextWindow(),
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
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  };
  return {
    content: extractResponseTextContent(payload.message?.content),
    usage: readAuxiliaryModelUsage({
      inputTokens: payload.prompt_eval_count,
      outputTokens: payload.eval_count,
    }),
  };
}

async function callAuxiliaryTextProvider(
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<AuxiliaryTextResponse> {
  if (context.provider === 'openai-codex') {
    return callCodexTextModel(context, messages, options);
  }
  if (context.provider === 'ollama') {
    return callOllamaTextModel(context, messages, options);
  }
  if (context.provider === 'anthropic') {
    return callAnthropicTextModel(context, messages, options);
  }
  if (isOpenAICompatProviderId(context.provider)) {
    return callOpenAICompatTextModel(context, messages, options);
  }
  return callHybridAITextModel(context, messages, options);
}

async function callAuxiliaryTextProviderWithLogging(
  params: AuxiliaryModelCallParams,
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<AuxiliaryTextResponse> {
  const startedAt = Date.now();
  // Explicit no-fallback calls keep endpoint identity for pricing and telemetry.
  const traceModel =
    params.allowFallback === false && params.model
      ? params.model
      : context.model;
  const routingAttempt = startRoutingTraceAttempt(
    traceModel,
    'auxiliary',
    params.traceReason ?? params.task,
  );
  if (typeof logger.info === 'function') {
    logger.info(
      {
        task: params.task,
        provider: context.provider,
        model: context.model,
        messages: messages.length,
        tools: params.tools?.length ?? 0,
        maxTokens: context.maxTokens,
      },
      '[aux-model] call start',
    );
  }

  try {
    const response = await callAuxiliaryTextProvider(
      context,
      messages,
      options,
    );
    response.content = response.content.trim();
    if (!response.content) {
      throw new Error(`${params.task} returned an empty response.`);
    }
    finishRoutingTraceAttempt({
      model: traceModel,
      attempt: routingAttempt,
      status: 'success',
      durationMs: Date.now() - startedAt,
      ...response.usage,
    });
    if (typeof logger.info === 'function') {
      logger.info(
        {
          task: params.task,
          provider: context.provider,
          model: context.model,
          durationMs: Date.now() - startedAt,
          usage: response.usage,
        },
        '[aux-model] call success',
      );
    }
    return response;
  } catch (error) {
    finishRoutingTraceAttempt({
      model: traceModel,
      attempt: routingAttempt,
      status: 'error',
      durationMs: Date.now() - startedAt,
    });
    if (typeof logger.warn === 'function') {
      logger.warn(
        {
          task: params.task,
          provider: context.provider,
          model: context.model,
          durationMs: Date.now() - startedAt,
          error: serializeAuxiliaryError(error),
        },
        '[aux-model] call error',
      );
    }
    throw error;
  }
}

async function callAuxiliaryTextProviderWithFallback(
  params: AuxiliaryModelCallParams,
  context: AuxiliaryTextCallContext,
  messages: ChatMessage[],
  options: AuxiliaryRequestOptions,
): Promise<{
  context: AuxiliaryTextCallContext;
  response: AuxiliaryTextResponse;
}> {
  try {
    return {
      context,
      response: await callAuxiliaryTextProviderWithLogging(
        params,
        context,
        messages,
        options,
      ),
    };
  } catch (error) {
    if (
      params.allowFallback === false ||
      (params.provider && params.provider !== 'auto')
    ) {
      throw error;
    }
    const attempted = new Set([auxiliaryContextKey(context)]);
    const fallbackErrors: string[] = [];
    for (const fallbackContext of await resolveAuxiliaryFallbackContexts({
      params,
      modelHint: context.model,
      maxTokens: context.maxTokens,
    })) {
      const key = auxiliaryContextKey(fallbackContext);
      if (attempted.has(key)) continue;
      attempted.add(key);
      const log = isLocalBackendType(fallbackContext.provider)
        ? logger.debug.bind(logger)
        : logger.warn.bind(logger);
      log(
        {
          task: params.task,
          primaryProvider: context.provider,
          fallbackProvider: fallbackContext.provider,
          modelHint: fallbackContext.model,
          primaryModelHint: context.model,
          primaryError: serializeAuxiliaryError(error),
        },
        isLocalBackendType(fallbackContext.provider)
          ? 'Auxiliary provider call failed; using local model fallback'
          : 'Auxiliary provider call failed; using remote fallback',
      );
      try {
        return {
          context: fallbackContext,
          response: await callAuxiliaryTextProviderWithLogging(
            params,
            fallbackContext,
            messages,
            options,
          ),
        };
      } catch (fallbackError) {
        fallbackErrors.push(
          `${fallbackContext.provider}/${fallbackContext.model}: ${errorMessage(fallbackError)}`,
        );
        logger.warn(
          {
            task: params.task,
            fallbackProvider: fallbackContext.provider,
            modelHint: fallbackContext.model,
            error: serializeAuxiliaryError(fallbackError),
          },
          'Auxiliary fallback provider call failed; trying next fallback',
        );
      }
    }
    throw new Error(
      `${errorMessage(error)} Fallback chain failed: ${
        fallbackErrors.join('; ') || 'no fallback provider available'
      }`,
    );
  }
}

export async function callAuxiliaryModel(
  params: AuxiliaryModelCallParams,
): Promise<{
  provider: RuntimeProvider;
  model: string;
  content: string;
  usage?: AuxiliaryModelUsage;
}> {
  const options = buildRequestOptions(params);
  const initialContext = await resolveTextCallContext(params);
  const { context, response } = await callAuxiliaryTextProviderWithFallback(
    params,
    initialContext,
    Array.isArray(params.messages) ? params.messages : [],
    options,
  );
  return {
    provider: context.provider,
    model: context.model,
    content: response.content,
    ...(response.usage ? { usage: response.usage } : {}),
  };
}
