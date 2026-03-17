import { logger } from '../logger.js';
import { createTask, deleteTask } from '../memory/db.js';
import { rearmScheduler } from '../scheduler/scheduler.js';
import type { ContainerOutput, DelegationSideEffect } from '../types.js';
import {
  createPersistedWorkflow,
  removePersistedWorkflow,
  togglePersistedWorkflow,
} from '../workflow/service.js';

interface SideEffectHandlers {
  onDelegation?: (effect: DelegationSideEffect) => void;
}

interface SideEffectContext {
  sessionId: string;
  channelId: string;
  agentId?: string;
}

export interface SideEffectProcessingResult {
  createdTaskIds: number[];
  removedTaskIds: number[];
  createdWorkflowIds: number[];
  removedWorkflowIds: number[];
  toggledWorkflowIds: number[];
}

export function processSideEffects(
  output: ContainerOutput,
  context: SideEffectContext,
  handlers: SideEffectHandlers = {},
): SideEffectProcessingResult {
  const result: SideEffectProcessingResult = {
    createdTaskIds: [],
    removedTaskIds: [],
    createdWorkflowIds: [],
    removedWorkflowIds: [],
    toggledWorkflowIds: [],
  };
  const { sessionId, channelId, agentId } = context;
  const schedules = output.sideEffects?.schedules;
  const delegations = output.sideEffects?.delegations || [];
  const workflows = output.sideEffects?.workflows || [];
  if (
    (!schedules || schedules.length === 0) &&
    delegations.length === 0 &&
    workflows.length === 0
  ) {
    return result;
  }

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
          logger.info(
            {
              taskId,
              sessionId,
              channelId,
              cronExpr: effect.cronExpr,
              runAt: effect.runAt,
              everyMs: effect.everyMs,
            },
            'Side-effect: created task',
          );
          result.createdTaskIds.push(taskId);
          changed = true;
        } else if (effect.action === 'remove') {
          deleteTask(effect.taskId);
          logger.info(
            { taskId: effect.taskId, sessionId },
            'Side-effect: removed task',
          );
          result.removedTaskIds.push(effect.taskId);
          changed = true;
        }
      } catch (err) {
        logger.error({ effect, err }, 'Failed to process side-effect');
      }
    }
  }

  if (workflows.length > 0) {
    for (const effect of workflows) {
      try {
        if (effect.action === 'create') {
          if (!agentId) {
            logger.warn(
              { effect, sessionId, channelId },
              'Workflow side-effect ignored: missing agent id',
            );
            continue;
          }
          const workflow = createPersistedWorkflow({
            sessionId,
            channelId,
            agentId,
            name: effect.name,
            description: effect.description,
            naturalLanguage: effect.naturalLanguage,
            spec: effect.spec,
          });
          logger.info(
            {
              workflowId: workflow.id,
              sessionId,
              channelId,
              triggerKind: workflow.spec.trigger.kind,
            },
            'Side-effect: created workflow',
          );
          result.createdWorkflowIds.push(workflow.id);
        } else if (effect.action === 'remove') {
          const workflow = removePersistedWorkflow(effect.workflowId);
          if (!workflow) continue;
          logger.info(
            { workflowId: effect.workflowId, sessionId },
            'Side-effect: removed workflow',
          );
          result.removedWorkflowIds.push(effect.workflowId);
        } else if (effect.action === 'toggle') {
          const workflow = togglePersistedWorkflow(effect.workflowId);
          if (!workflow) continue;
          logger.info(
            {
              workflowId: workflow.id,
              enabled: Boolean(workflow.enabled),
              sessionId,
            },
            'Side-effect: toggled workflow',
          );
          result.toggledWorkflowIds.push(workflow.id);
        }
      } catch (err) {
        logger.error({ effect, err }, 'Failed to process workflow side-effect');
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
              mode:
                effect.mode ||
                (effect.chain?.length
                  ? 'chain'
                  : effect.tasks?.length
                    ? 'parallel'
                    : 'single'),
              prompt: effect.prompt,
              label: effect.label,
              tasks: effect.tasks?.length,
              chain: effect.chain?.length,
            },
            'Side-effect: delegation ignored (no handler)',
          );
        }
      } catch (err) {
        logger.error(
          { effect, err },
          'Failed to process delegation side-effect',
        );
      }
    }
  }

  // Re-arm scheduler so new tasks are picked up immediately
  if (changed) rearmScheduler();
  return result;
}
