/**
 * `/schedule` — cron tasks a chat creates, and what their runs answered.
 *
 * A task stays with the chat that created it across that chat's session
 * resets, and a web chat of the same agent may manage it too (the cron tool's
 * rule, `scheduled-task-access.ts`). What a run answered can quote private
 * data, so only the creating chat reads it back. `--json` answers in one line
 * that survives a chat relay, for apps that drive this command. `--alert
 * <kind>` has a run whose reply lists items ring the creator's phones with
 * the first item (`mobile-push.ts`). `--reply-only` keeps each run's prompt
 * and work out of the chat: a run works in a session of its own, and only a
 * reply that says something is posted here, as the agent's message, so an
 * app can let a background check write into the conversation itself.
 *
 * NOT the scheduler (`scheduler.ts`, which fires tasks) and NOT the admin
 * scheduler API, which edits every task on an operator's behalf.
 */
import { CronExpressionParser } from 'cron-parser';
import { isValidTimezone } from '../../container/shared/workspace-time.js';
import { parseIntegerArg, parseLowerArg } from '../command-parsing.js';
import {
  getRecentMessages,
  getSessionById,
  listSessionInstancesForKey,
} from '../memory/db.js';
import { createJob, deleteJob, getJob, setJobEnabled } from '../memory/jobs.js';
import {
  cronPromptHead,
  dbTaskLabel,
  rearmScheduler,
} from '../scheduler/scheduler.js';
import type { ScheduledTask } from '../types/scheduler.js';
import type { Session } from '../types/session.js';
import {
  badCommand,
  infoCommand,
  plainCommand,
} from './gateway-command-results.js';
import { parseTimestamp } from './gateway-time.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import {
  canManageScheduledTask,
  isCreatingChat,
  listManageableScheduledTasks,
} from './scheduled-task-access.js';

const USAGE =
  'Usage: `schedule add [--tz <zone>] [--alert <kind>] [--reply-only] "<cron>" <prompt>` or `schedule add at "<ISO time>" <prompt>` or `schedule add every <ms> <prompt>`, `schedule list`, `schedule results <id> [--limit <n>]`, `schedule remove <id>`, `schedule toggle <id>`. Add `--json` for a machine-readable answer.';
const ALERT_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFAULT_RESULTS = 20;
// 200 runs (engineering choice, 2026-09-30): four days of a half-hourly task.
const MAX_RESULTS = 200;
const STREAM_UNSAFE: Record<string, string> = {
  '\\\\': '\\u005c',
  '\\n': '\\u000a',
  '\\r': '\\u000d',
};

/**
 * One line of JSON that survives a chat relay: relays escape line breaks as
 * the two characters backslash-n and their clients turn every such pair back
 * into a line break, which would corrupt a string holding an escaped one.
 */
export function chatSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /\\[\\nr]/g,
    (pair) => STREAM_UNSAFE[pair] ?? pair,
  );
}

function isoTime(raw: string | null | undefined): string | null {
  return parseTimestamp(raw)?.toISOString() ?? null;
}

function taskJson(task: ScheduledTask) {
  return {
    id: task.id,
    enabled: Boolean(task.enabled),
    cron: task.cron_expr || null,
    tz: task.tz || null,
    run_at: task.run_at,
    every_ms: task.every_ms,
    prompt: task.prompt,
    last_run: isoTime(task.last_run),
    last_status: task.last_status,
    last_error: task.last_error,
    consecutive_errors: task.consecutive_errors,
    alert: task.alert ?? null,
    reply_only: task.reply_only ?? false,
  };
}

function scheduleLabel(task: ScheduledTask): string {
  if (task.run_at) return `at ${task.run_at}`;
  if (task.every_ms) return `every ${task.every_ms}ms`;
  if (task.cron_expr) {
    return `cron ${task.cron_expr}${task.tz ? ` (${task.tz})` : ''}`;
  }
  return 'unspecified';
}

/**
 * Flags after the subcommand. For `add` they must come before the schedule,
 * so a prompt may contain anything; the rest keeps its order.
 */
function readOptions(
  args: string[],
  leadingOnly: boolean,
): {
  json: boolean;
  tz: string;
  limit: string;
  alert: string;
  replyOnly: boolean;
  rest: string[];
  error: string | null;
} {
  const rest: string[] = [];
  let json = false;
  let replyOnly = false;
  let tz = '';
  let limit = '';
  let alert = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (leadingOnly && rest.length > 0) {
      rest.push(arg);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--reply-only') {
      replyOnly = true;
    } else if (arg === '--tz' || arg === '--limit' || arg === '--alert') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        return {
          json,
          tz,
          limit,
          alert,
          replyOnly,
          rest,
          error: `\`${arg}\` needs a value.`,
        };
      }
      if (arg === '--tz') tz = value;
      else if (arg === '--alert') alert = value;
      else limit = value;
      index += 1;
    } else {
      rest.push(arg);
    }
  }
  return { json, tz, limit, alert, replyOnly, rest, error: null };
}

