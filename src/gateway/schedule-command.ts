/**
 * `/schedule` — cron tasks a chat creates, and what their runs answered.
 *
 * A task stays with the chat that created it across that chat's session
 * resets, and a web chat of the same agent may manage it too (the cron tool's
 * rule, `scheduled-task-access.ts`). What a run answered can quote private
 * data, so only the creating chat and the main chat a web task replies in
 * (`web-scheduled-delivery.ts`) read it back. `--json` answers in one line
 * that survives a chat relay, for apps that drive this command. `--alert
 * <kind>` has a run whose reply lists items ring the creator's phones with
 * the first item (`mobile-push.ts`). `--reply-only` keeps each run's prompt
 * and work out of the chat: a run works in a session of its own, and only a
 * reply that says something is posted here, as the agent's message, so an
 * app can let a background check write into the conversation itself.
 *
 * `runs` lists when each run was due and how it ended, missed due times
 * included (`task-runs.ts`); it is read like `results`.
 *
 * `update --json` validates a complete revision-bound editor payload before
 * writing. It preserves creation and delivery metadata; model, effort and
 * fresh-session options apply only to that task’s executions.
 *
 * NOT the scheduler (`scheduler.ts`, which fires tasks) and NOT the admin
 * scheduler API, which edits every task on an operator's behalf.
 */
import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import {
  getSupportedReasoningEfforts,
  isReasoningEffort,
} from '../../container/shared/reasoning-effort.js';
import { isValidTimezone } from '../../container/shared/workspace-time.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { parseIntegerArg, parseLowerArg } from '../command-parsing.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  getRecentMessages,
  getSessionById,
  listSessionInstancesForKey,
} from '../memory/db.js';
import {
  createJob,
  deleteJob,
  getJob,
  setJobEnabled,
  updateScheduledTask,
} from '../memory/jobs.js';
import { resolveModelProvider } from '../providers/factory.js';
import { getAvailableModelList } from '../providers/model-catalog.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import {
  createTrigger,
  describeTrigger,
  forgetTrigger,
  triggerJson,
  triggerPath,
} from '../scheduler/event-triggers.js';
import {
  cronPromptHead,
  dbTaskLabel,
  rearmScheduler,
} from '../scheduler/scheduler.js';
import {
  listTaskRuns,
  MAX_TASK_RUNS,
  taskRunsSummary,
} from '../scheduler/task-runs.js';
import type { ScheduledTask } from '../types/scheduler.js';
import type { Session } from '../types/session.js';
import { isRecord } from '../utils/type-guards.js';
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
import { resolvePublicGatewayBaseUrl } from './gateway-url-utils.js';
import {
  canManageScheduledTask,
  canReadScheduledTaskResults,
  listManageableScheduledTasks,
} from './scheduled-task-access.js';
import { mainChatForWebTask } from './web-scheduled-delivery.js';

const USAGE =
  'Usage: `schedule add [--tz <zone>] [--alert <kind>] [--reply-only] "<cron>" <prompt>` or `schedule add at "<ISO time>" <prompt>` or `schedule add every <ms> <prompt>` or `schedule add --on mail|slack|webhook [--channel <slack channel>] [--contains <text>] [--title <title>] ["<cron>"] <prompt>`, `schedule list`, `schedule results <id> [--limit <n>]`, `schedule runs <id> [--limit <n>]`, `schedule remove <id>`, `schedule toggle <id>`, `schedule update --json <id> <base64url-JSON>`. Add `--json` for a machine-readable answer.';
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

function taskRevision(task: ScheduledTask): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        task.prompt,
        task.cron_expr,
        task.tz,
        task.run_at,
        task.every_ms,
        task.enabled,
        task.title ?? null,
        task.model ?? null,
        task.effort ?? null,
        task.fresh_session ?? false,
        task.session_id,
        task.channel_id,
        task.reply_only ?? false,
        task.alert ?? null,
        task.trigger ?? null,
      ]),
    )
    .digest('hex');
}

function taskJson(task: ScheduledTask) {
  return {
    revision: taskRevision(task),
    title: task.title ?? null,
    model: task.model ?? null,
    effort: task.effort ?? null,
    fresh_session: task.fresh_session ?? false,
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
    trigger: task.trigger ? triggerJson(task.trigger, publicBaseUrl()) : null,
    runs: taskRunsSummary(task.id),
  };
}

