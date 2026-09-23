/**
 * Scheduled-task tool service — the gateway side of the container `cron` tool.
 *
 * A job exists in SQLite before the tool result reaches the model, so the
 * assistant can only confirm a schedule that is actually persisted and quote
 * its real id. Same-agent web chats may manage each other's tasks; messaging
 * sessions remain isolated. Validation here is the trust boundary for container input;
 * schedule semantics (cron parsing, firing) belong to `scheduler.ts`.
 *
 * NOT the admin scheduler API (`gateway-scheduled-task-service.ts`), which
 * edits jobs on behalf of operators rather than the running agent turn.
 */
import { isValidTimezone } from '../../container/shared/workspace-time.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { logger } from '../logger.js';
import { getSessionById } from '../memory/db.js';
import {
  createJob,
  deleteJob,
  getJob,
  updateScheduledTask,
} from '../memory/jobs.js';
import { rearmScheduler } from '../scheduler/scheduler.js';
import { isRecord } from '../utils/type-guards.js';
import { canManageScheduledTask } from './scheduled-task-access.js';

interface PersistedTaskResult {
  ok: true;
  taskId: number;
  sessionId: string;
  channelId: string;
  cronExpr?: string;
  tz?: string;
  runAt?: string;
  everyMs?: number;
  prompt: string;
}

