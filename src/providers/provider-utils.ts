import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';

/**
 * Returns a function that checks whether a model string starts with the given
 * provider prefix (case-insensitive, trimmed).
 */
export function createModelMatcher(prefix: string): (model: string) => boolean {
  const normalizedPrefix = String(prefix || '')
    .trim()
    .toLowerCase();
  return (model: string): boolean =>
    String(model || '')
      .trim()
      .toLowerCase()
      .startsWith(normalizedPrefix);
}

/**
 * Normalizes a raw agentId value, falling back to DEFAULT_AGENT_ID.
 */
export function normalizeAgentId(raw: string | undefined | null): string {
  return String(raw || '').trim() || DEFAULT_AGENT_ID;
}