function findManageable(
  taskId: number | null,
  session: Session,
): ScheduledTask | null {
  if (!taskId) return null;
  const task = getJob(taskId, { kind: 'scheduled_task' });
  return task && canManageScheduledTask(task, session) ? task : null;
}

function add(
  spec: string,
  options: { tz: string; json: boolean; alert: string; replyOnly: boolean },
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  const at = spec.match(/^at\s+"([^"]+)"\s+(.+)$/is);
  const every = spec.match(/^every\s+(\d+)\s+(.+)$/is);
  const cron = spec.match(/^"([^"]+)"\s+(.+)$/s);
  if (options.tz && !cron) {
    return badCommand('Usage', '`--tz` applies to a cron schedule only.');
  }
  if (options.alert && !ALERT_KIND.test(options.alert)) {
    return badCommand(
      'Invalid Alert',
      '`--alert` takes a short lowercase kind, such as `proactive`.',
    );
  }
  const alert = options.alert || undefined;
  const replyOnly = options.replyOnly || undefined;
  if (options.tz && !isValidTimezone(options.tz)) {
    return badCommand(
      'Invalid Time Zone',
      `\`${options.tz}\` is not a time zone.`,
    );
  }
  let taskId: number;
  if (at) {
    const runAt = new Date(at[1]);
    if (Number.isNaN(runAt.getTime())) {
      return badCommand(
        'Invalid Time',
        `\`${at[1]}\` is not a valid ISO timestamp.`,
      );
    }
    taskId = createJob({
      kind: 'scheduled_task',
      ownerUserId: req.userId ?? undefined,
      sessionId: session.id,
      channelId: req.channelId,
      cronExpr: '',
      prompt: at[2],
      runAt: runAt.toISOString(),
      alert,
      replyOnly,
    });
  } else if (every) {
    const everyMs = Number.parseInt(every[1], 10);
    if (!Number.isFinite(everyMs) || everyMs < 10_000) {
      return badCommand(
        'Invalid Interval',
        'Interval must be at least 10000ms.',
      );
    }
    taskId = createJob({
      kind: 'scheduled_task',
      ownerUserId: req.userId ?? undefined,
      sessionId: session.id,
      channelId: req.channelId,
      cronExpr: '',
      prompt: every[2],
      everyMs,
      alert,
      replyOnly,
    });
  } else if (cron) {
    try {
      CronExpressionParser.parse(cron[1], options.tz ? { tz: options.tz } : {});
    } catch {
      return badCommand(
        'Invalid Cron',
        `\`${cron[1]}\` is not a valid cron expression.`,
      );
    }
    taskId = createJob({
      kind: 'scheduled_task',
      ownerUserId: req.userId ?? undefined,
      sessionId: session.id,
      channelId: req.channelId,
      cronExpr: cron[1],
      tz: options.tz || undefined,
      prompt: cron[2],
      alert,
      replyOnly,
    });
  } else {
    return badCommand('Usage', USAGE);
  }
  rearmScheduler();
  const task = getJob(taskId, { kind: 'scheduled_task' });
  if (options.json && task) {
    return plainCommand(chatSafeJson({ version: 1, task: taskJson(task) }));
  }
  return plainCommand(
    `Task #${taskId} created: ${task ? scheduleLabel(task) : 'scheduled'} — ${task?.prompt ?? ''}`,
  );
}

// Sessions of one chat kept for results: a reset leaves earlier runs' replies
// in the session they were stored in, and the task moves on to the next.
const MAX_CHAT_SESSIONS = 50;

/**
 * Replies the task's runs stored, newest last: each directly follows the run's
 * prompt, asked by the scheduler. A `--reply-only` task stores no prompt here,
 * so its replies are the messages it posted. Read across the chat's sessions,
 * because a reset moves the task to a new session but leaves earlier replies
 * behind.
 */
