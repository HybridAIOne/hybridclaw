import { logger } from '../logger.js';
import { executeWorkflow } from './executor.js';
import type { StoredWorkflow, WorkflowTrigger } from './types.js';

export interface WorkflowEvent {
  kind: 'message' | 'reaction' | 'email_received';
  sourceChannel: string;
  channelId: string;
  senderId: string;
  senderAddress?: string;
  content?: string;
  subject?: string;
  reactionEmoji?: string;
  timestamp: number;
}

interface RegisteredWorkflowTrigger {
  workflowId: number;
  sessionId: string;
  agentId: string;
  trigger: WorkflowTrigger;
}

type WorkflowExecutionHandler = (params: {
  workflowId: number;
  event?: WorkflowEvent;
  agentId: string;
  sessionId: string;
}) => Promise<void>;

const registeredWorkflowTriggers = new Map<number, RegisteredWorkflowTrigger>();
let workflowExecutionHandler: WorkflowExecutionHandler = executeWorkflow;

function matchesOptionalPattern(
  pattern: string | undefined,
  value: string,
): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch (error) {
    logger.warn({ error, pattern }, 'Ignoring invalid workflow trigger regex');
    return false;
  }
}

function matchesSourceChannel(
  expected: string | undefined,
  actual: string,
): boolean {
  if (!expected || expected === '*') return true;
  return expected.toLowerCase() === actual.toLowerCase();
}

export function doesWorkflowTriggerMatchEvent(
  trigger: WorkflowTrigger,
  event: WorkflowEvent,
): boolean {
  if (!matchesSourceChannel(trigger.sourceChannel, event.sourceChannel)) {
    return false;
  }

  if (trigger.kind === 'schedule' || trigger.kind === 'webhook') {
    return false;
  }

  if (trigger.kind === 'reaction') {
    if (event.kind !== 'reaction') return false;
    if (
      trigger.reactionEmoji &&
      trigger.reactionEmoji !== event.reactionEmoji
    ) {
      return false;
    }
    return matchesOptionalPattern(
      trigger.fromPattern,
      event.senderAddress || event.senderId,
    );
  }

  if (trigger.kind === 'keyword') {
    if (event.kind !== 'message' && event.kind !== 'email_received') {
      return false;
    }
    return matchesOptionalPattern(
      trigger.contentPattern,
      String(event.content || ''),
    );
  }

  if (trigger.eventType && trigger.eventType !== event.kind) {
    return false;
  }

  if (
    !matchesOptionalPattern(
      trigger.fromPattern,
      event.senderAddress || event.senderId,
    )
  ) {
    return false;
  }
  if (
    !matchesOptionalPattern(trigger.contentPattern, String(event.content || ''))
  ) {
    return false;
  }
  if (
    !matchesOptionalPattern(trigger.subjectPattern, String(event.subject || ''))
  ) {
    return false;
  }
  return true;
}

export function setWorkflowEventExecutor(
  handler: WorkflowExecutionHandler,
): void {
  workflowExecutionHandler = handler;
}

export function resetWorkflowEventBus(): void {
  registeredWorkflowTriggers.clear();
  workflowExecutionHandler = executeWorkflow;
}

export function primeWorkflowEventSubscriptions(
  workflows: StoredWorkflow[],
): void {
  registeredWorkflowTriggers.clear();
  for (const workflow of workflows) {
    upsertWorkflowEventSubscription(workflow);
  }
}

export function upsertWorkflowEventSubscription(
  workflow: Pick<
    StoredWorkflow,
    'id' | 'session_id' | 'agent_id' | 'enabled' | 'spec'
  >,
): void {
  if (!workflow.enabled || workflow.spec.trigger.kind === 'schedule') {
    registeredWorkflowTriggers.delete(workflow.id);
    return;
  }
  registeredWorkflowTriggers.set(workflow.id, {
    workflowId: workflow.id,
    sessionId: workflow.session_id,
    agentId: workflow.agent_id,
    trigger: workflow.spec.trigger,
  });
}

export function removeWorkflowEventSubscription(workflowId: number): void {
  registeredWorkflowTriggers.delete(workflowId);
}

export async function publishWorkflowEvent(
  event: WorkflowEvent,
): Promise<number[]> {
  const matched = Array.from(registeredWorkflowTriggers.values()).filter(
    (workflow) => doesWorkflowTriggerMatchEvent(workflow.trigger, event),
  );
  if (matched.length === 0) return [];

  await Promise.allSettled(
    matched.map((workflow) =>
      workflowExecutionHandler({
        workflowId: workflow.workflowId,
        event,
        agentId: workflow.agentId,
        sessionId: workflow.sessionId,
      }),
    ),
  );
  return matched.map((workflow) => workflow.workflowId);
}
