import path from 'node:path';
import type { StakesLevel } from '../../container/shared/stakes-classifier.js';
import { isRecord } from '../a2a/utils.js';
import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  type RuntimeConfigChangeMeta,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { logger } from '../logger.js';
import {
  validateWorkflowDefinition,
  type WorkflowDefinition,
  WorkflowDefinitionValidationError,
} from './schema.js';

export type WorkflowRunStatus = 'running' | 'paused' | 'completed' | 'failed';
export type WorkflowStepRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'revision_requested'
  | 'failed';

export interface WorkflowStepArtifact {
  revision: number;
  created_at: string;
  value: unknown;
}

export interface WorkflowRevisionRequest {
  revision: number;
  from_step_id: string;
  target_step_id: string;
  notes: string;
  actor?: string;
  created_at: string;
}

export interface WorkflowStepEscalation {
  route: 'none' | 'approval_request';
  threshold?: StakesLevel;
  stakes?: StakesLevel;
  classifier?: string;
  reasons: string[];
  requested_at?: string;
  approved_at?: string;
  approved_by?: string;
}

export interface WorkflowStepRunState {
  step_id: string;
  owner_coworker_id: string;
  action: string;
  status: WorkflowStepRunStatus;
  attempts: number;
  artifacts: WorkflowStepArtifact[];
  revisions: WorkflowRevisionRequest[];
  started_at?: string;
  completed_at?: string;
  paused_at?: string;
  failed_at?: string;
  error?: string;
  escalation?: WorkflowStepEscalation;
}

export interface WorkflowRunEvent {
  type: string;
  step_id?: string;
  message?: string;
  owner_coworker_id?: string;
  stakes?: StakesLevel;
  threshold?: StakesLevel;
  classifier?: string;
  reasons?: string[];
  actor?: string;
  from_step_id?: string;
  notes?: string;
  created_at: string;
}

export interface WorkflowRunState {
  version: 1;
  id: string;
  workflow: WorkflowDefinition;
  thread_id: string;
  initiator_coworker_id: string;
  status: WorkflowRunStatus;
  current_step_id?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  failed_at?: string;
  error?: string;
  steps: WorkflowStepRunState[];
  events: WorkflowRunEvent[];
}

export class WorkflowRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunStateError';
  }
}

function normalizeOpaqueId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || /\s/u.test(normalized)) {
    throw new WorkflowRunStateError(
      `${field} must be a non-empty id without whitespace`,
    );
  }
  return normalized;
}

export function workflowRunAssetPath(runId: string): string {
  return path.join(
    DEFAULT_RUNTIME_HOME_DIR,
    'workflows',
    'runs',
    `${encodeURIComponent(normalizeOpaqueId(runId, 'runId'))}.json`,
  );
}

export function workflowDefinitionAssetPath(workflowId: string): string {
  return path.join(
    DEFAULT_RUNTIME_HOME_DIR,
    'workflows',
    'definitions',
    `${encodeURIComponent(normalizeOpaqueId(workflowId, 'workflowId'))}.json`,
  );
}

