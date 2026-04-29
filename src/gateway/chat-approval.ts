import type {
  GatewayChatApprovalEvent,
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
  result: GatewayChatResult,
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
    summary,
    allowSession: approval.allowSession === true,
    allowAgent: approval.allowAgent === true,
    allowAll: approval.allowAll === true,
    expiresAt:
      typeof approval.expiresAt === 'number' &&
      Number.isFinite(approval.expiresAt)
        ? approval.expiresAt
        : null,
    ...(approval.escalationTarget
      ? { escalationTarget: approval.escalationTarget }
      : {}),
  };
}
