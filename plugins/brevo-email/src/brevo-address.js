/**
 * Resolve the email address for an agent.
 *
 * Uses the custom override if provided, otherwise falls back to
 * `{handleOrAgentId}@{domain}`.
 *
 * @param {string} agentId
 * @param {string} domain
 * @param {string | null | undefined} [override]
 * @param {string | null | undefined} [handle]
 * @returns {string}
 */
export function resolveAgentEmailAddress(agentId, domain, override, handle) {
  const custom = String(override || '').trim();
  if (custom) return custom;

  const localPart =
    String(handle || '')
      .trim()
      .toLowerCase() ||
    String(agentId || '')
      .trim()
      .toLowerCase();
  return `${localPart}@${domain}`;
}

/**
 * Derive the target agent ID from a recipient email address.
 *
 * Returns `null` when the address does not belong to the configured domain.
 *
 * @param {string} toAddress
 * @param {string} domain
 * @param {Record<string, string> | null | undefined} [agentHandles]
 * @returns {string | null}
 */
export function resolveAgentIdFromRecipient(toAddress, domain, agentHandles) {
  const normalized = String(toAddress || '')
    .trim()
    .toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) return null;

  const localPart = normalized.slice(0, atIndex);
  const emailDomain = normalized.slice(atIndex + 1);
  if (emailDomain !== domain.toLowerCase()) return null;

  if (agentHandles && typeof agentHandles === 'object') {
    for (const [agentId, rawHandle] of Object.entries(agentHandles)) {
      const configuredHandle = String(rawHandle || '')
        .trim()
        .toLowerCase();
      if (!configuredHandle) continue;
      if (configuredHandle === localPart) {
        return (
          String(agentId || '')
            .trim()
            .toLowerCase() || null
        );
      }
    }
  }

  return localPart || null;
}
