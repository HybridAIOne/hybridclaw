/** Connector approval IDs namespace the platform's one-shot grant in chat. */

/** Shared wire contract for platform-owned, one-shot connector approvals. */
export interface ConnectorApproval {
  id: string;
  connector_name: string;
  tool_name: string;
  arguments_preview: string;
  expires_at: number;
}

export const CONNECTOR_APPROVAL_META = 'hybridai/approval';
export const CONNECTOR_APPROVAL_REQUIRED_META = 'hybridai/approvalRequired';
export const CONNECTOR_APPROVAL_CONTEXT_META = 'hybridai/approvalContext';
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
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^[a-f0-9]{16}$/.test(record.id))
    return null;
  if (
    typeof record.connector_name !== 'string' ||
    typeof record.tool_name !== 'string' ||
    typeof record.arguments_preview !== 'string'
  )
    return null;
  if (
    record.arguments_preview.length > 262144 ||
    typeof record.expires_at !== 'number' ||
    !Number.isFinite(record.expires_at)
  )
    return null;
  return {
    id: record.id,
    connector_name: record.connector_name,
    tool_name: record.tool_name,
    arguments_preview: record.arguments_preview,
    expires_at: record.expires_at,
  };
}
