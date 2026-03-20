import { logger } from '../logger.js';
import {
  getAgentJobById,
  listAgentJobEvents,
  listAgentJobs,
  moveAgentJob,
  recordAgentJobEvent,
} from '../memory/db.js';
import type { AgentJob } from '../types.js';
import { buildSessionKey } from '../session/session-key.js';
import { AGENT_JOB_BOARD_ID } from './gateway.js';
import {
  inspectAgentJobDispatchState,
  JOB_DISPATCH_ACTOR_ID,
  JOB_DISPATCH_MAX_ATTEMPTS,
} from './dispatch-state.js';

const JOB_DISPATCH_INTERVAL_MS = 5_000;
const JOB_DISPATCH_SOURCE = 'scheduler';
const JOB_DISPATCH_CHANNEL_ID = 'scheduler';
const JOB_DISPATCH_USER_ID = 'job-dispatcher';
const JOB_DISPATCH_USERNAME = 'job-dispatcher';

interface JobDispatchResult {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
  pendingApproval?: unknown;
}

interface JobDispatcherHost {
  handleGatewayMessage: (request: {
    sessionId: string;
    guildId: string | null;
    channelId: string;
    userId: string;
    username: string;
    content: string;
    agentId?: string | null;
    source?: string;
  }) => Promise<JobDispatchResult>;
}

let jobDispatcherHost: JobDispatcherHost | null = null;
let jobDispatcherTimer: ReturnType<typeof setInterval> | null = null;
let jobDispatcherRunning = false;
const activeJobIds = new Set<number>();
const activeAssigneeIds = new Set<string>();

function normalizeAssigneeId(value: string | null | undefined): string {
  return String(value || '').trim();
}

function requireJobDispatcherHost(): JobDispatcherHost {
  if (jobDispatcherHost) return jobDispatcherHost;
  throw new Error('Job dispatcher host has not been configured.');
}

function buildJobDispatchSessionId(job: AgentJob): string {
  const assignee = normalizeAssigneeId(job.assignee_agent_id);
  return buildSessionKey(assignee, 'scheduler', 'job', `job-${job.id}`);
}

function buildJobDispatchPrompt(job: AgentJob): string {
  const details = job.details.trim() || '(none)';
  const sourceSessionId = job.source_session_id || '(none)';
  const linkedTaskId =
    job.linked_task_id == null ? '(none)' : String(job.linked_task_id);
  return [
    '[Assigned job dispatch]',
    'You were automatically dispatched to work an assigned kanban job.',
    'The system already moved the job to in_progress.',
    'The dispatcher will finalize the job based on this run result, so focus on doing the work.',
    'Use the job tool only if you need to create follow-up jobs or update notes while you work.',
    '',
    `Job #${job.id}`,
    `Title: ${job.title}`,
    `Priority: ${job.priority}`,
    `Details: ${details}`,
    `Source session: ${sourceSessionId}`,
    `Linked task: ${linkedTaskId}`,
    '',
    'Complete the work now. If you are blocked, explain the blocker clearly in your final response.',
  ].join('\n');
}

function releaseActiveDispatch(jobId: number, assigneeAgentId: string): void {
  activeJobIds.delete(jobId);
  if (assigneeAgentId) {
    activeAssigneeIds.delete(assigneeAgentId);
  }
}

function shouldAutoDispatchJob(job: AgentJob): boolean {
  return (
    !job.archived_at &&
    (job.status === 'ready' || job.status === 'in_progress') &&
    normalizeAssigneeId(job.assignee_agent_id).length > 0
  );
}

