import {
  getRuntimeConfig,
  type RuntimeAuxiliaryModelPolicyConfig,
  type RuntimeAuxiliaryProviderSelection,
} from '../config/runtime-config.js';
import {
  TASK_MODEL_KEYS,
  type TaskModelKey,
  type TaskModelPolicies,
  type TaskModelPolicy,
} from '../types.js';
import { resolveModelRuntimeCredentials } from './factory.js';

export type AuxiliaryTask = TaskModelKey;

type RuntimeProvider = NonNullable<TaskModelPolicy['provider']>;

const AUXILIARY_TASKS: AuxiliaryTask[] = [...TASK_MODEL_KEYS];

const ENV_OVERRIDE_PREFIXES = ['AUXILIARY_', 'CONTEXT_'] as const;
const RUNTIME_PROVIDER_PREFIXES: Record<RuntimeProvider, string> = {
  hybridai: '',
  'openai-codex': 'openai-codex/',
  openrouter: 'openrouter/',
  ollama: 'ollama/',
  lmstudio: 'lmstudio/',
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
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'hybridai' ||
    normalized === 'openai-codex' ||
    normalized === 'openrouter' ||
    normalized === 'ollama' ||
    normalized === 'lmstudio' ||
    normalized === 'vllm'
  ) {
    return normalized;
  }
  return undefined;
}

function readTaskOverride(
  task: AuxiliaryTask,
  suffix: 'MODEL' | 'PROVIDER',
): string | undefined {
  const taskKey = task.toUpperCase();
  for (const prefix of ENV_OVERRIDE_PREFIXES) {
    const value = String(
      process.env[`${prefix}${taskKey}_${suffix}`] || '',
    ).trim();
    if (value) return value;
  }
  return undefined;
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
  return String(getConfiguredTaskSelection(task).model || '').trim();
}

export function detectRuntimeProviderPrefix(
  model: string,
): RuntimeProvider | undefined {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith('openai-codex/')) return 'openai-codex';
  if (normalized.startsWith('openrouter/')) return 'openrouter';
  if (normalized.startsWith('ollama/')) return 'ollama';
  if (normalized.startsWith('lmstudio/')) return 'lmstudio';
  if (normalized.startsWith('vllm/')) return 'vllm';
  return undefined;
}

function selectFirstNonEmpty(values: string[]): string | undefined {
  return values.find((value) => value.trim())?.trim();
}

export function resolveDefaultAuxiliaryModelForProvider(
  provider: RuntimeProvider,
): string | undefined {
  const config = getRuntimeConfig();

  if (provider === 'hybridai') {
    return selectFirstNonEmpty([
      config.hybridai.defaultModel,
      ...config.hybridai.models,
    ]);
  }

  if (provider === 'openai-codex') {
    return selectFirstNonEmpty(config.codex.models);
  }

  if (provider === 'openrouter') {
    if (!config.openrouter.enabled) return undefined;
    return selectFirstNonEmpty(config.openrouter.models);
  }

  return selectFirstNonEmpty(
    [config.hybridai.defaultModel, ...config.hybridai.models].filter((model) =>
      String(model || '')
        .trim()
        .toLowerCase()
        .startsWith(RUNTIME_PROVIDER_PREFIXES[provider]),
    ),
  );
}

export function normalizeAuxiliaryProviderModel(params: {
  provider: RuntimeProvider;
  model: string;
}): string {
  const trimmed = String(params.model || '').trim();
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
  } = {},
): Promise<TaskModelPolicy | undefined> {
  const configured = getConfiguredTaskSelection(task);
  const providerSelection = getSelectedTaskProvider(task);
  const rawModel = getSelectedTaskModel(task);
  const maxTokens = normalizeMaxTokens(configured.maxTokens);

  if (providerSelection === 'auto' && !rawModel) return undefined;

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
      maxTokens,
    };
  } catch (err) {
    return {
      model,
      maxTokens,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function resolveTaskModelPolicies(
  params: { agentId?: string; chatbotId?: string } = {},
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
