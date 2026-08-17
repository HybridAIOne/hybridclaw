import type { SessionSkillCatalogEntry } from '../types/container.js';
import type { Skill } from './skills.js';

/**
 * Project the session's eligible skills onto the routing identity the model
 * needs. The system prompt carries name/category/description/location only, so
 * declared credential ids are surfaced here as the `skills_list` recovery path.
 */
export function buildEligibleSkillCatalog(
  skills: readonly Skill[],
): SessionSkillCatalogEntry[] {
  return skills.map(({ name, description, category, location, manifest }) => {
    const requiredCredentials = (manifest?.requiredCredentials ?? []).map(
      (credential) => credential.id,
    );
    return {
      name,
      description,
      category,
      location,
      ...(requiredCredentials.length > 0 ? { requiredCredentials } : {}),
    };
  });
}
