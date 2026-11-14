/** Shared wire contract for platform-owned, one-shot connector approvals. */
export interface ConnectorApproval {
  id: string;
  connector_name: string;
  tool_name: string;
  arguments_preview: string;
  expires_at: number;
}
/** Connector approval IDs namespace the platform's one-shot grant in chat. */
export const CONNECTOR_APPROVAL_META: 'hybridai/approval' = 'hybridai/approval';
export const CONNECTOR_APPROVAL_REQUIRED_META: 'hybridai/approvalRequired' =
  'hybridai/approvalRequired';
export const CONNECTOR_APPROVAL_CONTEXT_META: 'hybridai/approvalContext' =
  'hybridai/approvalContext';
export function connectorApprovalId(id: string): string {
  if (!/^[a-f0-9]{16}$/.test(id))
    throw new Error('Invalid connector approval ID.');
  return `cc-${id}`;
}
export function platformApprovalId(id: string): string | null {
  return /^cc-[a-f0-9]{16}$/.test(id) ? id.slice(3) : null;
}
export function parseConnectorApproval(
  value: unknown,
): ConnectorApproval | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    typeof (value as ConnectorApproval).id !== 'string' ||
    !/^[a-f0-9]{16}$/.test((value as ConnectorApproval).id)
  )
    return null;
  if (
    typeof (value as ConnectorApproval).connector_name !== 'string' ||
    typeof (value as ConnectorApproval).tool_name !== 'string' ||
    typeof (value as ConnectorApproval).arguments_preview !== 'string'
  )
    return null;
  if (
    (value as ConnectorApproval).arguments_preview.length > 262144 ||
    typeof (value as ConnectorApproval).expires_at !== 'number' ||
    !Number.isFinite((value as ConnectorApproval).expires_at)
  )
    return null;
  return {
    id: (value as ConnectorApproval).id,
    connector_name: (value as ConnectorApproval).connector_name,
    tool_name: (value as ConnectorApproval).tool_name,
    arguments_preview: (value as ConnectorApproval).arguments_preview,
    expires_at: (value as ConnectorApproval).expires_at,
  };
}
