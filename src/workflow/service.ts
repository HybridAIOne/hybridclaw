import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  createTask,
  createWorkflow,
  deleteTask,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  toggleTask,
  updateWorkflow,
} from '../memory/db.js';
import { rearmScheduler } from '../scheduler/scheduler.js';
import {
  primeWorkflowEventSubscriptions,
  removeWorkflowEventSubscription,
  upsertWorkflowEventSubscription,
} from './event-bus.js';
import type {
  StoredWorkflow,
  WorkflowCreateInput,
  WorkflowDelivery,
  WorkflowTrigger,
} from './types.js';

function getWorkflowCompanionTaskConfig(
  trigger: WorkflowTrigger,
): { cronExpr: string; runAt?: string; everyMs?: number } | null {
  if (trigger.kind !== 'schedule') return null;
  return {
    cronExpr: trigger.cronExpr || '',
    runAt: trigger.runAt,
    everyMs: trigger.everyMs,
  };
}

function buildWorkflowCompanionPrompt(
  input: Pick<WorkflowCreateInput, 'name' | 'description'>,
): string {
  const description = input.description?.trim();
  return description
    ? `Workflow: ${input.name.trim()} - ${description}`
    : `Workflow: ${input.name.trim()}`;
}

function syncWorkflowRuntime(workflow: StoredWorkflow): void {
  upsertWorkflowEventSubscription(workflow);
}

function recordWorkflowAuditEvent(params: {
  sessionId: string;
  type:
    | 'workflow.created'
    | 'workflow.deleted'
    | 'workflow.toggled'
    | 'workflow.updated';
  workflowId: number;
  name?: string;
  enabled?: boolean;
  companionTaskId?: number | null;
  triggerKind?: string;
}): void {
  recordAuditEvent({
    sessionId: params.sessionId,
    runId: makeAuditRunId('workflow'),
    event: {
      type: params.type,
      workflowId: params.workflowId,
      ...(params.name ? { name: params.name } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.companionTaskId !== undefined
        ? { companionTaskId: params.companionTaskId }
        : {}),
      ...(params.triggerKind ? { triggerKind: params.triggerKind } : {}),
    },
  });
}

export function resolveWorkflowScheduleLabel(
  workflow: Pick<StoredWorkflow, 'spec'>,
): string {
  const trigger = workflow.spec.trigger;
  if (trigger.kind !== 'schedule') {
    return trigger.kind.replace(/_/g, ' ');
  }
  if (trigger.runAt) return `at ${trigger.runAt}`;
  if (trigger.everyMs) return `every ${trigger.everyMs}ms`;
  if (trigger.cronExpr) return `cron ${trigger.cronExpr}`;
  return 'schedule';
}

export function resolveWorkflowDeliveryLabel(
  delivery: WorkflowDelivery,
): string {
  if (delivery.kind === 'originating') return 'originating channel';
  if (delivery.kind === 'channel') {
    return delivery.target ? `channel ${delivery.target}` : 'channel';
  }
  if (delivery.kind === 'email') {
    return delivery.target ? `email ${delivery.target}` : 'email';
  }
  return delivery.target ? `webhook ${delivery.target}` : 'webhook';
}

export function initializeWorkflowRuntime(): void {
  primeWorkflowEventSubscriptions(listWorkflows({ enabled: true }));
}

