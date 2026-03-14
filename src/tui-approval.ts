import { formatGatewayChatApprovalSummary } from './gateway/chat-approval.js';
import type { GatewayChatApprovalEvent } from './gateway/gateway-types.js';

export function formatTuiApprovalSummary(
  approval: Pick<GatewayChatApprovalEvent, 'approvalId' | 'intent' | 'reason'>,
): string {
  return formatGatewayChatApprovalSummary(approval);
}
