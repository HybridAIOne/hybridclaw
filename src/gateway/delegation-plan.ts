/**
 * Delegation plans — the validated shape of one `delegate` call.
 *
 * Normalizes the tool payload into single/parallel/chain plans with a model
 * per task, and owns the `delegate:dN:` child session id scheme.
 *
 * NOT the runner: `delegation-child-run.ts` executes a task, and
 * `gateway-delegation.ts` schedules plans and returns their results.
 */
import { randomUUID } from 'node:crypto';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { normalizeHybridAIModelForRuntime } from '../providers/model-names.js';
import type {
  ArtifactMetadata,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import type {
  DelegationSideEffect,
  DelegationTaskSpec,
} from '../types/side-effects.js';
import { abbreviateForUser } from './gateway-formatting.js';

const MAX_DELEGATION_TASKS = 6;

export type DelegationMode = 'single' | 'parallel' | 'chain';
export type DelegationRunStatus =
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'blocked';

export interface NormalizedDelegationTask {
  prompt: string;
  label?: string;
  model: string;
}

export interface NormalizedDelegationPlan {
  mode: DelegationMode;
  label?: string;
  tasks: NormalizedDelegationTask[];
}

export interface DelegationRunResult {
  status: DelegationRunStatus;
  sessionId: string;
  model: string;
  durationMs: number;
  attempts: number;
  toolsUsed: string[];
  toolExecutions?: ToolExecution[];
  tokenCount?: number;
  result?: string;
  error?: string;
  artifacts?: ArtifactMetadata[];
}

export interface DelegationCompletionEntry {
  title: string;
  run: DelegationRunResult;
}

export interface DelegationStatusEntry {
  title: string;
  model: string;
  status: 'queued' | 'running' | DelegationRunStatus;
  toolUses: number;
  tokenCount?: number;
  currentTool?: string;
  currentToolDetail?: string;
  lastTool?: string;
  lastToolDetail?: string;
}

export interface DelegationTaskRunInput {
  parentSessionId: string;
  childDepth: number;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  mode: DelegationMode;
  task: NormalizedDelegationTask;
  onToolProgress?: (event: ToolProgressEvent) => void;
  abortSignal?: AbortSignal;
}

export function extractDelegationDepth(sessionId: string): number {
  const match = sessionId.match(/^delegate:d(\d+):/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function delegationSessionPrefix(
  parentSessionId: string,
  depth: number,
): string {
  const safeParent = parentSessionId
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .slice(0, 48);
  return `delegate:d${depth}:${safeParent}:`;
}

export function nextDelegationSessionId(
  parentSessionId: string,
  nextDepth: number,
): string {
  return `${delegationSessionPrefix(parentSessionId, nextDepth)}${Date.now()}:${randomUUID()}`;
}

function normalizeDelegationTask(
  raw: unknown,
  params: {
    fallbackModel: string;
    parentModel: string;
    configuredDelegateModel: string;
  },
): NormalizedDelegationTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as DelegationTaskSpec;
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt) return null;
  const label = typeof task.label === 'string' ? task.label.trim() : '';
  const model = resolveDelegationRequestedModel({
    requestedModel: task.model,
    fallbackModel: params.fallbackModel,
    parentModel: params.parentModel,
    configuredDelegateModel: params.configuredDelegateModel,
  });
  return {
    prompt,
    label: label || undefined,
    model,
  };
}

function resolveDelegationFallbackModel(parentModel: string): string {
  return getRuntimeConfig().proactive.delegation.model.trim() || parentModel;
}

function areEquivalentDelegationModels(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftTrimmed = String(left || '').trim();
  const rightTrimmed = String(right || '').trim();
  if (!leftTrimmed || !rightTrimmed) return false;
  if (
    leftTrimmed.localeCompare(rightTrimmed, undefined, {
      sensitivity: 'accent',
    }) === 0
  ) {
    return true;
  }
  return (
    normalizeHybridAIModelForRuntime(leftTrimmed).toLowerCase() ===
    normalizeHybridAIModelForRuntime(rightTrimmed).toLowerCase()
  );
}

function resolveDelegationRequestedModel(params: {
  requestedModel: string | null | undefined;
  fallbackModel: string;
  parentModel: string;
  configuredDelegateModel: string;
}): string {
  const requestedModel = String(params.requestedModel || '').trim();
  if (!requestedModel) return params.fallbackModel;
  if (
    params.configuredDelegateModel &&
    params.parentModel &&
    areEquivalentDelegationModels(requestedModel, params.parentModel) &&
    !areEquivalentDelegationModels(
      requestedModel,
      params.configuredDelegateModel,
    )
  ) {
    return params.configuredDelegateModel;
  }
  return requestedModel;
}

export function normalizeDelegationEffect(
  effect: DelegationSideEffect,
  fallbackModel: string,
): {
  plan?: NormalizedDelegationPlan;
  error?: string;
} {
  const rawMode =
    typeof effect.mode === 'string' ? effect.mode.trim().toLowerCase() : '';
  const modeRaw: DelegationMode | '' =
    rawMode === 'single' || rawMode === 'parallel' || rawMode === 'chain'
      ? rawMode
      : '';
  if (rawMode && !modeRaw) {
    return { error: 'Invalid delegation mode' };
  }

  const label = typeof effect.label === 'string' ? effect.label.trim() : '';
  const configuredDelegateModel =
    getRuntimeConfig().proactive.delegation.model.trim();
  const resolvedFallbackModel =
    configuredDelegateModel || resolveDelegationFallbackModel(fallbackModel);
  const baseModel = resolveDelegationRequestedModel({
    requestedModel: effect.model,
    fallbackModel: resolvedFallbackModel,
    parentModel: fallbackModel,
    configuredDelegateModel,
  });
  const prompt = typeof effect.prompt === 'string' ? effect.prompt.trim() : '';
  const rawTasks = Array.isArray(effect.tasks) ? effect.tasks : [];
  const rawChain = Array.isArray(effect.chain) ? effect.chain : [];

  let mode: DelegationMode;
  if (modeRaw) mode = modeRaw;
  else if (rawChain.length > 0) mode = 'chain';
  else if (rawTasks.length > 0) mode = 'parallel';
  else mode = 'single';

  if (mode === 'single') {
    if (!prompt) return { error: 'Single-mode delegation missing prompt' };
    return {
      plan: {
        mode,
        label: label || undefined,
        tasks: [{ prompt, label: label || undefined, model: baseModel }],
      },
    };
  }

  const sourceTasks = mode === 'parallel' ? rawTasks : rawChain;
  if (sourceTasks.length === 0) {
    return { error: `${mode} delegation requires at least one task` };
  }
  if (sourceTasks.length > MAX_DELEGATION_TASKS) {
    return {
      error: `${mode} delegation exceeds max tasks (${MAX_DELEGATION_TASKS})`,
    };
  }
  const tasks: NormalizedDelegationTask[] = [];
  for (let i = 0; i < sourceTasks.length; i++) {
    const normalized = normalizeDelegationTask(sourceTasks[i], {
      fallbackModel: baseModel,
      parentModel: fallbackModel,
      configuredDelegateModel,
    });
    if (!normalized)
      return { error: `${mode} delegation task #${i + 1} is invalid` };
    tasks.push(normalized);
  }
  return {
    plan: {
      mode,
      label: label || undefined,
      tasks,
    },
  };
}

export function renderDelegationTaskTitle(
  mode: DelegationMode,
  task: NormalizedDelegationTask,
  index: number,
  total: number,
): string {
  if (task.label && !/[-_]/.test(task.label)) return task.label;
  const promptTitle = task.prompt
    .split(/\r?\n/, 1)[0]
    ?.replace(/\s+/g, ' ')
    .replace(/[.:;,\s]+$/, '')
    .trim();
  if (promptTitle) return abbreviateForUser(promptTitle, 72);
  if (mode === 'chain') return `step ${index + 1}/${total}`;
  if (mode === 'parallel') return `task ${index + 1}/${total}`;
  return 'task';
}

export function interpolateChainPrompt(
  prompt: string,
  previousResult: string,
): string {
  if (!prompt.includes('{previous}')) return prompt;
  const replacement = previousResult.trim() || '(no previous output)';
  return prompt.replace(/\{previous\}/g, replacement);
}
