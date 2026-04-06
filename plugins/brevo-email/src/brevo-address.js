/**
 * Resolve the email address for an agent.
 *
 * Uses the custom override if provided, otherwise falls back to
 * `{agentId}@{domain}`.
 *
 * @param {string} agentId
 * @param {string} domain
 * @param {string | null | undefined} [override]
 * @returns {string}
 */
export function resolveAgentEmailAddress(agentId, domain, override) {
  const custom = String(override || '').trim();
  if (custom) return custom;
  return `${agentId}@${domain}`;
}

/**
 * Derive the target agent ID from a recipient email address.
 *
 * Returns `null` when the address does not belong to the configured domain.
 *
 * @param {string} toAddress
 * @param {string} domain
 * @returns {string | null}
 */
export function resolveAgentIdFromRecipient(toAddress, domain) {
  const normalized = String(toAddress || '')
    .trim()
    .toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) return null;

  const localPart = normalized.slice(0, atIndex);
  const emailDomain = normalized.slice(atIndex + 1);
  if (emailDomain !== domain.toLowerCase()) return null;

  return localPart || null;
}