async function finalizeJobDispatch(params: {
  jobId: number;
  assigneeAgentId: string;
  sessionId: string;
  attempt: number;
  result: JobDispatchResult;
}): Promise<void> {
  const { jobId, assigneeAgentId, sessionId, attempt, result } = params;
  const current = getAgentJobById(jobId);
  if (!current || current.archived_at) return;
  if (current.status !== 'in_progress') {
    logger.info(
      {
        jobId,
        assigneeAgentId,
        attempt,
        status: current.status,
      },
      'Skipping automatic job finalization because the job changed during dispatch',
    );
    return;
  }
  if (result.status === 'success' && !result.pendingApproval) {
    recordAgentJobEvent({
      jobId,
      actorKind: 'system',
      actorId: JOB_DISPATCH_ACTOR_ID,
      action: 'dispatch_succeeded',
      payload: {
        attempt,
        sessionId,
      },
    });
    moveAgentJob({
      id: jobId,
      status: 'done',
      actorKind: 'system',
      actorId: JOB_DISPATCH_ACTOR_ID,
    });
    logger.info(
      { jobId, assigneeAgentId },
      'Automatically completed assigned agent job',
    );
    return;
  }
  const willRetry = attempt < JOB_DISPATCH_MAX_ATTEMPTS;
  recordAgentJobEvent({
    jobId,
    actorKind: 'system',
    actorId: JOB_DISPATCH_ACTOR_ID,
    action: 'dispatch_failed',
    payload: {
      attempt,
      sessionId,
      error: result.error || null,
      pendingApproval: result.pendingApproval ? true : false,
      willRetry,
    },
  });
  if (willRetry) {
    logger.warn(
      {
        jobId,
        assigneeAgentId,
        attempt,
        maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
        error: result.error || null,
        pendingApproval: result.pendingApproval ? true : false,
      },
      'Assigned agent job dispatch failed and will be retried',
    );
    return;
  }
  moveAgentJob({
    id: jobId,
    status: 'blocked',
    actorKind: 'system',
    actorId: JOB_DISPATCH_ACTOR_ID,
  });
  recordAgentJobEvent({
    jobId,
    actorKind: 'system',
    actorId: JOB_DISPATCH_ACTOR_ID,
    action: 'dispatch_exhausted',
    payload: {
      attempt,
      maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
      sessionId,
    },
  });
  logger.warn(
    {
      jobId,
      assigneeAgentId,
      attempt,
      maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
      error: result.error || null,
      pendingApproval: result.pendingApproval ? true : false,
    },
    'Automatically blocked assigned agent job after exhausting retries',
  );
}

function maybeBlockExhaustedInProgressJob(job: AgentJob): boolean {
  if (job.status !== 'in_progress') return false;
  const dispatchState = inspectAgentJobDispatchState(
    job,
    listAgentJobEvents(job.id),
  );
  if (dispatchState.attemptCount < JOB_DISPATCH_MAX_ATTEMPTS) {
    return false;
  }
  if (
    dispatchState.lastAction === 'dispatch_failed' ||
    dispatchState.lastAction === 'dispatch_started'
  ) {
    moveAgentJob({
      id: job.id,
      status: 'blocked',
      actorKind: 'system',
      actorId: JOB_DISPATCH_ACTOR_ID,
    });
    recordAgentJobEvent({
      jobId: job.id,
      actorKind: 'system',
      actorId: JOB_DISPATCH_ACTOR_ID,
      action: 'dispatch_exhausted',
      payload: {
        attempt: dispatchState.attemptCount,
        maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
        sessionId: buildJobDispatchSessionId(job),
      },
    });
    logger.warn(
      {
        jobId: job.id,
        assigneeAgentId: job.assignee_agent_id,
        attempts: dispatchState.attemptCount,
      },
      'Automatically blocked in-progress job because dispatch retries were exhausted',
    );
    return true;
  }
  return false;
}

