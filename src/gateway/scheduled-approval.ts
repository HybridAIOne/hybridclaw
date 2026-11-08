/**
 * Where a scheduled run's approval lives, seen from the chat that shows it.
 *
 * The worker keeps a paused call with the session that asked, so a run kept
 * apart from its chat holds the request in the run's own session. The run's
 * work record links the reply copied into the chat back to that session; a
 * chat that never showed the approval finds nothing. This module only looks
 * the link up: claiming and resuming stay in `scheduled-approval-answer.ts`
 * and the pending registry.
 */
import { findMessageApproval } from '../memory/message-approval.js';
import { type WorkRecord, workForMessage } from '../work/work-store.js';

export interface ScheduledApproval {
  work: WorkRecord & { taskId: number };
  /** The reply's `schedule:<task id>` label. */
  source: string;
}

export function scheduledApproval(
  chatSessionId: string,
  approvalId: string,
): ScheduledApproval | null {
  const message = findMessageApproval(chatSessionId, approvalId);
  const work = message ? workForMessage(chatSessionId, message.id) : null;
  if (!message || !work?.taskId || work.runSessionId === chatSessionId)
    return null;
  return {
    work: { ...work, taskId: work.taskId },
    source: message.source ?? `schedule:${work.taskId}`,
  };
}

/** The session whose pending registry holds an approval this chat shows. */
export function approvalSessionId(
  chatSessionId: string,
  approvalId: string,
): string {
  return (
    scheduledApproval(chatSessionId, approvalId)?.work.runSessionId ??
    chatSessionId
  );
}