function runReplies(task: ScheduledTask, limit: number) {
  // A run stores its prompt as the scheduler wrapped it, with the time of the run.
  const head = cronPromptHead(dbTaskLabel(task.id), task.prompt);
  const askedByTask = (content: string) =>
    content === task.prompt || content.startsWith(head);
  const posted = `schedule:${task.id}`;
  const key = getSessionById(task.session_id)?.session_key;
  const sessionIds = key
    ? listSessionInstancesForKey(key, { limit: MAX_CHAT_SESSIONS }).map(
        (session) => session.id,
      )
    : [task.session_id];
  const replies: Array<{
    id: number;
    created_at: string | null;
    text: string;
  }> = [];
  for (const sessionId of sessionIds) {
    // Enough rows for `limit` runs even when the chat talks in between.
    const messages = getRecentMessages(sessionId, limit * 6 + 20);
    for (let index = 0; index < messages.length; index += 1) {
      const reply = messages[index];
      const asked = messages[index - 1];
      const answered = task.reply_only
        ? reply.source === posted
        : asked?.role === 'user' &&
          asked.user_id === 'scheduler' &&
          askedByTask(asked.content);
      if (reply.role === 'assistant' && answered) {
        replies.push({
          id: reply.id,
          created_at: isoTime(reply.created_at),
          text: reply.content,
        });
      }
    }
  }
  return replies.sort((left, right) => left.id - right.id).slice(-limit);
}

function results(
  task: ScheduledTask,
  options: { limit: string; json: boolean },
): GatewayCommandResult {
  const limit = options.limit
    ? Number.parseInt(options.limit, 10)
    : DEFAULT_RESULTS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    return badCommand(
      'Invalid Limit',
      `\`--limit\` takes a number from 1 to ${MAX_RESULTS}.`,
    );
  }
  const replies = runReplies(task, limit);
  if (options.json) {
    return plainCommand(
      chatSafeJson({ version: 1, task: taskJson(task), results: replies }),
    );
  }
  if (replies.length === 0) {
    return plainCommand(`Task #${task.id} has no stored results yet.`);
  }
  return infoCommand(
    `Results of Task #${task.id}`,
    replies
      .map(
        (reply) => `**${reply.created_at ?? 'unknown time'}**\n${reply.text}`,
      )
      .join('\n\n'),
  );
}

export function handleScheduleCommand(
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  const sub = parseLowerArg(req.args, 1);
  const options = readOptions(req.args.slice(2).map(String), sub === 'add');
  if (options.error) return badCommand('Usage', options.error);
  const notFound = (taskId: number | null) =>
    badCommand(
      'Not Found',
      taskId
        ? `Task #${taskId} was not found for this chat.`
        : 'Give a task id.',
    );

  if (sub === 'add') {
    return add(options.rest.join(' ').trim(), options, req, session);
  }

  if (sub === 'list') {
    const { tasks, hiddenCount } = listManageableScheduledTasks(session);
    if (options.json) {
      return plainCommand(
        chatSafeJson({
          version: 1,
          tasks: tasks.map(taskJson),
          hidden: hiddenCount,
        }),
      );
    }
    const hidden =
      hiddenCount > 0
        ? `\n${hiddenCount} more belong to chats this one cannot manage.`
        : '';
    if (tasks.length === 0) return plainCommand(`No scheduled tasks.${hidden}`);
    const list = tasks
      .map((task) => {
        const errors =
          task.consecutive_errors > 0
            ? ` · errors ${task.consecutive_errors}`
            : '';
        const lastError = task.last_error
          ? ` · last error: ${task.last_error}`
          : '';
        return `#${task.id} ${task.enabled ? 'enabled' : 'disabled'} (${scheduleLabel(task)}) [${task.last_status || 'n/a'}${errors}] — ${task.prompt.slice(0, 60)}${lastError}`;
      })
      .join('\n');
    return infoCommand('Scheduled Tasks', `${list}${hidden}`);
  }

  const taskId = parseIntegerArg(options.rest, 0);

  if (sub === 'results') {
    const task = taskId ? getJob(taskId, { kind: 'scheduled_task' }) : null;
    if (!task || !isCreatingChat(task, session)) return notFound(taskId);
    return results(task, options);
  }

  if (sub === 'remove') {
    const task = findManageable(taskId, session);
    if (!task) return notFound(taskId);
    deleteJob(task.id);
    rearmScheduler();
    return options.json
      ? plainCommand(chatSafeJson({ version: 1, removed: task.id }))
      : plainCommand(`Task #${task.id} removed.`);
  }

  if (sub === 'toggle') {
    const task = findManageable(taskId, session);
    if (!task) return notFound(taskId);
    setJobEnabled(task.id, !task.enabled);
    rearmScheduler();
    const toggled = getJob(task.id, { kind: 'scheduled_task' });
    return options.json && toggled
      ? plainCommand(chatSafeJson({ version: 1, task: taskJson(toggled) }))
      : plainCommand(
          `Task #${task.id} ${task.enabled ? 'disabled' : 'enabled'}.`,
        );
  }

  return badCommand('Usage', USAGE);
}