async function dispatchAgentJob(job: AgentJob): Promise<void> {
  const assigneeAgentId = normalizeAssigneeId(job.assignee_agent_id);
  try {
    const current = getAgentJobById(job.id);
    if (!current || !shouldAutoDispatchJob(current)) {
      return;
    }
    if (normalizeAssigneeId(current.assignee_agent_id) !== assigneeAgentId) {
      return;
    }
    if (maybeBlockExhaustedInProgressJob(current)) {
      return;
    }
    const dispatchState = inspectAgentJobDispatchState(
      current,
      listAgentJobEvents(current.id),
    );
    const attempt = dispatchState.attemptCount + 1;
    if (attempt > JOB_DISPATCH_MAX_ATTEMPTS) {
      return;
    }

    const startedJob =
      current.status === 'ready'
        ? moveAgentJob({
            id: current.id,
            status: 'in_progress',
            actorKind: 'system',
            actorId: JOB_DISPATCH_ACTOR_ID,
          })
        : current;
    const sessionId = buildJobDispatchSessionId(startedJob);
    recordAgentJobEvent({
      jobId: startedJob.id,
      actorKind: 'system',
      actorId: JOB_DISPATCH_ACTOR_ID,
      action: 'dispatch_started',
      payload: {
        attempt,
        sessionId,
        fromStatus: current.status,
      },
    });
    logger.info(
      {
        jobId: startedJob.id,
        assigneeAgentId,
        attempt,
        sessionId,
      },
      'Dispatching assigned agent job',
    );
    const result = await requireJobDispatcherHost().handleGatewayMessage({
      sessionId,
      guildId: null,
      channelId: JOB_DISPATCH_CHANNEL_ID,
      userId: JOB_DISPATCH_USER_ID,
      username: JOB_DISPATCH_USERNAME,
      content: buildJobDispatchPrompt(startedJob),
      agentId: assigneeAgentId,
      source: JOB_DISPATCH_SOURCE,
    });
    await finalizeJobDispatch({
      jobId: startedJob.id,
      assigneeAgentId,
      sessionId,
      attempt,
      result,
    });
  } catch (error) {
    const current = getAgentJobById(job.id);
    const dispatchState = inspectAgentJobDispatchState(
      job,
      listAgentJobEvents(job.id),
    );
    const attempt = Math.min(
      Math.max(1, dispatchState.attemptCount),
      JOB_DISPATCH_MAX_ATTEMPTS,
    );
    logger.error(
      {
        jobId: job.id,
        assigneeAgentId,
        attempt,
        error,
      },
      'Assigned agent job dispatch failed',
    );
    recordAgentJobEvent({
      jobId: job.id,
      actorKind: 'system',
      actorId: JOB_DISPATCH_ACTOR_ID,
      action: 'dispatch_failed',
      payload: {
        attempt,
        sessionId: buildJobDispatchSessionId(job),
        error: error instanceof Error ? error.message : String(error),
        pendingApproval: false,
        willRetry: attempt < JOB_DISPATCH_MAX_ATTEMPTS,
      },
    });
    if (current && !current.archived_at && current.status === 'in_progress') {
      if (attempt >= JOB_DISPATCH_MAX_ATTEMPTS) {
        moveAgentJob({
          id: current.id,
          status: 'blocked',
          actorKind: 'system',
          actorId: JOB_DISPATCH_ACTOR_ID,
        });
        recordAgentJobEvent({
          jobId: current.id,
          actorKind: 'system',
          actorId: JOB_DISPATCH_ACTOR_ID,
          action: 'dispatch_exhausted',
          payload: {
            attempt,
            maxAttempts: JOB_DISPATCH_MAX_ATTEMPTS,
            sessionId: buildJobDispatchSessionId(current),
          },
        });
      }
    }
  } finally {
    releaseActiveDispatch(job.id, assigneeAgentId);
  }
}

export function configureJobDispatcherRuntime(host: JobDispatcherHost): void {
  jobDispatcherHost = host;
}

export async function dispatchReadyAgentJobsOnce(): Promise<void> {
  if (jobDispatcherRunning) return;
  jobDispatcherRunning = true;
  try {
    const busyAssigneeIds = new Set(activeAssigneeIds);
    const candidates = [
      ...listAgentJobs({
        boardId: AGENT_JOB_BOARD_ID,
        status: 'in_progress',
      }),
      ...listAgentJobs({
        boardId: AGENT_JOB_BOARD_ID,
        status: 'ready',
      }),
    ];
    const pendingDispatches: Promise<void>[] = [];
    for (const job of candidates) {
      if (!shouldAutoDispatchJob(job)) continue;
      if (maybeBlockExhaustedInProgressJob(job)) continue;
      const assigneeAgentId = normalizeAssigneeId(job.assignee_agent_id);
      if (activeJobIds.has(job.id)) continue;
      if (activeAssigneeIds.has(assigneeAgentId)) continue;
      if (busyAssigneeIds.has(assigneeAgentId)) continue;
      activeJobIds.add(job.id);
      activeAssigneeIds.add(assigneeAgentId);
      busyAssigneeIds.add(assigneeAgentId);
      pendingDispatches.push(dispatchAgentJob(job));
    }
    if (pendingDispatches.length > 0) {
      await Promise.all(pendingDispatches);
    }
  } finally {
    jobDispatcherRunning = false;
  }
}

export function startJobDispatcher(intervalMs = JOB_DISPATCH_INTERVAL_MS): void {
  if (jobDispatcherTimer) return;
  if (!jobDispatcherHost) {
    logger.debug('Job dispatcher start skipped because the host is not configured');
    return;
  }
  logger.info({ intervalMs }, 'Job dispatcher started');
  jobDispatcherTimer = setInterval(() => {
    void dispatchReadyAgentJobsOnce().catch((error) => {
      logger.error({ error }, 'Job dispatcher tick failed');
    });
  }, intervalMs);
  jobDispatcherTimer.unref?.();
}

export function stopJobDispatcher(): void {
  if (jobDispatcherTimer) {
    clearInterval(jobDispatcherTimer);
    jobDispatcherTimer = null;
  }
  activeJobIds.clear();
  activeAssigneeIds.clear();
  jobDispatcherRunning = false;
}
