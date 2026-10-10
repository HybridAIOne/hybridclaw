/**
 * Chat review is a view of the durable channel prompt cache, not a second
 * approval authority. Only the pending request's owner sees its live facts;
 * answering and validating the action stays in the existing approval flow.
 */
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import { getPendingApproval, setPendingApproval } from './pending-approvals.js';

export async function rememberChatApproval(
  request: GatewayChatRequest,
  result: GatewayChatResult,
): Promise<void> {
  const approval = result.pendingApproval;
  if (request.channelId !== 'web' || !approval) return;
  const sessionId = result.sessionId || request.sessionId;
  // A channel may already have registered the request with its notification cleanup.
  if (getPendingApproval(sessionId)?.approvalId === approval.approvalId) return;
  await setPendingApproval(sessionId, {
    approvalId: approval.approvalId,
    prompt: approval.prompt,
    approval,
    userId: approval.escalationTarget?.recipient || request.userId,
    createdAt: Date.now(),
    expiresAt: approval.expiresAt ?? Number.MAX_SAFE_INTEGER,
  });
}

export function pendingChatApproval(sessionId: string, userId: string) {
  const pending = getPendingApproval(sessionId);
  if (
    !pending?.approval ||
    pending.userId !== userId ||
    pending.resolvedAt ||
    pending.expiresAt <= Date.now() ||
    (pending.approval.expiresAt !== null &&
      pending.approval.expiresAt <= Date.now())
  )
    return null;
  return { ...pending.approval, type: 'approval' as const };
}
