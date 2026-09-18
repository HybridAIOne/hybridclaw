/**
 * Local skill stars trim only the initial prompt, never the eligible catalog.
 * Mandatory always-on skills remain present; skills_list retains the full
 * permitted directory. This does not replace skill trust or agent allowlists.
 */
import { getRuntimeConfig } from '../config/runtime-config.js';
import { resolveModelProvider } from '../providers/factory.js';
import { isLocalBackendType } from '../providers/provider-ids.js';
import type { Skill } from '../skills/skills.js';

export function selectLocalPromptSkills(
  skills: Skill[],
  agentId: string,
  model?: string,
): { skills: Skill[]; discovery: boolean } {
  const config = getRuntimeConfig();
  const agent = config.agents.list?.find((entry) => entry.id === agentId);
  const mode = agent?.localSkillMode ?? config.skills.localSkillMode ?? 'full';
  if (
    mode !== 'starred' ||
    !model ||
    !isLocalBackendType(resolveModelProvider(model))
  )
    return { skills, discovery: false };
  const starred = new Set(
    agent?.localStarterSkills ?? config.skills.localStarterSkills ?? [],
  );
  return {
    skills: skills.filter((skill) => skill.always || starred.has(skill.name)),
    discovery: true,
  };
}
