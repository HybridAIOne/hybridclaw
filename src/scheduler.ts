/**
 * Scheduler — timer-based, arms for exact next-fire time.
 *
 * Instead of polling every 60s, computes when the next task is due and
 * sets a single setTimeout for that moment.  Re-arms after every tick
 * and whenever a task is added/removed via rearmScheduler().
 */
import { CronExpressionParser } from 'cron-parser';

import { deleteTask, getAllEnabledTasks, updateTaskLastRun } from './db.js';
import { logger } from './logger.js';

const MAX_TIMER_DELAY_MS = 300_000; // 5 min safety net for clock drift

type TaskRunner = (sessionId: string, channelId: string, prompt: string, taskId: number) => Promise<void>;

let timer: ReturnType<typeof setTimeout> | null = null;
let taskRunner: TaskRunner | null = null;
let ticking = false;

// --- Prompt framing (OpenClaw style) ---

function formatFireTime(): string {
  return new Date().toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function wrapCronPrompt(taskId: number, taskName: string, message: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[cron:#${taskId} ${taskName}] ${message}\nCurrent time: ${formatFireTime()} (${tz})\n\nReturn your response as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`;
}

// --- Timer logic ---

function computeNextFireMs(): number | null {
  const tasks = getAllEnabledTasks();
  let earliest: number | null = null;

  for (const task of tasks) {
    if (task.run_at) {
      if (!task.last_run) {
        const ms = new Date(task.run_at).getTime();
        if (earliest === null || ms < earliest) earliest = ms;
      }
      continue;
    }

    if (task.every_ms) {
      const lastRunMs = task.last_run ? new Date(task.last_run).getTime() : 0;
      const nextMs = lastRunMs > 0 ? lastRunMs + task.every_ms : Date.now();
      if (earliest === null || nextMs < earliest) earliest = nextMs;
      continue;
    }

    if (!task.cron_expr) continue;

    try {
      const ms = CronExpressionParser.parse(task.cron_expr).next().toDate().getTime();
      if (earliest === null || ms < earliest) earliest = ms;
    } catch { /* skip invalid */ }
  }

  return earliest;
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;

  const nextFireMs = computeNextFireMs();
  if (nextFireMs === null) return; // nothing scheduled

  const delay = Math.max(nextFireMs - Date.now(), 0);
  const clamped = Math.min(delay, MAX_TIMER_DELAY_MS);

  logger.debug(
    { delayMs: clamped, nextFire: new Date(nextFireMs).toISOString() },
    'Scheduler armed',
  );

  timer = setTimeout(() => {
    void tick().catch((err) => {
      logger.error({ err }, 'Scheduler tick failed');
      arm(); // re-arm even on error
    });
  }, clamped);
}

async function tick(): Promise<void> {
  if (ticking) {
    arm(); // re-check later
    return;
  }
  ticking = true;

  try {
    const tasks = getAllEnabledTasks();
    const now = new Date();

    for (const task of tasks) {
      try {
        // --- One-shot task ---
        if (task.run_at) {
          const runAt = new Date(task.run_at);
          if (runAt.getTime() <= now.getTime() && !task.last_run) {
            logger.info(
              { taskId: task.id, runAt: task.run_at, prompt: task.prompt },
              'One-shot task firing',
            );
            updateTaskLastRun(task.id); // prevents re-fire
            const prompt = wrapCronPrompt(task.id, task.prompt, task.prompt);
            taskRunner!(task.session_id, task.channel_id, prompt, task.id)
              .then(() => deleteTask(task.id))   // cleanup on success
              .catch((err) => {
                logger.error({ taskId: task.id, err }, 'One-shot task failed (task preserved)');
              });
          }
          continue;
        }

        // --- Interval task ---
        if (task.every_ms) {
          const lastRunMs = task.last_run ? new Date(task.last_run).getTime() : 0;
          const dueAt = lastRunMs > 0 ? lastRunMs + task.every_ms : 0; // fire immediately if never run
          if (dueAt <= now.getTime()) {
            logger.info(
              { taskId: task.id, everyMs: task.every_ms, prompt: task.prompt },
              'Interval task firing',
            );
            updateTaskLastRun(task.id);
            const prompt = wrapCronPrompt(task.id, task.prompt, task.prompt);
            taskRunner!(task.session_id, task.channel_id, prompt, task.id).catch((err) => {
              logger.error({ taskId: task.id, err }, 'Interval task failed');
            });
          }
          continue;
        }

        // --- Recurring cron task ---
        if (!task.cron_expr) continue;

        const cron = CronExpressionParser.parse(task.cron_expr);
        const prev = cron.prev();
        const lastRun = task.last_run ? new Date(task.last_run) : new Date(0);

        if (prev.toDate() > lastRun) {
          logger.info(
            { taskId: task.id, cron: task.cron_expr, prompt: task.prompt },
            'Cron task firing',
          );
          updateTaskLastRun(task.id);
          const prompt = wrapCronPrompt(task.id, task.prompt, task.prompt);
          taskRunner!(task.session_id, task.channel_id, prompt, task.id).catch((err) => {
            logger.error({ taskId: task.id, err }, 'Cron task failed');
          });
        }
      } catch (err) {
        logger.error({ taskId: task.id, cron: task.cron_expr, err }, 'Scheduler error for task');
      }
    }
  } finally {
    ticking = false;
    arm(); // re-arm for next task
  }
}

// --- Public API ---

export function startScheduler(runner: TaskRunner): void {
  logger.info('Scheduler started');
  taskRunner = runner;
  arm();
}

/**
 * Re-arm the scheduler timer.  Call after creating or deleting tasks
 * so newly scheduled work is picked up immediately.
 */
export function rearmScheduler(): void {
  if (taskRunner) arm();
}

export function stopScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  taskRunner = null;
  logger.info('Scheduler stopped');
}
