import { logger } from '../logger.js';
import {
  createAgentJob,
  createTask,
  deleteTask,
  moveAgentJob,
  setAgentJobArchived,
  updateAgentJob,
} from '../memory/db.js';
import { rearmScheduler } from '../scheduler/scheduler.js';
import type {
  AgentJobActorKind,
  ContainerOutput,
  DelegationSideEffect,
} from '../types.js';

interface SideEffectHandlers {
  onDelegation?: (effect: DelegationSideEffect) => void;
  actorKind?: AgentJobActorKind;
  actorId?: string | null;
}

export function processSideEffects(
  output: ContainerOutput,
  sessionId: string,
  channelId: string,
  handlers: SideEffectHandlers = {},
): void {
  const schedules = output.sideEffects?.schedules;
  const delegations = output.sideEffects?.delegations || [];
  const jobs = output.sideEffects?.jobs || [];
  if (
    (!schedules || schedules.length === 0) &&
    delegations.length === 0 &&
    jobs.length === 0
  )
    return;

  let changed = false;
  const actorKind = handlers.actorKind || 'agent';
  const actorId = handlers.actorId || sessionId;

  if (schedules && schedules.length > 0) {
    for (const effect of schedules) {
      try {
        if (effect.action === 'add') {
          const taskId = createTask(
            sessionId,
            channelId,
            effect.cronExpr || '',
            effect.prompt,
            effect.runAt,
            effect.everyMs,
          );
          logger.info(
            {
              taskId,
              sessionId,
              channelId,
              cronExpr: effect.cronExpr,
              runAt: effect.runAt,
              everyMs: effect.everyMs,
            },
            'Side-effect: created task',
          );
          changed = true;
        } else if (effect.action === 'remove') {
          deleteTask(effect.taskId);
          logger.info(
            { taskId: effect.taskId, sessionId },
            'Side-effect: removed task',
          );
          changed = true;
        }
      } catch (err) {
        logger.error({ effect, err }, 'Failed to process side-effect');
      }
    }
  }

  if (delegations.length > 0) {
    for (const effect of delegations) {
      try {
        if (handlers.onDelegation) {
          handlers.onDelegation(effect);
        } else {
          logger.info(
            {
              sessionId,
              channelId,
              mode:
                effect.mode ||
                (effect.chain?.length
                  ? 'chain'
                  : effect.tasks?.length
                    ? 'parallel'
                    : 'single'),
              prompt: effect.prompt,
              label: effect.label,
              tasks: effect.tasks?.length,
              chain: effect.chain?.length,
            },
            'Side-effect: delegation ignored (no handler)',
          );
        }
      } catch (err) {
        logger.error(
          { effect, err },
          'Failed to process delegation side-effect',
        );
      }
    }
  }

  if (jobs.length > 0) {
    for (const effect of jobs) {
      try {
        if (effect.action === 'create') {
          const job = createAgentJob({
            title: effect.title,
            details: effect.details,
            status: effect.status,
            priority: effect.priority,
            assigneeAgentId: effect.assigneeAgentId,
            createdByKind: actorKind,
            createdById: actorId,
            sourceSessionId: effect.sourceSessionId || sessionId,
            linkedTaskId: effect.linkedTaskId,
          });
          logger.info(
            {
              jobId: job.id,
              sessionId,
              channelId,
              actorKind,
              actorId,
              status: job.status,
            },
            'Side-effect: created job',
          );
          continue;
        }

        if (effect.action === 'move') {
          const job = moveAgentJob({
            id: effect.jobId,
            status: effect.status,
            position: effect.position,
            actorKind,
            actorId,
          });
          logger.info(
            {
              jobId: job.id,
              sessionId,
              channelId,
              actorKind,
              actorId,
              status: job.status,
              lanePosition: job.lane_position,
            },
            'Side-effect: moved job',
          );
          continue;
        }

        if (effect.action === 'update') {
          const job = updateAgentJob({
            id: effect.jobId,
            title: effect.title,
            details: effect.details,
            priority: effect.priority,
            assigneeAgentId: effect.assigneeAgentId,
            sourceSessionId: effect.sourceSessionId,
            linkedTaskId: effect.linkedTaskId,
            actorKind,
            actorId,
          });
          logger.info(
            { jobId: job.id, sessionId, channelId, actorKind, actorId },
            'Side-effect: updated job',
          );
          continue;
        }

        if (effect.action === 'complete') {
          const job = moveAgentJob({
            id: effect.jobId,
            status: 'done',
            actorKind,
            actorId,
          });
          logger.info(
            { jobId: job.id, sessionId, channelId, actorKind, actorId },
            'Side-effect: completed job',
          );
          continue;
        }

        const job = setAgentJobArchived({
          id: effect.jobId,
          archived: effect.action === 'archive',
          actorKind,
          actorId,
        });
        logger.info(
          {
            jobId: job.id,
            sessionId,
            channelId,
            actorKind,
            actorId,
            archived: Boolean(job.archived_at),
          },
          effect.action === 'archive'
            ? 'Side-effect: archived job'
            : 'Side-effect: restored job',
        );
      } catch (err) {
        logger.error({ effect, err }, 'Failed to process job side-effect');
      }
    }
  }

  // Re-arm scheduler so new tasks are picked up immediately
  if (changed) rearmScheduler();
}
