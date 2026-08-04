import type { SkillCatalogEntry } from '../types/container.js';
import type { Skill } from './skills.js';

export function buildEligibleSkillCatalog(
  skills: readonly Skill[],
): SkillCatalogEntry[] {
  return skills.map(({ name, description, category, location }) => ({
    name,
    description,
    category,
    location,
  }));
}
