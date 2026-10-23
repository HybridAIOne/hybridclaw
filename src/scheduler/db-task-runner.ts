/**
 * Executes one stored task at a time, retaining the scheduler's run history.
 * Managed editions are claimed durably; a retry delivers saved output only.
 * This module never chooses a routine's schedule or policy.
 */
import { logger } from '../logger.js';
import {
  deleteJob,
  getJob,
  markJobFailure,
  markJobRunStarted,
  markJobSuccess,
} from '../memory/jobs.js';
import { isTodoReminderSettled } from '../todos/todo-store.js';
import type { ScheduledTask } from '../types/scheduler.js';
import { isConnectorEventCurrent } from './connector-events.js';
import { isTriggerRunCurrent, triggerRunPrompt } from './event-triggers.js';
import {
  claimRoutineEdition,
  deliveredEdition,
  pendingEdition,
  resumeEdition,
} from './routine-editions.js';
import {
  dbTaskLabel,
  type SchedulerDispatchRequest,
  wrapCronPrompt,
} from './scheduler.js';
import { finishTaskRun, noteTaskRun, startTaskRun } from './task-runs.js';

const MAX_CONSECUTIVE_FAILURES = 5;
const active = new Set<number>();
async function dispatchDbTask(
  task: ScheduledTask,
  runner: (request: SchedulerDispatchRequest) => Promise<void>,
  taskRunId?: number,
): Promise<void> {
  // A reminder of a todo that is already done has nothing to say.
  if (
    isTodoReminderSettled(task.id) ||
    !isConnectorEventCurrent(task) ||
    !isTriggerRunCurrent(task)
  ) {
    noteTaskRun(taskRunId, { skipped: true });
    return;
  }
  // A trigger shows when it last ran, whichever event ran it.
  if (task.trigger_event && task.event_parent_id)
    markJobRunStarted(task.event_parent_id);
  const prompt = wrapCronPrompt(
    dbTaskLabel(task.id),
    task.trigger || task.trigger_event ? triggerRunPrompt(task) : task.prompt,
    task.tz || undefined,
    task.channel_id,
  );
  await runner({
    source: 'scheduled-task',
    ...(task.managed_key && task.managed_scope
      ? { routine: { key: task.managed_key, scope: task.managed_scope } }
      : {}),
    taskId: task.id,
    ...(task.event_parent_id
      ? { resultSourceTaskId: task.event_parent_id }
      : {}),
    ...(task.owner_user_id
      ? {
          taskOwner: { userId: task.owner_user_id, sessionId: task.session_id },
        }
      : {}),
    sessionId: task.session_id,
    channelId: task.channel_id,
    prompt,
    actionKind: 'agent_turn',
    delivery: {
      kind: 'channel',
      channelId: task.channel_id,
    },
    ...(task.reply_only ? { replyOnly: true } : {}),
    ...(taskRunId ? { taskRunId } : {}),
  });
}

const DB_TASK_FAILED = {
  'One-shot': 'One-shot task failed (task preserved)',
  Interval: 'Interval task failed',
  Cron: 'Cron task failed',
} as const;

/** Run history must never stop or fail a run. */
function recordRun<T>(task: ScheduledTask, write: () => T): T | undefined {
  try {
    return write();
  } catch (err) {
    logger.warn({ taskId: task.id, err }, 'Task run history not recorded');
    return undefined;
  }
}

/** Fires a stored task for the time it was due; a one-shot goes once it ran. */
export function fireDbTask(
  task: ScheduledTask,
  dueMs: number,
  kind: keyof typeof DB_TASK_FAILED,
  details: Record<string, unknown>,
  runner: (request: SchedulerDispatchRequest) => Promise<void>,
): void {
  if (active.has(task.id)) return;
  logger.info(
    { taskId: task.id, ...details, prompt: task.prompt },
    `${kind} task firing`,
  );
  markJobRunStarted(task.id);
  const run = task.managed_key
    ? (pendingEdition(task) ?? claimRoutineEdition(task, dueMs))
    : recordRun(task, () => startTaskRun(task, dueMs));
  if (run === null) return;
  if (run && task.managed_key) resumeEdition(run);
  active.add(task.id);
  dispatchDbTask(task, runner, run)
    .then(() => {
      deliveredEdition(run);
      markJobSuccess(task.id);
      if (run) recordRun(task, () => finishTaskRun(task, run));
      if (task.run_at) deleteJob(task.id);
    })
    .catch((err) => {
      const current = task.managed_key
        ? getJob(task.id, { kind: 'scheduled_task' })
        : null;
      const stopped =
        task.managed_key &&
        (!current?.enabled ||
          current.managed_scope !== task.managed_scope ||
          current.managed_key !== task.managed_key);
      const failure = stopped
        ? { disabled: false, consecutiveErrors: 0 }
        : markJobFailure(task.id, MAX_CONSECUTIVE_FAILURES, err);
      if (run)
        recordRun(task, () =>
          finishTaskRun(task, run, {
            error: err,
            ...(failure.disabled
              ? { pausedAfter: failure.consecutiveErrors }
              : {}),
          }),
        );
      logger.error({ taskId: task.id, err }, DB_TASK_FAILED[kind]);
      if (failure.disabled) {
        logger.warn(
          { taskId: task.id, consecutiveErrors: failure.consecutiveErrors },
          'Scheduled task auto-disabled after repeated failures',
        );
      }
    })
    .finally(() => active.delete(task.id));
}
