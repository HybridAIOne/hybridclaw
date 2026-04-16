import {
  getRuntimeConfig,
  type RuntimeAuxiliaryModelPolicyConfig,
  type RuntimeAuxiliaryProviderSelection,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  TASK_MODEL_KEYS,
  type TaskModelKey,
  type TaskModelPolicies,
  type TaskModelPolicy,
} from '../types/models.js';
import {
  resolveModelProvider,
  resolveModelRuntimeCredentials,
} from './factory.js';
import {
  findVisionCapableModel,
  getAvailableModelList,
  isModelVisionCapable,
} from './model-catalog.js';
import { discoverOpenRouterModels } from './openrouter-discovery.js';
import { isRuntimeProviderId, type RuntimeProviderId } from './provider-ids.js';
import { resolveProviderRequestMaxTokens } from './request-max-tokens.js';

export type AuxiliaryTask = TaskModelKey;

type RuntimeProvider = RuntimeProviderId;
type TaskOverrideSuffix = 'MODEL' | 'PROVIDER';
type TaskOverrideSnapshot = Partial<
  Record<AuxiliaryTask, Partial<Record<TaskOverrideSuffix, string>>>
>;

const AUXILIARY_TASKS: AuxiliaryTask[] = [...TASK_MODEL_KEYS];

const ENV_OVERRIDE_PREFIXES = ['AUXILIARY_', 'CONTEXT_'] as const;
const RUNTIME_PROVIDER_PREFIXES: Record<RuntimeProvider, string> = {
  hybridai: '',
  'openai-codex': 'openai-codex/',
  openrouter: 'openrouter/',
  mistral: 'mistral/',
  huggingface: 'huggingface/',
  gemini: 'gemini/',
  deepseek: 'deepseek/',
  xai: 'xai/',
  zai: 'zai/',
  kimi: 'kimi/',
  minimax: 'minimax/',
  dashscope: 'dashscope/',
  xiaomi: 'xiaomi/',
  kilo: 'kilo/',
  ollama: 'ollama/',
  lmstudio: 'lmstudio/',
  llamacpp: 'llamacpp/',
  vllm: 'vllm/',
};

export function normalizeMaxTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeTaskProviderSelection(
  value: string | undefined,
): RuntimeAuxiliaryProviderSelection | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'auto' || isRuntimeProviderId(normalized)) {
    return normalized;
  }
  return undefined;
}

function readTaskOverrideSnapshot(): TaskOverrideSnapshot {
  const snapshot: TaskOverrideSnapshot = {};
  for (const task of AUXILIARY_TASKS) {
    const taskKey = task.toUpperCase();
    for (const suffix of ['MODEL', 'PROVIDER'] as const) {
      for (const prefix of ENV_OVERRIDE_PREFIXES) {
        const value =
          process.env[`${prefix}${taskKey}_${suffix}`]?.trim() ?? '';
        if (!value) continue;
        snapshot[task] = {
          ...(snapshot[task] || {}),
          [suffix]: value,
        };
        break;
      }
    }
  }
  return snapshot;
}

// Snapshot env overrides once at module load so a running worker sees stable
// task-routing behavior for its lifetime instead of re-reading process.env.
const TASK_OVERRIDE_SNAPSHOT = readTaskOverrideSnapshot();

function readTaskOverride(
  task: AuxiliaryTask,
  suffix: TaskOverrideSuffix,
): string | undefined {
  return TASK_OVERRIDE_SNAPSHOT[task]?.[suffix];
}

function getConfiguredTaskSelection(
  task: AuxiliaryTask,
): RuntimeAuxiliaryModelPolicyConfig {
  return getRuntimeConfig().auxiliaryModels[task];
}

function getSelectedTaskProvider(
  task: AuxiliaryTask,
): RuntimeAuxiliaryProviderSelection {
  const override = normalizeTaskProviderSelection(
    readTaskOverride(task, 'PROVIDER'),
  );
  if (override) return override;
  return getConfiguredTaskSelection(task).provider;
}

function getSelectedTaskModel(task: AuxiliaryTask): string {
  const override = readTaskOverride(task, 'MODEL');
  if (override) return override;
  return getConfiguredTaskSelection(task).model.trim();
}

