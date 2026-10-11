/**
 * Mini-skill text is complete bounded guidance, never executable authority.
 * The host and worker share this limit; ordinary skill bodies still use reads.
 */

/**
 * Shared host/worker skill catalog: admitted identities and complete mini-cards.
 * Ordinary instructions and credentials retain their existing access paths;
 * this wire contract carries guidance, never capabilities or permissions.
 */
export interface SessionSkillCatalogEntry {
  name: string;
  description: string;
  category: string;
  location: string;
  /** Complete mini-skill body, already admitted by the host's skill filters. */
  instructions?: string;
  /** Credential ids the skill declares; omitted when it declares none. */
  requiredCredentials?: string[];
}

// Engineering choice, 2026-10-03: cap dense cards at 1,000 characters;
// longer guides retain ordinary SKILL.md reads rather than partial instructions.
export const MAX_MINI_SKILL_CHARS: number = 1_000;

export function isMiniSkillInstructions(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_MINI_SKILL_CHARS
  );
}
