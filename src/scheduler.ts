import { CronExpressionParser } from 'cron-parser';

import { getAllEnabledTasks, updateTaskLastRun } from './db.js';
import { logger } from './logger.js';

const POLL_INTERVAL = 60_000; // 60 seconds

type TaskRunner = (sessionId: string, channelId: string, prompt: string) => Promise<void>;

let timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(runner: TaskRunner): void {
  logger.info('Scheduler started');

  timer = setInterval(async () => {
    const tasks = getAllEnabledTasks();
    const now = new Date();

    for (const task of tasks) {
      try {
        const cron = CronExpressionParser.parse(task.cron_expr);
        const prev = cron.prev();

        // Check if the cron would have fired since last_run (or ever)
        const lastRun = task.last_run ? new Date(task.last_run) : new Date(0);
        if (prev.toDate() > lastRun) {
          logger.info(
            { taskId: task.id, cron: task.cron_expr, prompt: task.prompt },
            'Scheduled task firing',
          );
          updateTaskLastRun(task.id);
          // Fire and forget — don't block the scheduler loop
          runner(task.session_id, task.channel_id, task.prompt).catch((err) => {
            logger.error({ taskId: task.id, err }, 'Scheduled task failed');
          });
        }
      } catch (err) {
        logger.error({ taskId: task.id, cron: task.cron_expr, err }, 'Invalid cron expression');
      }
    }
  }, POLL_INTERVAL);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Scheduler stopped');
  }
}
