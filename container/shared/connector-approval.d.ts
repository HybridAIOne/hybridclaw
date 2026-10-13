/** Shared wire contract for platform-owned, one-shot connector approvals. */
export interface ConnectorApproval {
  id: string;
  connector_name: string;
  tool_name: string;
  arguments_preview: string;
  expires_at: number;
}
export const CONNECTOR_APPROVAL_META: 'hybridai/approval';
export const CONNECTOR_APPROVAL_REQUIRED_META: 'hybridai/approvalRequired';
export const CONNECTOR_APPROVAL_CONTEXT_META: 'hybridai/approvalContext';
export function connectorApprovalId(id: string): string;
export function platformApprovalId(id: string): string | null;
export function parseConnectorApproval(
  value: unknown,
): ConnectorApproval | null;