export type ScheduledTaskToolActionResult =
  | (PersistedTaskResult & { action: 'add' })
  | (PersistedTaskResult & { action: 'update' })
  | { ok: true; action: 'remove'; taskId: number; sessionId: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface ScheduledTaskFields {
  cronExpr: string;
  tz: string;
  runAt: string;
  everyMs: number;
  prompt: string;
  channelId: string;
}

/** Builds the "add"/"update" response, which share every field but `action`. */
function toResult(
  action: 'add' | 'update',
  taskId: number,
  sessionId: string,
  fields: ScheduledTaskFields,
): PersistedTaskResult & { action: 'add' | 'update' } {
  return {
    ok: true,
    action,
    taskId,
    sessionId,
    channelId: fields.channelId,
    cronExpr: fields.cronExpr || undefined,
    tz: fields.tz || undefined,
    runAt: fields.runAt || undefined,
    everyMs: fields.everyMs > 0 ? fields.everyMs : undefined,
    prompt: fields.prompt,
  };
}

/** Shared by "add" (fields read straight from the request) and "update"
 * (fields merged onto the stored job first), so both enforce the same rules. */
function validateScheduledTaskFields(fields: ScheduledTaskFields): void {
  const scheduleFields = [
    fields.cronExpr,
    fields.runAt,
    fields.everyMs > 0 ? 'every' : '',
  ].filter(Boolean);
  if (scheduleFields.length !== 1) {
    throw new GatewayRequestError(
      400,
      'Provide exactly one of `cronExpr`, `runAt`, or `everyMs`.',
    );
  }
  if (fields.tz && !fields.cronExpr) {
    throw new GatewayRequestError(400, '`tz` requires `cronExpr`.');
  }
  if (fields.tz && !isValidTimezone(fields.tz)) {
    throw new GatewayRequestError(400, `Unknown timezone \`${fields.tz}\`.`);
  }
  if (fields.runAt) {
    const runAtMs = Date.parse(fields.runAt);
    if (Number.isNaN(runAtMs)) {
      throw new GatewayRequestError(400, 'Invalid `runAt` timestamp.');
    }
    if (runAtMs <= Date.now()) {
      throw new GatewayRequestError(400, '`runAt` must be in the future.');
    }
  }
  if (!fields.prompt) throw new GatewayRequestError(400, 'Missing `prompt`.');
  if (!fields.channelId) {
    throw new GatewayRequestError(400, 'Missing delivery `channelId`.');
  }
}

export function runScheduledTaskToolAction(
  body: unknown,
): ScheduledTaskToolActionResult {
  if (!isRecord(body)) {
    throw new GatewayRequestError(400, 'Request body must be a JSON object.');
  }
  const action = readString(body.action);
  if (action !== 'add' && action !== 'remove' && action !== 'update') {
    throw new GatewayRequestError(
      400,
      'Invalid `action`. Allowed: "add", "update", "remove".',
    );
  }
  const sessionId = readString(body.sessionId);
  if (!sessionId) throw new GatewayRequestError(400, 'Missing `sessionId`.');
  const session = getSessionById(sessionId);
  if (!session) {
    throw new GatewayRequestError(404, `Unknown session: ${sessionId}`);
  }

  if (action === 'remove') {
    const taskId = Number(body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new GatewayRequestError(400, 'Invalid `taskId`.');
    }
    const job = getJob(taskId, { kind: 'scheduled_task' });
    if (!job || !canManageScheduledTask(job, session)) {
      throw new GatewayRequestError(
        404,
        `Unknown task #${taskId} for this session.`,
      );
    }
    deleteJob(taskId);
    rearmScheduler();
    logger.info({ taskId, sessionId }, 'Cron tool removed task');
    return { ok: true, action: 'remove', taskId, sessionId };
  }

  if (action === 'update') {
    const taskId = Number(body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new GatewayRequestError(400, 'Invalid `taskId`.');
    }
    const job = getJob(taskId, { kind: 'scheduled_task' });
    if (!job || !canManageScheduledTask(job, session)) {
      throw new GatewayRequestError(
        404,
        `Unknown task #${taskId} for this session.`,
      );
    }

    // A patch schedule field (cronExpr/runAt/everyMs) replaces the stored
    // schedule wholesale; everything else defaults to the stored job so an
    // omitted field is a no-op. Giving more than one schedule field at once
    // is caught by validateScheduledTaskFields below, same as "add".
    const cronExprPatch = readString(body.cronExpr);
    const runAtPatch = readString(body.runAt);
    const everyMsPatch =
      typeof body.everyMs === 'number' && Number.isFinite(body.everyMs)
        ? Math.round(body.everyMs)
        : 0;
    const patchHasSchedule =
      Boolean(cronExprPatch) || Boolean(runAtPatch) || everyMsPatch > 0;

    const fields: ScheduledTaskFields = {
      cronExpr: patchHasSchedule ? cronExprPatch : job.cron_expr || '',
      runAt: patchHasSchedule ? runAtPatch : job.run_at || '',
      everyMs: patchHasSchedule ? everyMsPatch : job.every_ms || 0,
      tz: readString(body.tz) || job.tz || '',
      prompt: readString(body.prompt) || job.prompt,
      channelId: readString(body.channelId) || job.channel_id,
    };
    validateScheduledTaskFields(fields);

    updateScheduledTask(taskId, {
      cronExpr: fields.cronExpr || undefined,
      tz: fields.tz || undefined,
      runAt: fields.runAt || undefined,
      everyMs: fields.everyMs > 0 ? fields.everyMs : undefined,
      prompt: fields.prompt,
      channelId: fields.channelId,
    });
    rearmScheduler();
    logger.info({ taskId, sessionId, ...fields }, 'Cron tool updated task');
    return toResult('update', taskId, sessionId, fields);
  }

  const fields: ScheduledTaskFields = {
    cronExpr: readString(body.cronExpr),
    tz: readString(body.tz),
    runAt: readString(body.runAt),
    everyMs:
      typeof body.everyMs === 'number' && Number.isFinite(body.everyMs)
        ? Math.round(body.everyMs)
        : 0,
    prompt: readString(body.prompt),
    channelId: readString(body.channelId) || readString(session.channel_id),
  };
  validateScheduledTaskFields(fields);

  const taskId = createJob({
    kind: 'scheduled_task',
    sessionId,
    channelId: fields.channelId,
    cronExpr: fields.cronExpr,
    tz: fields.tz || undefined,
    prompt: fields.prompt,
    runAt: fields.runAt || undefined,
    everyMs: fields.everyMs > 0 ? fields.everyMs : undefined,
  });
  rearmScheduler();
  logger.info({ taskId, sessionId, ...fields }, 'Cron tool created task');
  return toResult('add', taskId, sessionId, fields);
}
