/**
 * Skill discovery exposes eligible metadata in stages, then proposes a read.
 * Unlike the file tool it never opens files or grants read access. Its next
 * call uses the current request's exposed functions and permission snapshot.
 */
import { searchCatalog } from '../catalog-search.js';
import type { SessionSkillCatalogEntry, ToolDefinition } from '../types.js';

let eligibleSkills: SessionSkillCatalogEntry[] = [];
let availableNames = new Set<string>();
let exposedNames = new Set<string>();

export const SKILLS_LIST_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'skills_list',
    description:
      'Discover eligible skills in steps: search short summaries with query/category, then supply an exact name for details and the next call to read its SKILL.md. Skills are instructions, not executable tools. Follow the returned read call before using a skill. Empty arguments browse summaries; offset retrieves another page.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing the task.' },
        category: {
          type: 'string',
          description: 'Optional exact category from the directory.',
        },
        name: {
          type: 'string',
          description:
            'Exact skill name to get details and its next read call; omit while searching.',
        },
        offset: {
          type: 'integer',
          description: 'Search page offset, default 0.',
        },
        limit: {
          type: 'integer',
          description: 'Results per page, default 10.',
        },
      },
      required: [],
    },
  },
};

export function setEligibleSkillsCatalog(
  skills: readonly SessionSkillCatalogEntry[] | undefined,
): void {
  eligibleSkills = (skills || []).map((skill) => ({
    ...skill,
    ...(skill.requiredCredentials
      ? { requiredCredentials: [...skill.requiredCredentials] }
      : {}),
  }));
  availableNames.clear();
  exposedNames.clear();
}

export function setSkillDiscoveryTools(
  available: ToolDefinition[],
  exposed: ToolDefinition[],
): void {
  availableNames = new Set(available.map((tool) => tool.function.name));
  exposedNames = new Set(exposed.map((tool) => tool.function.name));
}

function nextCall(name: string, args: Record<string, unknown>): object | null {
  if (!availableNames.has(name)) return null;
  if (exposedNames.has(name)) return { name, arguments: args };
  return exposedNames.has('tool_catalog')
    ? {
        name: 'tool_catalog',
        arguments: { action: 'call', name, arguments: args },
      }
    : null;
}

export function runSkillsList(args: Record<string, unknown>): string {
  for (const key of ['query', 'category', 'name']) {
    if (args[key] !== undefined && typeof args[key] !== 'string')
      throw new Error(`Skill directory ${key} must be a string.`);
  }
  if (args.name !== undefined) {
    const skill = eligibleSkills.find((entry) => entry.name === args.name);
    if (!skill)
      throw new Error(
        'Skill is not eligible in this request. Search skills_list for an exact name.',
      );
    const next = nextCall('read', { path: skill.location });
    return JSON.stringify({
      skill,
      instructionsLoaded: false,
      next,
      hint: next
        ? 'Execute next to read the SKILL.md instructions. Read any remaining pages before following them; then load only linked files needed for the task. A skill name is not a tool name.'
        : 'The read tool is not available through the exposed functions. These are metadata only; the skill instructions have not been loaded.',
    });
  }
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 10;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Skill directory offset must be a non-negative integer.');
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('Skill directory limit must be an integer from 1 to 100.');
  const query = typeof args.query === 'string' ? args.query : '';
  const category =
    typeof args.category === 'string' ? args.category.trim().toLowerCase() : '';
  const matches = searchCatalog(
    eligibleSkills.filter(
      (skill) => !category || skill.category.toLowerCase() === category,
    ),
    query,
    (skill) => ({ ...skill, keywords: skill.category }),
  );
  const categories = [
    ...new Set(eligibleSkills.map((skill) => skill.category)),
  ].sort();
  const page = matches.slice(offset, offset + limit);
  return JSON.stringify({
    skills: page.map(({ name, description, category }) => ({
      name,
      description: description.slice(0, 160),
      category,
      next: nextCall('skills_list', { name }),
    })),
    categories,
    matchCount: matches.length,
    eligibleCount: eligibleSkills.length,
    truncated: offset + page.length < matches.length,
    nextOffset:
      offset + page.length < matches.length ? offset + page.length : null,
    hint: matches.length
      ? 'Choose the relevant skill and execute its next call for details and the SKILL.md read step. Search results contain no instructions.'
      : 'No keyword matches. Try a shorter query, browse a category, or omit query to browse the eligible catalog.',
  });
}
