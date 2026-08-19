import type { SessionSkillCatalogEntry, ToolDefinition } from '../types.js';

let eligibleSkills: SessionSkillCatalogEntry[] = [];

export const SKILLS_LIST_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'skills_list',
    description:
      'List or search the complete eligible skill catalog for this agent session. Use this read-only recovery tool when the prompt catalog was compacted or a relevant skill is not visible there.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive search across skill name, category, and description.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 20, maximum 100).',
        },
      },
      required: [],
    },
  },
};

export function setEligibleSkillsCatalog(
  skills: readonly SessionSkillCatalogEntry[] | undefined,
): void {
  eligibleSkills = (skills || []).map((skill) => ({ ...skill }));
}

export function runSkillsList(args: Record<string, unknown>): string {
  const query =
    typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(100, Math.floor(args.limit)))
      : 20;
  const matches = eligibleSkills.filter((skill) => {
    if (!query) return true;
    return [skill.name, skill.category, skill.description].some((value) =>
      value.toLowerCase().includes(query),
    );
  });

  return JSON.stringify(
    {
      skills: matches.slice(0, limit),
      matchCount: matches.length,
      eligibleCount: eligibleSkills.length,
      truncated: matches.length > limit,
    },
    null,
    2,
  );
}
