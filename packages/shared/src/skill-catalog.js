/**
 * Mini-skill text is complete bounded guidance, never executable authority.
 * The host and worker share this limit; ordinary skill bodies still use reads.
 */
// Engineering choice, 2026-10-03: cap dense cards at 1,000 characters;
// longer guides retain ordinary SKILL.md reads rather than partial instructions.
export const MAX_MINI_SKILL_CHARS = 1_000;

export function isMiniSkillInstructions(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_MINI_SKILL_CHARS
  );
}
