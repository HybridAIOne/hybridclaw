/** Pins a broker request to the exact local call and exposes only one-shot choices. */
import {
  type ConnectorApproval,
  connectorApprovalId,
} from '#shared/connector-approval.js';
import type { PendingApproval } from './pending-approval-store.js';
import type { PendingApproval as ApprovalPrompt } from './types.js';
export function buildConnectorApproval(
  approval: ConnectorApproval,
  toolName: string,
  argsJson: string,
  originalPrompt: string,
  sessionHash: string,
  fingerprint: string,
) {
  const id = connectorApprovalId(approval.id);
  const intent = `change ${approval.connector_name} using ${approval.tool_name}`;
  const reason = 'This change requires your approval.';
  const prompt = `Hy needs your approval before this change to ${approval.connector_name}.`;
  const pending: PendingApproval = {
    id,
    sessionHash,
    fingerprint,
    actionKey: 'mcp:platform:write',
    toolName,
    argsJson,
    intent,
    consequenceIfDenied: 'Nothing is changed.',
    reason,
    commandPreview: approval.arguments_preview,
    createdAtMs: Date.now(),
    expiresAtMs: approval.expires_at,
    originalPrompt,
    pinned: true,
  };
  const promptCard: ApprovalPrompt = {
    approvalId: id,
    prompt,
    intent,
    reason,
    approvalTier: 'red',
    toolName,
    commandPreview: approval.arguments_preview,
    reviewArguments: approval.arguments_preview,
    allowSession: false,
    allowAgent: false,
    allowAll: false,
    expiresAt: approval.expires_at,
  };
  return { pending, promptCard };
}
