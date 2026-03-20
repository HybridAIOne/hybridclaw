import type { AgentJob, AgentJobEvent } from '../types.js';

export const JOB_DISPATCH_MAX_ATTEMPTS = 3;
export const JOB_DISPATCH_ACTOR_ID = 'job-dispatcher';
const JOB_DISPATCH_RESET_STATUSES = new Set(['ready', 'in_progress']);

export type JobDispatchAction =
  | 'none'
  | 'dispatch_started'
  | 'dispatch_failed'
  | 'dispatch_succeeded'
  | 'dispatch_exhausted';

export interface AgentJobDispatchState {
  phase:
    | 'planning'
    | 'unassigned'
    | 'queued'
    | 'working'
    | 'retrying'
    | 'blocked'
    | 'completed';
  label: string;
  summary: string;
  attemptCount: number;
  maxAttempts: number;
  lastAction: JobDispatchAction;
  lastActionAt: string | null;
  sessionId: string | null;
}

function normalizeAssigneeId(value: string | null | undefined): string {
  return String(value || '').trim();
}

function parseJobEventPayload(event: AgentJobEvent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payload_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed payloads in dispatch inspection
  }
  return {};
}

function isDispatchAction(
  action: string,
): action is Exclude<JobDispatchAction, 'none'> {
  return (
    action === 'dispatch_started' ||
    action === 'dispatch_failed' ||
    action === 'dispatch_succeeded' ||
    action === 'dispatch_exhausted'
  );
}

function isDispatchResetEvent(event: AgentJobEvent): boolean {
  if (event.actor_id === JOB_DISPATCH_ACTOR_ID) return false;
  const payload = parseJobEventPayload(event);
  if (event.action === 'moved') {
    const toStatus = String(payload.toStatus || '').trim();
    return JOB_DISPATCH_RESET_STATUSES.has(toStatus);
  }
  if (event.action === 'updated') {
    return Object.hasOwn(payload, 'assigneeAgentId');
  }
  return false;
}

export function inspectAgentJobDispatchState(
  job: Pick<AgentJob, 'assignee_agent_id' | 'status'>,
  events: AgentJobEvent[],
): AgentJobDispatchState {
  let attemptCount = 0;
  let lastAction: JobDispatchAction = 'none';
  let lastActionAt: string | null = null;
  let sessionId: string | null = null;

  for (const event of events) {
    if (isDispatchResetEvent(event)) break;
    if (!isDispatchAction(event.action)) continue;
    const payload = parseJobEventPayload(event);
    if (lastAction === 'none') {
      lastAction = event.action;
      lastActionAt = event.created_at;
      sessionId = String(payload.sessionId || '').trim() || null;
    }
    if (event.action === 'dispatch_started') {
      attemptCount += 1;
    }
  }

  const assigneeAgentId = normalizeAssigneeId(job.assignee_agent_id);
  if (!assigneeAgentId) {
    return {
      phase: 'unassigned',
      label: 'unassigned',
      summary: 'No agent assigned',
      attemptCount,
      maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
      lastAction,
      lastActionAt,
      sessionId,
    };
  }

  if (job.status === 'done') {
    return {
      phase: 'completed',
      label: 'done',
      summary: `${assigneeAgentId} completed it`,
      attemptCount,
      maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
      lastAction,
      lastActionAt,
      sessionId,
    };
  }

  if (job.status === 'blocked') {
    return {
      phase: 'blocked',
      label:
        attemptCount >= JOB_DISPATCH_MAX_ATTEMPTS
          ? `blocked ${attemptCount}/${JOB_DISPATCH_MAX_ATTEMPTS}`
          : 'blocked',
      summary:
        attemptCount >= JOB_DISPATCH_MAX_ATTEMPTS
          ? `${assigneeAgentId} exhausted retries`
          : `${assigneeAgentId} is blocked`,
      attemptCount,
      maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
      lastAction,
      lastActionAt,
      sessionId,
    };
  }

  if (job.status === 'in_progress') {
    if (
      lastAction === 'dispatch_failed' &&
      attemptCount < JOB_DISPATCH_MAX_ATTEMPTS
    ) {
      return {
        phase: 'retrying',
        label: `retry ${attemptCount}/${JOB_DISPATCH_MAX_ATTEMPTS}`,
        summary: `${assigneeAgentId} will retry automatically`,
        attemptCount,
        maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
        lastAction,
        lastActionAt,
        sessionId,
      };
    }
    if (
      lastAction === 'dispatch_started' ||
      lastAction === 'dispatch_succeeded'
    ) {
      return {
        phase: 'working',
        label: 'working',
        summary: `${assigneeAgentId} is working`,
        attemptCount,
        maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
        lastAction,
        lastActionAt,
        sessionId,
      };
    }
    return {
      phase: 'queued',
      label: 'queued',
      summary: `Waiting for ${assigneeAgentId} to pick it up`,
      attemptCount,
      maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
      lastAction,
      lastActionAt,
      sessionId,
    };
  }

  if (job.status === 'ready') {
    return {
      phase: 'queued',
      label: 'queued',
      summary: `Queued for ${assigneeAgentId}`,
      attemptCount,
      maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
      lastAction,
      lastActionAt,
      sessionId,
    };
  }

  return {
    phase: 'planning',
    label: assigneeAgentId ? 'assigned' : 'unassigned',
    summary: assigneeAgentId
      ? `Assigned to ${assigneeAgentId}`
      : 'Not assigned yet',
    attemptCount,
    maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
    lastAction,
    lastActionAt,
    sessionId,
  };
}
