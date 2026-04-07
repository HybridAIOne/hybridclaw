import { normalizeLower } from './normalize.js';

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

  const localPart = normalizeLower(handle) || normalizeLower(agentId);
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
  const normalized = normalizeLower(toAddress);
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) return null;

  const localPart = normalized.slice(0, atIndex);
  const emailDomain = normalized.slice(atIndex + 1);
  if (emailDomain !== normalizeLower(domain)) return null;

  if (agentHandles && typeof agentHandles === 'object') {
    for (const [agentId, rawHandle] of Object.entries(agentHandles)) {
      const configuredHandle = normalizeLower(rawHandle);
      if (!configuredHandle) continue;
      if (configuredHandle === localPart) {
        return normalizeLower(agentId) || null;
      }
    }
  }

  return localPart || null;
}