export function createPersistedWorkflow(
  input: WorkflowCreateInput,
): StoredWorkflow {
  const workflowId = createWorkflow({
    ...input,
    companionTaskId: null,
  });
  const companionConfig = getWorkflowCompanionTaskConfig(input.spec.trigger);
  let companionTaskId: number | null = null;

  try {
    if (companionConfig) {
      companionTaskId = createTask(
        input.sessionId,
        input.channelId,
        companionConfig.cronExpr,
        buildWorkflowCompanionPrompt(input),
        companionConfig.runAt,
        companionConfig.everyMs,
      );
      if (input.enabled === false) {
        toggleTask(companionTaskId, false);
      }
      updateWorkflow(workflowId, {
        companionTaskId,
      });
      rearmScheduler();
    }
  } catch (error) {
    deleteWorkflow(workflowId);
    throw error;
  }

  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} was not found after creation.`);
  }
  syncWorkflowRuntime(workflow);
  recordWorkflowAuditEvent({
    sessionId: workflow.session_id,
    type: 'workflow.created',
    workflowId: workflow.id,
    name: workflow.name,
    companionTaskId: workflow.companion_task_id,
    triggerKind: workflow.spec.trigger.kind,
  });
  return workflow;
}

export function togglePersistedWorkflow(
  workflowId: number,
): StoredWorkflow | null {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  const nextEnabled = !workflow.enabled;
  updateWorkflow(workflowId, {
    enabled: nextEnabled,
  });
  if (workflow.companion_task_id != null) {
    toggleTask(workflow.companion_task_id, nextEnabled);
    rearmScheduler();
  }
  const updated = getWorkflow(workflowId);
  if (!updated) return null;
  syncWorkflowRuntime(updated);
  recordWorkflowAuditEvent({
    sessionId: updated.session_id,
    type: 'workflow.toggled',
    workflowId: updated.id,
    name: updated.name,
    enabled: Boolean(updated.enabled),
    companionTaskId: updated.companion_task_id,
    triggerKind: updated.spec.trigger.kind,
  });
  return updated;
}

export function updatePersistedWorkflow(
  workflowId: number,
  input: WorkflowCreateInput,
): StoredWorkflow | null {
  const existing = getWorkflow(workflowId);
  if (!existing) return null;

  const nextEnabled = input.enabled !== false;
  const shouldReplaceCompanionTask =
    input.name.trim() !== existing.name ||
    (input.description?.trim() || '') !== existing.description ||
    JSON.stringify(input.spec) !== JSON.stringify(existing.spec);

  let nextCompanionTaskId = existing.companion_task_id;
  let createdCompanionTaskId: number | null = null;
  let shouldRearmScheduler = false;

  try {
    if (shouldReplaceCompanionTask) {
      const companionConfig = getWorkflowCompanionTaskConfig(input.spec.trigger);
      if (companionConfig) {
        createdCompanionTaskId = createTask(
          existing.session_id,
          existing.channel_id,
          companionConfig.cronExpr,
          buildWorkflowCompanionPrompt(input),
          companionConfig.runAt,
          companionConfig.everyMs,
        );
        if (!nextEnabled) {
          toggleTask(createdCompanionTaskId, false);
        }
        nextCompanionTaskId = createdCompanionTaskId;
      } else {
        nextCompanionTaskId = null;
      }
      shouldRearmScheduler = true;
    }

    updateWorkflow(workflowId, {
      name: input.name,
      description: input.description,
      spec: input.spec,
      naturalLanguage: input.naturalLanguage,
      enabled: nextEnabled,
      ...(shouldReplaceCompanionTask
        ? { companionTaskId: nextCompanionTaskId }
        : {}),
    });

    if (shouldReplaceCompanionTask && existing.companion_task_id != null) {
      deleteTask(existing.companion_task_id);
    } else if (
      !shouldReplaceCompanionTask &&
      existing.companion_task_id != null &&
      Boolean(existing.enabled) !== nextEnabled
    ) {
      toggleTask(existing.companion_task_id, nextEnabled);
      shouldRearmScheduler = true;
    }
  } catch (error) {
    if (createdCompanionTaskId != null) {
      deleteTask(createdCompanionTaskId);
    }
    throw error;
  }

  if (shouldRearmScheduler) {
    rearmScheduler();
  }

  const updated = getWorkflow(workflowId);
  if (!updated) return null;
  syncWorkflowRuntime(updated);
  recordWorkflowAuditEvent({
    sessionId: updated.session_id,
    type: 'workflow.updated',
    workflowId: updated.id,
    name: updated.name,
    enabled: Boolean(updated.enabled),
    companionTaskId: updated.companion_task_id,
    triggerKind: updated.spec.trigger.kind,
  });
  return updated;
}

export function removePersistedWorkflow(
  workflowId: number,
): StoredWorkflow | null {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  if (workflow.companion_task_id != null) {
    deleteTask(workflow.companion_task_id);
    rearmScheduler();
  }
  deleteWorkflow(workflowId);
  removeWorkflowEventSubscription(workflowId);
  recordWorkflowAuditEvent({
    sessionId: workflow.session_id,
    type: 'workflow.deleted',
    workflowId: workflow.id,
    name: workflow.name,
    companionTaskId: workflow.companion_task_id,
    triggerKind: workflow.spec.trigger.kind,
  });
  return workflow;
}