function scheduleLabel(task: ScheduledTask): string {
  if (task.trigger) {
    const path = triggerPath(task.trigger);
    const look = task.cron_expr ? `, and on cron ${task.cron_expr}` : '';
    return `${describeTrigger(task.trigger)}${look}${path ? ` (${triggerJson(task.trigger, publicBaseUrl()).url ?? path})` : ''}`;
  }
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
  on: string;
  channel: string;
  contains: string;
  title: string;
  rest: string[];
  error: string | null;
} {
  const rest: string[] = [];
  let json = false;
  let replyOnly = false;
  let tz = '';
  let limit = '';
  let alert = '';
  const named: Record<string, string> = {
    '--on': '',
    '--channel': '',
    '--contains': '',
    '--title': '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (leadingOnly && rest.length > 0) {
      rest.push(arg);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--reply-only') {
      replyOnly = true;
    } else if (
      arg === '--tz' ||
      arg === '--limit' ||
      arg === '--alert' ||
      arg in named
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        return {
          json,
          tz,
          limit,
          alert,
          replyOnly,
          ...namedOptions(named),
          rest,
          error: `\`${arg}\` needs a value.`,
        };
      }
      if (arg === '--tz') tz = value;
      else if (arg === '--alert') alert = value;
      else if (arg === '--limit') limit = value;
      else named[arg] = value;
      index += 1;
    } else {
      rest.push(arg);
    }
  }
  return {
    json,
    tz,
    limit,
    alert,
    replyOnly,
    ...namedOptions(named),
    rest,
    error: null,
  };
}

function namedOptions(named: Record<string, string>) {
  return {
    on: named['--on'],
    channel: named['--channel'],
    contains: named['--contains'],
    title: named['--title'],
  };
}

