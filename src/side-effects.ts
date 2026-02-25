import { createTask, deleteTask } from './db.js';
import { logger } from './logger.js';
import { rearmScheduler } from './scheduler.js';
import type { ContainerOutput } from './types.js';

export function processSideEffects(
  output: ContainerOutput,
  sessionId: string,
  channelId: string,
): void {
  const schedules = output.sideEffects?.schedules;
  if (!schedules || schedules.length === 0) return;

  let changed = false;

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
        logger.info({ taskId, sessionId, channelId, cronExpr: effect.cronExpr, runAt: effect.runAt, everyMs: effect.everyMs }, 'Side-effect: created task');
        changed = true;
      } else if (effect.action === 'remove') {
        deleteTask(effect.taskId);
        logger.info({ taskId: effect.taskId, sessionId }, 'Side-effect: removed task');
        changed = true;
      }
    } catch (err) {
      logger.error({ effect, err }, 'Failed to process side-effect');
    }
  }

  // Re-arm scheduler so new tasks are picked up immediately
  if (changed) rearmScheduler();
}
