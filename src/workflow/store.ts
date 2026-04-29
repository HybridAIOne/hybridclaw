import path from 'node:path';
import { isRecord } from '../a2a/utils.js';
import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  type RuntimeConfigChangeMeta,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
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
  threshold?: 'low' | 'medium' | 'high';
  stakes?: 'low' | 'medium' | 'high';
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
  created_at: string;
  [key: string]: unknown;
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
  return {
    version: 1,
    id: expectedRunId,
    workflow,
    thread_id: String(parsed.thread_id || '').trim(),
    initiator_coworker_id: String(parsed.initiator_coworker_id || '').trim(),
    status:
      parsed.status === 'paused' ||
      parsed.status === 'completed' ||
      parsed.status === 'failed'
        ? parsed.status
        : 'running',
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
  return {
    ...value,
    type: String(value.type || 'workflow.event'),
    ...(typeof value.step_id === 'string' ? { step_id: value.step_id } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    created_at:
      typeof value.created_at === 'string'
        ? value.created_at
        : new Date(0).toISOString(),
  };
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
    .map((entry) => validateWorkflowDefinition(JSON.parse(entry.content)))
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
    .map((entry) => {
      const parsed = JSON.parse(entry.content) as { id?: unknown };
      return parseRunState(entry.content, String(parsed.id || '').trim());
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}
