/**
 * Chat review is a view of the durable channel prompt cache, not a second
 * approval authority. Only the pending request's owner sees its live facts;
 * answering and validating the action stays in the existing approval flow.
 */
import type { ApprovalReplyInterpretation } from '../../container/shared/approval-reply.js';
import {
  decideMessageApproval,
  setMessageApproval,
} from '../memory/message-approval.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import {
  claimPendingApprovalByApprovalId,
  getPendingApproval,
  getStoredPendingApproval,
  handoffPendingApprovalClaim,
  setPendingApproval,
} from './pending-approvals.js';

export async function rememberChatApproval(
  request: GatewayChatRequest,
  result: GatewayChatResult,
): Promise<void> {
  const approval = result.pendingApproval;
  if (request.channelId !== 'web' || !approval) return;
  const sessionId = result.sessionId || request.sessionId;
  if (result.assistantMessageId)
    setMessageApproval(sessionId, result.assistantMessageId, approval);
  // A channel may already have registered the request with its notification cleanup.
  if (getStoredPendingApproval(sessionId)?.approvalId === approval.approvalId)
    return;
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
    pending.state !== 'pending' ||
    pending.expiresAt <= Date.now() ||
    (pending.approval.expiresAt !== null &&
      pending.approval.expiresAt <= Date.now())
  )
    return null;
  return { ...pending.approval, type: 'approval' as const };
}

export async function rememberChatApprovalDecision(
  sessionId: string,
  userId: string,
  reply: ApprovalReplyInterpretation | undefined,
): Promise<void> {
  if (
    !reply?.approvalId ||
    (reply.decision !== 'approve' && reply.decision !== 'deny')
  )
    return;
  const pending = getStoredPendingApproval(sessionId);
  if (
    pending?.approvalId !== reply.approvalId ||
    pending.userId !== userId ||
    (pending.state !== 'pending' &&
      pending.state !== 'claimed' &&
      pending.state !== 'handed_off') ||
    pending.expiresAt <= Date.now()
  )
    return;
  decideMessageApproval(
    sessionId,
    reply.approvalId,
    reply.decision === 'approve' ? 'allowed' : 'denied',
  );
  const claim = claimPendingApprovalByApprovalId({
    sessionId,
    approvalId: reply.approvalId,
    userId,
  });
  if (claim.status === 'claimed') handoffPendingApprovalClaim(claim.claim);
}
