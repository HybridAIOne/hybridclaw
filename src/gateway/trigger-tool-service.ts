/**
 * Trigger tool service — the gateway side of the container `trigger` tool
 * (`POST /api/trigger`). A trigger exists in SQLite before the tool result
 * reaches the model, so the assistant only confirms a saved trigger and
 * quotes its real id and web address. Access follows scheduled tasks
 * (`scheduled-task-access.ts`); what triggers do lives in `event-triggers.ts`.
 */
import { getRuntimeConfig } from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { logger } from '../logger.js';
import { getSessionById } from '../memory/db.js';
import { deleteJob, getJob } from '../memory/jobs.js';
import {
  createTrigger,
  describeTrigger,
  forgetTrigger,
  triggerJson,
} from '../scheduler/event-triggers.js';
import { rearmScheduler } from '../scheduler/scheduler.js';
import { currentTurnUser } from '../session/turn-user.js';
import type { ScheduledTask } from '../types/scheduler.js';
import { isRecord } from '../utils/type-guards.js';
import { resolvePublicGatewayBaseUrl } from './gateway-url-utils.js';
import {
  canManageScheduledTask,
  listManageableScheduledTasks,
} from './scheduled-task-access.js';

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function describe(task: ScheduledTask): string {
  if (!task.trigger) return '';
  const json = triggerJson(task.trigger, publicBaseUrl());
  const look = task.cron_expr
    ? `, and looks on cron ${task.cron_expr}${task.tz ? ` (${task.tz})` : ''}`
    : '';
  const address = json.url
    ? `. Web address: ${json.url}`
    : json.path
      ? `. Web address path: ${json.path} (this gateway has no public address; set deployment.public_url or ops.gatewayBaseUrl)`
      : '';
  return `runs ${describeTrigger(task.trigger)}${look}${address}`;
}

export function runTriggerToolAction(body: unknown): {
  ok: true;
  result: string;
} {
  if (!isRecord(body)) {
    throw new GatewayRequestError(400, 'Request body must be a JSON object.');
  }
  const action = readString(body.action);
  const sessionId = readString(body.sessionId);
  const session = sessionId ? getSessionById(sessionId) : undefined;
  if (!session) throw new GatewayRequestError(404, 'Unknown session.');

  if (action === 'list') {
    const triggers = listManageableScheduledTasks(session).tasks.filter(
      (task) => task.trigger,
    );
    return {
      ok: true,
      result:
        triggers.length === 0
          ? 'No triggers.'
          : triggers
              .map(
                (task) =>
                  `#${task.id} [${task.enabled ? 'enabled' : 'paused'}] ${task.title ? `"${task.title}" ` : ''}${describe(task)} — ${task.prompt}`,
              )
              .join('\n'),
    };
  }

  if (action === 'remove') {
    const taskId = Number(body.taskId);
    const task = Number.isInteger(taskId)
      ? getJob(taskId, { kind: 'scheduled_task' })
      : null;
    if (!task?.trigger || !canManageScheduledTask(task, session)) {
      throw new GatewayRequestError(404, `Unknown trigger #${body.taskId}.`);
    }
    deleteJob(task.id);
    forgetTrigger(task.id);
    rearmScheduler();
    return { ok: true, result: `Removed trigger #${task.id}.` };
  }

  if (action !== 'add') {
    throw new GatewayRequestError(
      400,
      'Invalid `action`. Allowed: "add", "list", "remove".',
    );
  }
  let task: ScheduledTask;
  try {
    task = createTrigger({
      sessionId: session.id,
      channelId: readString(body.channelId) || session.channel_id,
      ownerUserId: currentTurnUser(session.id)?.userId,
      source: readString(body.on),
      prompt: readString(body.prompt),
      title: readString(body.title),
      channel: readString(body.channel),
      contains: readString(body.contains),
      cronExpr: readString(body.cron),
      tz: readString(body.tz),
    });
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
  logger.info(
    { taskId: task.id, sessionId, source: task.trigger?.source },
    'Trigger tool created trigger',
  );
  return {
    ok: true,
    result: `Saved trigger #${task.id}: ${describe(task)}.`,
  };
}

/** Where webhook triggers are reached from outside, if this gateway is public. */
function publicBaseUrl(): string | null {
  return resolvePublicGatewayBaseUrl(getRuntimeConfig());
}
