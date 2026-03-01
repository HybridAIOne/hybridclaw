import { createTask, deleteTask } from './db.js';
import { logger } from './logger.js';
import { rearmScheduler } from './scheduler.js';
import type { ContainerOutput, DelegationSideEffect } from './types.js';

interface SideEffectHandlers {
  onDelegation?: (effect: DelegationSideEffect) => void;
}

export function processSideEffects(
  output: ContainerOutput,
  sessionId: string,
  channelId: string,
  handlers: SideEffectHandlers = {},
): void {
  const schedules = output.sideEffects?.schedules;
  const delegations = output.sideEffects?.delegations || [];
  if ((!schedules || schedules.length === 0) && delegations.length === 0) return;

  let changed = false;

  if (schedules && schedules.length > 0) {
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
  }

  if (delegations.length > 0) {
    for (const effect of delegations) {
      try {
        if (handlers.onDelegation) {
          handlers.onDelegation(effect);
        } else {
          logger.info(
            {
              sessionId,
              channelId,
              mode: effect.mode || (effect.chain?.length ? 'chain' : effect.tasks?.length ? 'parallel' : 'single'),
              prompt: effect.prompt,
              label: effect.label,
              tasks: effect.tasks?.length,
              chain: effect.chain?.length,
            },
            'Side-effect: delegation ignored (no handler)',
          );
        }
      } catch (err) {
        logger.error({ effect, err }, 'Failed to process delegation side-effect');
      }
    }
  }

  // Re-arm scheduler so new tasks are picked up immediately
  if (changed) rearmScheduler();
}