export function detectRuntimeProviderPrefix(
  model: string,
): RuntimeProvider | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith('openai-codex/')) return 'openai-codex';
  if (normalized.startsWith('openrouter/')) return 'openrouter';
  if (normalized.startsWith('mistral/')) return 'mistral';
  if (normalized.startsWith('huggingface/')) return 'huggingface';
  if (normalized.startsWith('ollama/')) return 'ollama';
  if (normalized.startsWith('lmstudio/')) return 'lmstudio';
  if (normalized.startsWith('llamacpp/')) return 'llamacpp';
  if (normalized.startsWith('vllm/')) return 'vllm';
  return undefined;
}

function selectFirstNonEmpty(values: string[]): string | undefined {
  return values.find((value) => value.trim())?.trim();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveDefaultAuxiliaryModelForProvider(
  provider: RuntimeProvider,
): string | undefined {
  const config = getRuntimeConfig();
  const currentDefaultModel = config.hybridai.defaultModel.trim();
  const currentDefaultProvider = currentDefaultModel
    ? resolveModelProvider(currentDefaultModel)
    : undefined;
  const discoveredModels = getAvailableModelList(
    provider === 'openai-codex' ? 'codex' : provider,
  );

  if (provider === 'hybridai') {
    return selectFirstNonEmpty([
      currentDefaultProvider === 'hybridai' ? currentDefaultModel : '',
      ...discoveredModels,
      'gpt-4.1-mini',
    ]);
  }

  if (provider === 'openai-codex') {
    return selectFirstNonEmpty([
      currentDefaultProvider === 'openai-codex' ? currentDefaultModel : '',
      ...discoveredModels,
    ]);
  }

  if (provider === 'openrouter') {
    if (!config.openrouter.enabled) return undefined;
    return selectFirstNonEmpty([
      currentDefaultProvider === 'openrouter' ? currentDefaultModel : '',
      ...discoveredModels,
      'openrouter/anthropic/claude-sonnet-4',
    ]);
  }

  if (provider === 'mistral') {
    if (!config.mistral.enabled) return undefined;
    return selectFirstNonEmpty([
      currentDefaultProvider === 'mistral' ? currentDefaultModel : '',
      ...discoveredModels,
      'mistral/mistral-large-latest',
    ]);
  }

  if (provider === 'huggingface') {
    if (!config.huggingface.enabled) return undefined;
    return selectFirstNonEmpty([
      currentDefaultProvider === 'huggingface' ? currentDefaultModel : '',
      ...discoveredModels,
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ]);
  }

  return selectFirstNonEmpty(discoveredModels);
}

export function normalizeAuxiliaryProviderModel(params: {
  provider: RuntimeProvider;
  model: string;
}): string {
  const trimmed = params.model.trim();
  if (!trimmed) {
    return resolveDefaultAuxiliaryModelForProvider(params.provider) || '';
  }

  const explicitPrefix = detectRuntimeProviderPrefix(trimmed);
  if (params.provider === 'hybridai') {
    if (explicitPrefix) {
      throw new Error(
        `hybridai provider override cannot be used with provider-prefixed model "${trimmed}".`,
      );
    }
    return trimmed;
  }

  if (explicitPrefix && explicitPrefix !== params.provider) {
    throw new Error(
      `${params.provider} provider override cannot be used with model "${trimmed}".`,
    );
  }
  if (explicitPrefix === params.provider) return trimmed;
  return `${RUNTIME_PROVIDER_PREFIXES[params.provider]}${trimmed}`;
}

export async function resolveTaskModelPolicy(
  task: AuxiliaryTask,
  params: {
    agentId?: string;
    chatbotId?: string;
    /** The session/fallback model that would be used if no task override is
     *  configured.  For the `vision` task this is checked for vision capability
     *  so the router can substitute a capable model when necessary. */
    sessionModel?: string;
  } = {},
): Promise<TaskModelPolicy | undefined> {
  const configured = getConfiguredTaskSelection(task);
  const providerSelection = getSelectedTaskProvider(task);
  const rawModel = getSelectedTaskModel(task);
  const maxTokens = normalizeMaxTokens(configured.maxTokens);

  if (providerSelection === 'auto' && !rawModel) {
    // For the vision task, verify that the session/fallback model actually
    // supports image inputs.  If it does not, find a vision-capable model
    // from the catalog and return it as an override so the container never
    // attempts a vision call against a text-only model.
    if (task === 'vision' && params.sessionModel) {
      let sessionModelIsVisionCapable = isModelVisionCapable(
        params.sessionModel,
      );
      let discoveredOpenRouterModels: string[] = [];
      if (!sessionModelIsVisionCapable) {
        discoveredOpenRouterModels = await discoverOpenRouterModels();
        sessionModelIsVisionCapable = isModelVisionCapable(params.sessionModel);
      }

      if (!sessionModelIsVisionCapable) {
        const fallback = findVisionCapableModel(params.sessionModel);
        if (fallback) {
          logger.info(
            {
              task,
              sessionModel: params.sessionModel,
              visionFallback: fallback,
            },
            'Session model lacks vision support; routing vision task to capable model',
          );
          try {
            const resolved = await resolveModelRuntimeCredentials({
              model: fallback,
              chatbotId: params.chatbotId,
              enableRag: false,
              agentId: params.agentId,
            });
            return {
              provider: resolved.provider,
              baseUrl: resolved.baseUrl,
              apiKey: resolved.apiKey,
              requestHeaders: { ...resolved.requestHeaders },
              isLocal: resolved.isLocal,
              contextWindow: resolved.contextWindow,
              thinkingFormat: resolved.thinkingFormat,
              model: fallback,
              chatbotId: resolved.chatbotId,
              maxTokens: resolveProviderRequestMaxTokens({
                model: fallback,
                discoveredMaxTokens: resolved.maxTokens,
              }),
            };
          } catch (err) {
            logger.warn(
              { task, visionFallback: fallback, err },
              'Failed to resolve vision fallback model credentials',
            );
            return {
              provider: detectRuntimeProviderPrefix(fallback),
              model: fallback,
              maxTokens,
              error:
                `Session model "${params.sessionModel}" does not support vision/image inputs, ` +
                `and fallback model "${fallback}" could not be resolved: ${errorMessage(err)}`,
            };
          }
        } else {
          logger.warn(
            {
              task,
              sessionModel: params.sessionModel,
              openrouterDiscoveredModels: discoveredOpenRouterModels.length,
            },
            'Session model lacks vision support and no capable fallback model is available',
          );
          return {
            provider: detectRuntimeProviderPrefix(params.sessionModel),
            model: params.sessionModel,
            maxTokens,
            error:
              `Session model "${params.sessionModel}" does not support vision/image inputs, ` +
              'and no vision-capable fallback model is available.',
          };
        }
      }
    }
    return undefined;
  }

  const model =
    providerSelection === 'auto'
      ? rawModel
      : normalizeAuxiliaryProviderModel({
          provider: providerSelection,
          model: rawModel,
        });

  if (!model) {
    return {
      model: '',
      maxTokens,
      error: `Provider "${providerSelection}" is selected for task "${task}", but no default model is configured.`,
    };
  }

  const expectedProvider =
    providerSelection === 'auto'
      ? detectRuntimeProviderPrefix(model)
      : providerSelection;

  try {
    const resolved = await resolveModelRuntimeCredentials({
      model,
      chatbotId: params.chatbotId,
      enableRag: false,
      agentId: params.agentId,
    });
    if (expectedProvider && resolved.provider !== expectedProvider) {
      throw new Error(
        `Provider "${expectedProvider}" is not available for model "${model}".`,
      );
    }
    return {
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      requestHeaders: { ...resolved.requestHeaders },
      isLocal: resolved.isLocal,
      contextWindow: resolved.contextWindow,
      thinkingFormat: resolved.thinkingFormat,
      model,
      chatbotId: resolved.chatbotId,
      maxTokens: resolveProviderRequestMaxTokens({
        model,
        discoveredMaxTokens: resolved.maxTokens,
      }),
    };
  } catch (err) {
    logger.warn(
      {
        task,
        provider: providerSelection,
        model,
        err,
      },
      'Failed to resolve auxiliary task model policy',
    );
    return {
      model,
      maxTokens,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function resolveTaskModelPolicies(
  params: { agentId?: string; chatbotId?: string; sessionModel?: string } = {},
): Promise<TaskModelPolicies | undefined> {
  const taskModels: TaskModelPolicies = {};
  for (const task of AUXILIARY_TASKS) {
    const policy = await resolveTaskModelPolicy(task, params);
    if (policy) {
      taskModels[task] = policy;
    }
  }
  return Object.keys(taskModels).length > 0 ? taskModels : undefined;
}
