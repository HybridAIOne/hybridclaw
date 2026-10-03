/**
 * The session catalog carries admitted routing metadata and complete mini-cards.
 * Unlike skill eligibility, this projection grants nothing; ordinary bodies
 * and credentials still require their existing access paths.
 */
import type { SessionSkillCatalogEntry } from '../types/container.js';
import { loadMiniSkillInstructions } from './mini-skills.js';
import type { Skill } from './skills.js';
export function buildEligibleSkillCatalog(
  skills: readonly Skill[],
): SessionSkillCatalogEntry[] {
  return skills.map((skill) => {
    const { name, description, category, location, manifest } = skill;
    const instructions = loadMiniSkillInstructions(skill);
    const requiredCredentials = (manifest?.requiredCredentials ?? []).map(
      (credential) => credential.id,
    );
    return {
      name,
      description,
      category,
      location,
      ...(instructions ? { instructions } : {}),
      ...(requiredCredentials.length > 0 ? { requiredCredentials } : {}),
    };
  });
}