function parseRunState(raw: string, expectedRunId: string): WorkflowRunState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkflowRunStateError(
      `workflow run JSON is invalid: ${
        error instanceof Error ? error.message : 'unknown parse error'
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new WorkflowRunStateError('workflow run state must be an object');
  }
  if (parsed.version !== 1) {
    throw new WorkflowRunStateError('workflow run state version must be 1');
  }
  if (parsed.id !== expectedRunId) {
    throw new WorkflowRunStateError(
      `workflow run state is for ${String(parsed.id || '<missing>')}`,
    );
  }
  const workflow = validateWorkflowDefinition(parsed.workflow);
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const status = normalizeRunStatus(parsed.status);
  return {
    version: 1,
    id: expectedRunId,
    workflow,
    thread_id: String(parsed.thread_id || '').trim(),
    initiator_coworker_id: String(parsed.initiator_coworker_id || '').trim(),
    status,
    ...(typeof parsed.current_step_id === 'string' && parsed.current_step_id
      ? { current_step_id: parsed.current_step_id }
      : {}),
    created_at: String(parsed.created_at || '').trim(),
    updated_at: String(parsed.updated_at || '').trim(),
    ...(typeof parsed.completed_at === 'string'
      ? { completed_at: parsed.completed_at }
      : {}),
    ...(typeof parsed.failed_at === 'string'
      ? { failed_at: parsed.failed_at }
      : {}),
    ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
    steps: steps.map(parseStepRunState),
    events: events.map(parseRunEvent),
  };
}

function normalizeRunStatus(value: unknown): WorkflowRunStatus {
  if (
    value === 'running' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  throw new WorkflowRunStateError(
    `workflow run status is invalid: ${String(value || '<missing>')}`,
  );
}

function parseStepRunState(value: unknown): WorkflowStepRunState {
  if (!isRecord(value)) {
    throw new WorkflowRunStateError('workflow step run must be an object');
  }
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
  const revisions = Array.isArray(value.revisions) ? value.revisions : [];
  return {
    step_id: String(value.step_id || '').trim(),
    owner_coworker_id: String(value.owner_coworker_id || '').trim(),
    action: String(value.action || ''),
    status: normalizeStepStatus(value.status),
    attempts: Number.isInteger(value.attempts) ? Number(value.attempts) : 0,
    artifacts: artifacts.map(parseArtifact),
    revisions: revisions.map(parseRevisionRequest),
    ...(typeof value.started_at === 'string'
      ? { started_at: value.started_at }
      : {}),
    ...(typeof value.completed_at === 'string'
      ? { completed_at: value.completed_at }
      : {}),
    ...(typeof value.paused_at === 'string'
      ? { paused_at: value.paused_at }
      : {}),
    ...(typeof value.failed_at === 'string'
      ? { failed_at: value.failed_at }
      : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(isRecord(value.escalation)
      ? { escalation: parseEscalation(value.escalation) }
      : {}),
  };
}

function normalizeStepStatus(value: unknown): WorkflowStepRunStatus {
  if (
    value === 'running' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'revision_requested' ||
    value === 'failed'
  ) {
    return value;
  }
  return 'pending';
}

function parseArtifact(value: unknown): WorkflowStepArtifact {
  if (!isRecord(value)) {
    return {
      revision: 1,
      created_at: new Date(0).toISOString(),
      value,
    };
  }
  return {
    revision: Number.isInteger(value.revision) ? Number(value.revision) : 1,
    created_at:
      typeof value.created_at === 'string'
        ? value.created_at
        : new Date(0).toISOString(),
    value: value.value,
  };
}

function parseRevisionRequest(value: unknown): WorkflowRevisionRequest {
  if (!isRecord(value)) {
    throw new WorkflowRunStateError(
      'workflow revision request must be an object',
    );
  }
  return {
    revision: Number.isInteger(value.revision) ? Number(value.revision) : 1,
    from_step_id: String(value.from_step_id || '').trim(),
    target_step_id: String(value.target_step_id || '').trim(),
    notes: String(value.notes || ''),
    ...(typeof value.actor === 'string' ? { actor: value.actor } : {}),
    created_at:
      typeof value.created_at === 'string'
        ? value.created_at
        : new Date(0).toISOString(),
  };
}

function parseEscalation(
  value: Record<string, unknown>,
): WorkflowStepEscalation {
  return {
    route: value.route === 'approval_request' ? 'approval_request' : 'none',
    ...(value.threshold === 'low' ||
    value.threshold === 'medium' ||
    value.threshold === 'high'
      ? { threshold: value.threshold }
      : {}),
    ...(value.stakes === 'low' ||
    value.stakes === 'medium' ||
    value.stakes === 'high'
      ? { stakes: value.stakes }
      : {}),
    ...(typeof value.classifier === 'string'
      ? { classifier: value.classifier }
      : {}),
    reasons: Array.isArray(value.reasons)
      ? value.reasons.map((entry) => String(entry || '')).filter(Boolean)
      : [],
    ...(typeof value.requested_at === 'string'
      ? { requested_at: value.requested_at }
      : {}),
    ...(typeof value.approved_at === 'string'
      ? { approved_at: value.approved_at }
      : {}),
    ...(typeof value.approved_by === 'string'
      ? { approved_by: value.approved_by }
      : {}),
  };
}

function parseRunEvent(value: unknown): WorkflowRunEvent {
  if (!isRecord(value)) {
    return {
      type: 'workflow.event',
      message: String(value || ''),
      created_at: new Date(0).toISOString(),
    };
  }
  const event: WorkflowRunEvent = {
    type: String(value.type || 'workflow.event'),
    created_at:
      typeof value.created_at === 'string'
        ? value.created_at
        : new Date(0).toISOString(),
  };
  if (typeof value.step_id === 'string') event.step_id = value.step_id;
  if (typeof value.message === 'string') event.message = value.message;
  if (typeof value.owner_coworker_id === 'string') {
    event.owner_coworker_id = value.owner_coworker_id;
  }
  if (
    value.stakes === 'low' ||
    value.stakes === 'medium' ||
    value.stakes === 'high'
  ) {
    event.stakes = value.stakes;
  }
  if (
    value.threshold === 'low' ||
    value.threshold === 'medium' ||
    value.threshold === 'high'
  ) {
    event.threshold = value.threshold;
  }
  if (typeof value.classifier === 'string') event.classifier = value.classifier;
  if (Array.isArray(value.reasons)) {
    event.reasons = value.reasons
      .map((entry) => String(entry || ''))
      .filter(Boolean);
  }
  if (typeof value.actor === 'string') event.actor = value.actor;
  if (typeof value.from_step_id === 'string') {
    event.from_step_id = value.from_step_id;
  }
  if (typeof value.notes === 'string') event.notes = value.notes;
  return event;
}

function serializeState(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function saveWorkflowDefinition(
  definition: WorkflowDefinition,
  meta?: RuntimeConfigChangeMeta,
): WorkflowDefinition {
  const normalized = validateWorkflowDefinition(definition);
  syncRuntimeAssetRevisionState(
    'workflow',
    workflowDefinitionAssetPath(normalized.id),
    meta,
    {
      exists: true,
      content: serializeState(normalized),
    },
  );
  return normalized;
}

export function getWorkflowDefinition(
  workflowId: string,
): WorkflowDefinition | null {
  const normalizedWorkflowId = normalizeOpaqueId(workflowId, 'workflowId');
  const state = getRuntimeAssetRevisionState(
    'workflow',
    workflowDefinitionAssetPath(normalizedWorkflowId),
  );
  if (!state) return null;
  try {
    return validateWorkflowDefinition(JSON.parse(state.content) as unknown);
  } catch (error) {
    if (error instanceof WorkflowDefinitionValidationError) throw error;
    throw new WorkflowDefinitionValidationError([
      error instanceof Error ? error.message : 'invalid workflow JSON',
    ]);
  }
}

export function listWorkflowDefinitions(): WorkflowDefinition[] {
  return listRuntimeAssetRevisionStates(
    'workflow',
    path.join(DEFAULT_RUNTIME_HOME_DIR, 'workflows', 'definitions'),
  )
    .flatMap((entry) => {
      try {
        return [validateWorkflowDefinition(JSON.parse(entry.content))];
      } catch (error) {
        logger.warn(
          {
            assetPath: entry.assetPath,
            error: error instanceof Error ? error.message : String(error),
          },
          'Skipping invalid workflow definition state',
        );
        return [];
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function saveWorkflowRunState(
  run: WorkflowRunState,
  meta?: RuntimeConfigChangeMeta,
): WorkflowRunState {
  syncRuntimeAssetRevisionState(
    'workflow',
    workflowRunAssetPath(run.id),
    meta,
    {
      exists: true,
      content: serializeState(run),
    },
  );
  return run;
}

export function getWorkflowRunState(runId: string): WorkflowRunState | null {
  const normalizedRunId = normalizeOpaqueId(runId, 'runId');
  const state = getRuntimeAssetRevisionState(
    'workflow',
    workflowRunAssetPath(normalizedRunId),
  );
  if (!state) return null;
  return parseRunState(state.content, normalizedRunId);
}

export function listWorkflowRunStates(): WorkflowRunState[] {
  return listRuntimeAssetRevisionStates(
    'workflow',
    path.join(DEFAULT_RUNTIME_HOME_DIR, 'workflows', 'runs'),
  )
    .flatMap((entry) => {
      try {
        const parsed = JSON.parse(entry.content) as { id?: unknown };
        return [parseRunState(entry.content, String(parsed.id || '').trim())];
      } catch (error) {
        logger.warn(
          {
            assetPath: entry.assetPath,
            error: error instanceof Error ? error.message : String(error),
          },
          'Skipping invalid workflow run state',
        );
        return [];
      }
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}
