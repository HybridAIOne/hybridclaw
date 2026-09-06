/**
 * Scheduled-task tool service — the gateway side of the container `cron` tool.
 *
 * A job exists in SQLite before the tool result reaches the model, so the
 * assistant can only confirm a schedule that is actually persisted and quote
 * its real id. Validation here is the trust boundary for container input;
 * schedule semantics (cron parsing, firing) belong to `scheduler.ts`.
 *
 * NOT the admin scheduler API (`gateway-scheduled-task-service.ts`), which
 * edits jobs on behalf of operators rather than the running agent turn.
 */
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { logger } from '../logger.js';
import { getSessionById } from '../memory/db.js';
import { createJob, deleteJob, getJob } from '../memory/jobs.js';
import { resolveSessionIdCompat } from '../memory/sessions.js';
import { rearmScheduler } from '../scheduler/scheduler.js';
import { isRecord } from '../utils/type-guards.js';

export type ScheduledTaskToolActionResult =
  | {
      ok: true;
      action: 'add';
      taskId: number;
      sessionId: string;
      channelId: string;
      cronExpr?: string;
      runAt?: string;
      everyMs?: number;
      prompt: string;
    }
  | { ok: true; action: 'remove'; taskId: number; sessionId: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function runScheduledTaskToolAction(
  body: unknown,
): ScheduledTaskToolActionResult {
  if (!isRecord(body)) {
    throw new GatewayRequestError(400, 'Request body must be a JSON object.');
  }
  const action = readString(body.action);
  if (action !== 'add' && action !== 'remove') {
    throw new GatewayRequestError(
      400,
      'Invalid `action`. Allowed: "add", "remove".',
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
    if (!job || job.session_id !== resolveSessionIdCompat(sessionId)) {
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

  const prompt = readString(body.prompt);
  if (!prompt) throw new GatewayRequestError(400, 'Missing `prompt`.');
  const cronExpr = readString(body.cronExpr);
  const runAt = readString(body.runAt);
  const everyMs =
    typeof body.everyMs === 'number' && Number.isFinite(body.everyMs)
      ? Math.round(body.everyMs)
      : 0;
  const scheduleFields = [cronExpr, runAt, everyMs > 0 ? 'every' : ''].filter(
    Boolean,
  );
  if (scheduleFields.length !== 1) {
    throw new GatewayRequestError(
      400,
      'Provide exactly one of `cronExpr`, `runAt`, or `everyMs`.',
    );
  }
  if (runAt) {
    const runAtMs = Date.parse(runAt);
    if (Number.isNaN(runAtMs)) {
      throw new GatewayRequestError(400, 'Invalid `runAt` timestamp.');
    }
    if (runAtMs <= Date.now()) {
      throw new GatewayRequestError(400, '`runAt` must be in the future.');
    }
  }
  const channelId =
    readString(body.channelId) || readString(session.channel_id);
  if (!channelId) {
    throw new GatewayRequestError(400, 'Missing delivery `channelId`.');
  }

  const taskId = createJob({
    kind: 'scheduled_task',
    sessionId,
    channelId,
    cronExpr,
    prompt,
    runAt: runAt || undefined,
    everyMs: everyMs > 0 ? everyMs : undefined,
  });
  rearmScheduler();
  logger.info(
    { taskId, sessionId, channelId, cronExpr, runAt, everyMs },
    'Cron tool created task',
  );
  return {
    ok: true,
    action: 'add',
    taskId,
    sessionId,
    channelId,
    cronExpr: cronExpr || undefined,
    runAt: runAt || undefined,
    everyMs: everyMs > 0 ? everyMs : undefined,
    prompt,
  };
}
