import { formatGatewayChatApprovalSummary } from './gateway/chat-approval.js';
import type { GatewayChatApprovalEvent } from './gateway/gateway-types.js';

export interface TuiApprovalDetails {
  approvalId: string;
  intent: string;
  reason: string;
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
}

export function formatTuiApprovalSummary(
  approval: Pick<GatewayChatApprovalEvent, 'approvalId' | 'intent' | 'reason'>,
): string {
  return formatGatewayChatApprovalSummary(approval);
}

export function parseTuiApprovalPrompt(
  prompt: string,
): TuiApprovalDetails | null {
  const lines = prompt
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const intentLine = lines.find((line) =>
    line.startsWith('I need your approval before I '),
  );
  const reasonLine = lines.find((line) => line.startsWith('Why: '));
  const approvalIdLine = lines.find((line) => line.startsWith('Approval ID: '));

  if (!intentLine || !reasonLine || !approvalIdLine) {
    return null;
  }

  let intent = intentLine.slice('I need your approval before I '.length).trim();
  if (intent.endsWith('.')) {
    intent = intent.slice(0, -1).trim();
  }

  const reason = reasonLine.slice('Why: '.length).trim();
  const approvalId = approvalIdLine.slice('Approval ID: '.length).trim();
  if (!intent || !reason || !approvalId) {
    return null;
  }

  return {
    approvalId,
    intent,
    reason,
    allowSession: lines.includes(
      'Reply `yes for session` to trust this action for this session.',
    ),
    allowAgent: lines.includes(
      'Reply `yes for agent` to trust it for this agent.',
    ),
    allowAll: lines.includes(
      'Reply `yes for all` to add this action to the workspace allowlist.',
    ),
  };
}
