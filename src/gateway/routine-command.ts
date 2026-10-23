/**
 * Managed daily routines use a bundled skill and one owner/agent identity.
 * Schedule settings live only in jobs; callers cannot supply prompts or owners.
 * This command configures work, not its execution or delivery.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidTimezone } from '../../container/shared/workspace-time.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { withMemoryDatabase } from '../memory/database.js';
import {
  createJob,
  getAllJobs,
  getJob,
  setJobEnabled,
  updateScheduledTask,
} from '../memory/jobs.js';
import {
  getScheduledTaskNextRunAt,
  rearmScheduler,
} from '../scheduler/scheduler.js';
import { taskRevision } from '../scheduler/task-revision.js';
import { listTaskRuns } from '../scheduler/task-runs.js';
import type { ScheduledTask } from '../types/scheduler.js';
import type { Session } from '../types/session.js';
import { isRecord } from '../utils/type-guards.js';
import { badCommand, plainCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { canManageScheduledTask } from './scheduled-task-access.js';

function templates(): Map<string, { title: string; prompt: string }> {
  const root = resolveInstallPath('skills');
  const found = new Map<string, { title: string; prompt: string }>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name))
      continue;
    const file = path.join(root, entry.name, 'routine.json');
    if (!fs.existsSync(file)) continue;
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      isRecord(data) &&
      typeof data.title === 'string' &&
      typeof data.prompt === 'string'
    )
      found.set(entry.name, { title: data.title, prompt: data.prompt });
  }
  return found;
}
export function routineCapabilities(): { version: number; keys: string[] } {
  return { version: 1, keys: [...templates().keys()] };
}

export function handleRoutineCommand(
  req: GatewayCommandRequest,
  session: Session,
  taskJson: (task: ScheduledTask) => unknown,
  json: (value: unknown) => string,
): GatewayCommandResult {
  const values = req.args.slice(2).filter((arg) => arg !== '--json');
  const key = values[0];
  const testing = values[1] === 'test';
  const template = templates().get(key);
  const owner = req.userId?.trim();
  if (
    !template ||
    !owner ||
    owner.length > 200 ||
    !session.agent_id ||
    session.channel_id !== 'web' ||
    session.scope
  )
    return badCommand(
      'Routine unavailable',
      'Use an authenticated main chat for this routine.',
    );
  // The gateway has already bound userId to the credential. Never accept scope in JSON.
  const scope = createHash('sha256')
    // lgtm[js/insufficient-password-hash] Stable composite identity lookup only;
    // this is never a password/token verifier or an authentication decision.
    .update(JSON.stringify([owner, session.agent_id]))
    .digest('hex');
  const find = () =>
    getAllJobs({ kind: 'scheduled_task' }).find(
      (task) => task.managed_scope === scope && task.managed_key === key,
    );
  try {
    const task = withMemoryDatabase((db) =>
      db
        .transaction(() => {
          let task = find();
          if (task && !canManageScheduledTask(task, session, owner))
            throw new Error('This chat cannot manage the routine.');
          if (values.length === 1) return task;
          if (testing) {
            if (
              values.length !== 3 ||
              !task ||
              values[2] !== taskRevision(task)
            )
              throw new Error('Reopen the routine before testing.');
            return getJob(
              createJob({
                kind: 'scheduled_task',
                sessionId: task.session_id,
                channelId: task.channel_id,
                ownerUserId: owner,
                cronExpr: '',
                runAt: new Date().toISOString(),
                replyOnly: true,
                title: `${template.title} (test)`,
                prompt: `This is a manual test. Label the reply as a test. ${template.prompt}`,
              }),
              { kind: 'scheduled_task' },
            )!;
          }
          if (values.length !== 2 || !/^[A-Za-z0-9_-]{1,4096}$/.test(values[1]))
            throw new Error('Invalid routine settings.');
          const data: unknown = JSON.parse(
            Buffer.from(values[1], 'base64url').toString('utf8'),
          );
          if (
            !isRecord(data) ||
            Object.keys(data).some(
              (field) =>
                ![
                  'revision',
                  'hour',
                  'minute',
                  'weekdays',
                  'tz',
                  'enabled',
                ].includes(field),
            )
          )
            throw new Error('Invalid routine settings.');
          const { hour, minute, weekdays, tz, enabled, revision } = data;
          if (
            typeof hour !== 'number' ||
            !Number.isInteger(hour) ||
            hour < 0 ||
            hour > 23 ||
            typeof minute !== 'number' ||
            !Number.isInteger(minute) ||
            minute < 0 ||
            minute > 59 ||
            typeof weekdays !== 'boolean' ||
            typeof enabled !== 'boolean' ||
            typeof tz !== 'string' ||
            !isValidTimezone(tz)
          )
            throw new Error('Choose a valid time and time zone.');
          const cron = `${minute} ${hour} * * ${weekdays ? '1-5' : '*'}`;
          // A lost acknowledgement is safe to retry, including the initial creation.
          if (
            task?.cron_expr === cron &&
            task.tz === tz &&
            Boolean(task.enabled) === enabled
          )
            return task;
          if (revision !== (task ? taskRevision(task) : null))
            throw new Error('The routine changed. Reopen it before saving.');
          if (!task) {
            if (!session.session_key.startsWith('main-'))
              throw new Error('Create this routine in your main chat.');
            const id = createJob({
              kind: 'scheduled_task',
              sessionId: session.id,
              channelId: 'web',
              ownerUserId: owner,
              managedKey: key,
              managedScope: scope,
              cronExpr: cron,
              tz,
              title: template.title,
              prompt: template.prompt,
              replyOnly: true,
            });
            task = getJob(id, { kind: 'scheduled_task' })!;
          } else {
            updateScheduledTask(task.id, {
              cronExpr: cron,
              tz,
              prompt: template.prompt,
              title: template.title,
              channelId: task.channel_id,
            });
          }
          // Resuming waits for the next slot rather than catching up while consent was off.
          if (!task.enabled && enabled)
            db.prepare('UPDATE jobs SET last_run = ? WHERE id = ?').run(
              new Date().toISOString(),
              `task:${task.id}`,
            );
          setJobEnabled(task.id, enabled);
          return getJob(task.id, { kind: 'scheduled_task' })!;
        })
        .immediate(),
    );
    rearmScheduler();
    if (testing)
      return plainCommand(json({ version: 1, key, test_task_id: task?.id }));
    const fields = task?.cron_expr.split(' ');
    return plainCommand(
      json({
        version: 1,
        key,
        task: task ? taskJson(task) : null,
        settings: {
          hour: Number(fields?.[1] ?? 8),
          minute: Number(fields?.[0] ?? 0),
          weekdays: fields?.[4] === '1-5',
          tz: task?.tz || 'UTC',
          enabled: Boolean(task?.enabled),
        },
        next_run: task?.enabled ? getScheduledTaskNextRunAt(task) : null,
        runs: task ? listTaskRuns(task.id, 50) : [],
      }),
    );
  } catch (error) {
    return badCommand(
      'Routine not saved',
      error instanceof Error ? error.message : 'Could not save the routine.',
    );
  }
}