/** `add --on <source>`: a trigger, with an optional cron for a mail trigger's regular look. */
function addTrigger(
  spec: string,
  options: {
    tz: string;
    json: boolean;
    on: string;
    channel: string;
    contains: string;
    title: string;
  },
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  const cron = spec.match(/^"([^"]+)"\s+(.+)$/s);
  let task: ScheduledTask;
  try {
    task = createTrigger({
      sessionId: session.id,
      channelId: req.channelId,
      ownerUserId: req.userId ?? undefined,
      source: options.on,
      prompt: cron ? cron[2] : spec,
      title: options.title,
      channel: options.channel,
      contains: options.contains,
      cronExpr: cron?.[1],
      tz: options.tz,
    });
  } catch (error) {
    return badCommand(
      'Invalid Trigger',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (options.json) {
    return plainCommand(chatSafeJson({ version: 1, task: taskJson(task) }));
  }
  return plainCommand(
    `Trigger #${task.id} created: ${scheduleLabel(task)} — ${task.prompt}`,
  );
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
  const keys = [
    getSessionById(task.session_id)?.session_key,
    mainChatForWebTask(task.session_id)?.session_key,
  ].filter((key): key is string => Boolean(key));
  const sessionIds =
    keys.length > 0
      ? keys.flatMap((key) =>
          listSessionInstancesForKey(key, { limit: MAX_CHAT_SESSIONS }).map(
            (session) => session.id,
          ),
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
      const answered =
        reply.source === posted ||
        (!task.reply_only &&
          !task.fresh_session &&
          asked?.role === 'user' &&
          asked.user_id === 'scheduler' &&
          askedByTask(asked.content));
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

/**
 * The task's run history, newest first: when each run was due, when it ran,
 * how it ended (`done`, `failed`, `missed`, `skipped`, `running`), what it
 * cost and the message it posted.
 */
function runs(
  task: ScheduledTask,
  options: { limit: string; json: boolean },
): GatewayCommandResult {
  const limit = options.limit
    ? Number.parseInt(options.limit, 10)
    : DEFAULT_RESULTS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_RUNS) {
    return badCommand(
      'Invalid Limit',
      `\`--limit\` takes a number from 1 to ${MAX_TASK_RUNS}.`,
    );
  }
  const list = listTaskRuns(task.id, limit);
  if (options.json) {
    return plainCommand(
      chatSafeJson({ version: 1, task: taskJson(task), runs: list }),
    );
  }
  if (list.length === 0) {
    return plainCommand(`Task #${task.id} has not run yet.`);
  }
  return infoCommand(
    `Runs of Task #${task.id}`,
    list
      .map(
        (run) =>
          `${run.due_at} · ${run.outcome}${run.duration_ms != null ? ` · ${Math.round(run.duration_ms / 1000)} s` : ''}${run.error ? ` · ${run.error}` : ''}`,
      )
      .join('\n'),
  );
}

function taskEditor(session: Session) {
  const inherited = resolveAgentForRequest({ session }).model;
  const models = [...new Set([inherited, ...getAvailableModelList()])];
  return {
    version: 1,
    default_model: inherited,
    models: models.map((id) => ({
      id,
      label: formatModelForDisplay(id),
      efforts: getSupportedReasoningEfforts(resolveModelProvider(id), id),
    })),
  };
}

function update(args: string[], session: Session): GatewayCommandResult {
  const values = args.filter((value) => value !== '--json');
  const id = parseIntegerArg(values, 0);
  const task = findManageable(id, session);
  if (!task)
    return badCommand('Not Found', 'Task was not found for this chat.');
  let data: unknown;
  try {
    if (values.length !== 2 || !/^[A-Za-z0-9_-]{1,180000}$/.test(values[1]))
      throw new Error();
    data = JSON.parse(Buffer.from(values[1], 'base64url').toString('utf8'));
  } catch {
    return badCommand('Invalid Task', 'Invalid task update.');
  }
  if (
    !isRecord(data) ||
    Object.keys(data).some(
      (key) =>
        ![
          'revision',
          'title',
          'prompt',
          'cron',
          'tz',
          'run_at',
          'every_ms',
          'model',
          'effort',
          'fresh_session',
          'enabled',
        ].includes(key),
    )
  )
    return badCommand('Invalid Task', 'Unknown task fields.');
  if (data.revision !== taskRevision(task))
    return badCommand(
      'Task Changed',
      'Reopen the task before saving; it changed elsewhere.',
    );
  const {
    title,
    prompt,
    cron,
    tz,
    run_at: runAt,
    every_ms: everyMs,
    model,
    effort,
    fresh_session: freshSession,
    enabled,
  } = data;
  if (
    typeof title !== 'string' ||
    title.trim().length > 200 ||
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    prompt.length > 100000 ||
    typeof freshSession !== 'boolean' ||
    typeof enabled !== 'boolean'
  )
    return badCommand('Invalid Task', 'Check the title and instructions.');
  if (typeof tz !== 'string' || (tz && !isValidTimezone(tz)))
    return badCommand('Invalid Task', 'Invalid time zone.');
  const schedules = [cron != null, runAt != null, everyMs != null].filter(
    Boolean,
  ).length;
  // A trigger runs when something arrives; only a mail trigger may also keep a cron.
  if (task.trigger) {
    if (runAt != null || everyMs != null)
      return badCommand('Invalid Task', 'A trigger keeps no time schedule.');
    if (cron != null && task.trigger.source !== 'mail')
      return badCommand('Invalid Task', 'Only a mail trigger takes a cron.');
  } else if (schedules !== 1)
    return badCommand('Invalid Task', 'Choose exactly one schedule.');
  if (cron != null) {
    if (typeof cron !== 'string' || !cron.trim())
      return badCommand('Invalid Task', 'Invalid repeat schedule.');
    try {
      CronExpressionParser.parse(cron, tz ? { tz } : {});
    } catch {
      return badCommand('Invalid Task', 'Invalid repeat schedule.');
    }
  }
  if (
    runAt != null &&
    (typeof runAt !== 'string' ||
      !Number.isFinite(Date.parse(runAt)) ||
      Date.parse(runAt) <= Date.now())
  )
    return badCommand('Invalid Task', 'Choose a future date.');
  if (
    everyMs != null &&
    (typeof everyMs !== 'number' ||
      !Number.isSafeInteger(everyMs) ||
      everyMs < 10000)
  )
    return badCommand('Invalid Task', 'Invalid interval.');
  const catalog = taskEditor(session);
  if (
    model !== null &&
    (typeof model !== 'string' ||
      !catalog.models.some((entry) => entry.id === model))
  )
    return badCommand('Invalid Task', 'Choose an available model.');
  const effective = model || catalog.default_model;
  if (
    effort !== null &&
    (!isReasoningEffort(effort) ||
      !getSupportedReasoningEfforts(
        resolveModelProvider(effective),
        effective,
      ).includes(effort))
  )
    return badCommand(
      'Invalid Task',
      'This model does not support that effort.',
    );
  updateScheduledTask(task.id, {
    prompt,
    channelId: task.channel_id,
    title: title.trim() || null,
    cronExpr: typeof cron === 'string' ? cron : undefined,
    tz,
    runAt:
      typeof runAt === 'string' ? new Date(runAt).toISOString() : undefined,
    everyMs: typeof everyMs === 'number' ? everyMs : undefined,
    model,
    effort,
    freshSession,
  });
  setJobEnabled(task.id, enabled);
  rearmScheduler();
  const updated = getJob(task.id, { kind: 'scheduled_task' });
  return plainCommand(
    chatSafeJson({ version: 1, task: updated && taskJson(updated) }),
  );
}

export function handleScheduleCommand(
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  const sub = parseLowerArg(req.args, 1);
  if (sub === 'update') return update(req.args.slice(2).map(String), session);
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
    const spec = options.rest.join(' ').trim();
    return options.on
      ? addTrigger(spec, options, req, session)
      : add(spec, options, req, session);
  }

  if (sub === 'list') {
    const { tasks, hiddenCount } = listManageableScheduledTasks(session);
    if (options.json) {
      return plainCommand(
        chatSafeJson({
          version: 1,
          tasks: tasks.map(taskJson),
          editor: taskEditor(session),
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

  if (sub === 'results' || sub === 'runs') {
    const task = taskId ? getJob(taskId, { kind: 'scheduled_task' }) : null;
    if (!task || !canReadScheduledTaskResults(task, session))
      return notFound(taskId);
    return sub === 'runs' ? runs(task, options) : results(task, options);
  }

  if (sub === 'remove') {
    const task = findManageable(taskId, session);
    if (!task) return notFound(taskId);
    deleteJob(task.id);
    if (task.trigger) forgetTrigger(task.id);
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

/** Where webhook triggers are reached from outside, if this gateway is public. */
function publicBaseUrl(): string | null {
  return resolvePublicGatewayBaseUrl(getRuntimeConfig());
}
