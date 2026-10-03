/**
 * Mini-skills publish the whole short body or leave the ordinary read path.
 * Unlike eligibility/guard scanning, this only bounds already admitted text;
 * it never truncates an instruction card or grants tool permissions.
 */
import {
  isMiniSkillInstructions,
  MAX_MINI_SKILL_CHARS,
} from '../../container/shared/skill-catalog.js';
import { logger } from '../logger.js';
import { loadSkillBody, type Skill } from './skills.js';

export function loadMiniSkillInstructions(skill: Skill): string | undefined {
  if (!skill.mini || skill.disableModelInvocation) return undefined;
  const body = loadSkillBody(skill, MAX_MINI_SKILL_CHARS + 1);
  if (isMiniSkillInstructions(body)) return body;
  logger.warn(
    { skill: skill.name, maxChars: MAX_MINI_SKILL_CHARS },
    'Mini-skill body empty or oversized; use the SKILL.md read path',
  );
  return undefined;
}
