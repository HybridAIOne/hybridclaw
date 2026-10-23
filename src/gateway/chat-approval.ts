/**
 * Gateway approval metadata keeps the caller's input separate from task prompts.
 * The worker or host connector bridge interprets consent; this module only passes
 * provenance, presents pending requests and records interpretation audit events.
 */

import type { ApprovalReplyContext } from '#shared/approval-reply.js';
import { recordAuditEvent } from '../audit/audit-events.js';
import { isGoalContinuationSource } from '../goals/goal-runtime.js';
import type { ContainerOutput } from '../types/container.js';
import type {
  GatewayChatApprovalEvent,
  GatewayChatRequest,
  GatewayChatResult,
} from './gateway-types.js';

export function formatGatewayChatApprovalSummary(
  approval: Pick<GatewayChatApprovalEvent, 'approvalId' | 'intent' | 'reason'>,
): string {
  const lines: string[] = [];
  const intent = approval.intent.trim();
  const reason = approval.reason.trim();

  if (intent) {
    lines.push(`Approval needed for: ${intent}`);
  }
  if (reason) {
    lines.push(`Why: ${reason}`);
  }
  lines.push(`Approval ID: ${approval.approvalId}`);

  return lines.join('\n');
}

export function extractGatewayChatApprovalEvent(
  result: Pick<GatewayChatResult, 'pendingApproval'>,
): GatewayChatApprovalEvent | null {
  const approval = result.pendingApproval;
  if (!approval) return null;
  const approvalId = String(approval.approvalId || '').trim();
  if (!approvalId) return null;
  const summary = formatGatewayChatApprovalSummary({
    approvalId,
    intent: String(approval.intent || '').trim(),
    reason: String(approval.reason || '').trim(),
  });
  return {
    type: 'approval',
    approvalId,
    prompt: String(approval.prompt || '').trim(),
    intent: String(approval.intent || '').trim(),
    reason: String(approval.reason || '').trim(),
    approvalTier: approval.approvalTier,
    toolName: approval.toolName,
    commandPreview: approval.commandPreview,
    ...(approval.reviewArguments
      ? { reviewArguments: approval.reviewArguments }
      : {}),
    summary,
    allowSession: approval.allowSession === true,
    allowAgent: approval.allowAgent === true,
    allowAll: approval.allowAll === true,
    expiresAt:
      typeof approval.expiresAt === 'number' &&
      Number.isFinite(approval.expiresAt)
        ? approval.expiresAt
        : null,
    ...(approval.rule ? { rule: approval.rule } : {}),
    ...(approval.escalationTarget
      ? { escalationTarget: approval.escalationTarget }
      : {}),
    ...(approval.boost ? { boost: approval.boost } : {}),
  };
}

/** Background prompts and model-derived consults cannot manufacture user consent. */
export function approvalReplyContext(
  req: GatewayChatRequest,
  userText: string,
): ApprovalReplyContext {
  const autonomous =
    req.source === 'fullauto' ||
    req.source === 'heartbeat' ||
    req.source === 'scheduler' ||
    isGoalContinuationSource(req.source);
  return {
    approvalUserId: req.userId,
    approvalUserText: autonomous
      ? null
      : req.approvalUserText === undefined
        ? userText
        : req.approvalUserText,
  };
}

export function recordApprovalReply(
  sessionId: string,
  runId: string,
  output: ContainerOutput,
): void {
  if (output.approvalReply)
    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'approval.interpretation',
        ...output.approvalReply,
      },
    });
}
