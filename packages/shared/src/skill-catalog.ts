/**
 * Mini-skill admission shared by host and worker: the size limit and the
 * check a catalog entry's instructions must pass. The entry shape is wire
 * data (`@hybridclaw/contracts/skill-catalog`).
 */
/**
 * Mini-skill text is complete bounded guidance, never executable authority.
 * The host and worker share this limit; ordinary skill bodies still use reads.
 */
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
