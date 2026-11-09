/** Connector approval IDs namespace the platform's one-shot grant in chat. */
export const CONNECTOR_APPROVAL_META = 'hybridai/approval';
export const CONNECTOR_APPROVAL_REQUIRED_META = 'hybridai/approvalRequired';
export const CONNECTOR_APPROVAL_CONTEXT_META = 'hybridai/approvalContext';
export function connectorApprovalId(id) {
  if (!/^[a-f0-9]{16}$/.test(id))
    throw new Error('Invalid connector approval ID.');
  return `cc-${id}`;
}
export function platformApprovalId(id) {
  return /^cc-[a-f0-9]{16}$/.test(id) ? id.slice(3) : null;
}
export function parseConnectorApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || !/^[a-f0-9]{16}$/.test(value.id))
    return null;
  if (
    typeof value.connector_name !== 'string' ||
    typeof value.tool_name !== 'string' ||
    typeof value.arguments_preview !== 'string'
  )
    return null;
  if (
    value.arguments_preview.length > 262144 ||
    typeof value.expires_at !== 'number' ||
    !Number.isFinite(value.expires_at)
  )
    return null;
  return {
    id: value.id,
    connector_name: value.connector_name,
    tool_name: value.tool_name,
    arguments_preview: value.arguments_preview,
    expires_at: value.expires_at,
  };
}
