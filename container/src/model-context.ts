/**
 * One request-scoped routing context serves browser vision and auxiliary tools.
 * Tool calls capture independent snapshots so later requests cannot reroute them.
 * Unlike the provider router, this module stores context and never calls a model;
 * workers rebuild it from each ContainerInput rather than persisting it.
 */
import type { AuxiliaryTaskContext } from './providers/auxiliary.js';
import { resolveRuntimeProviderContext } from './providers/provider-ids.js';
import { TASK_MODEL_KEYS, type TaskModelPolicies } from './types.js';

export interface AuxiliaryRuntimeContext {
  fallbackContext: AuxiliaryTaskContext;
  taskModels?: TaskModelPolicies;
}

let currentModelContext: AuxiliaryTaskContext = {
  provider: 'hybridai',
  baseUrl: '',
  apiKey: '',
  model: '',
  chatbotId: '',
};
let currentTaskModelPolicies: TaskModelPolicies | undefined;

export function cloneTaskModelPolicies(
  taskModels?: TaskModelPolicies,
): TaskModelPolicies | undefined {
  const cloned: TaskModelPolicies = {};
  for (const key of TASK_MODEL_KEYS) {
    const taskModel = taskModels?.[key];
    if (!taskModel) continue;
    cloned[key] = {
      ...taskModel,
      requestHeaders: taskModel.requestHeaders
        ? { ...taskModel.requestHeaders }
        : undefined,
    };
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

export function setModelContext(context: AuxiliaryTaskContext): void {
  currentModelContext = {
    ...context,
    provider: resolveRuntimeProviderContext(context.provider, context.model),
    baseUrl: context.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: context.apiKey.trim(),
    model: context.model.trim(),
    chatbotId: context.chatbotId.trim(),
    requestHeaders: { ...context.requestHeaders },
    maxTokens:
      typeof context.maxTokens === 'number' &&
      Number.isFinite(context.maxTokens) &&
      context.maxTokens > 0
        ? Math.floor(context.maxTokens)
        : undefined,
  };
}

export function setTaskModelPolicies(taskModels?: TaskModelPolicies): void {
  currentTaskModelPolicies = cloneTaskModelPolicies(taskModels);
}

export function captureAuxiliaryRuntimeContext(): AuxiliaryRuntimeContext {
  return {
    fallbackContext: {
      ...currentModelContext,
      requestHeaders: { ...currentModelContext.requestHeaders },
    },
    taskModels: cloneTaskModelPolicies(currentTaskModelPolicies),
  };
}
