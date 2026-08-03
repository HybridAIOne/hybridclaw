import { expect, test } from 'vitest';

import {
  runSkillsList,
  setEligibleSkillsCatalog,
  SKILLS_LIST_TOOL_DEFINITION,
} from '../container/src/tools/skills-list.js';

test('skills_list searches the complete eligible session catalog', () => {
  setEligibleSkillsCatalog([
    {
      name: 'calendar',
      description: 'Manage calendar events.',
      category: 'productivity',
      location: 'skills/calendar/SKILL.md',
    },
    {
      name: 'pdf',
      description: 'Create, inspect, and edit PDF files.',
      category: 'office',
      location: 'skills/pdf/SKILL.md',
    },
  ]);

  const result = JSON.parse(runSkillsList({ query: 'PDF' })) as {
    skills: Array<{ name: string; location: string }>;
    matchCount: number;
    eligibleCount: number;
    truncated: boolean;
  };

  expect(SKILLS_LIST_TOOL_DEFINITION.function.name).toBe('skills_list');
  expect(result.skills).toEqual([
    {
      name: 'pdf',
      description: 'Create, inspect, and edit PDF files.',
      category: 'office',
      location: 'skills/pdf/SKILL.md',
    },
  ]);
  expect(result.matchCount).toBe(1);
  expect(result.eligibleCount).toBe(2);
  expect(result.truncated).toBe(false);
});

test('skills_list limits output without losing complete-catalog counts', () => {
  setEligibleSkillsCatalog(
    Array.from({ length: 25 }, (_, index) => ({
      name: `skill-${index}`,
      description: 'A discoverable skill.',
      category: 'test',
      location: `skills/skill-${index}/SKILL.md`,
    })),
  );

  const result = JSON.parse(runSkillsList({ limit: 5 })) as {
    skills: unknown[];
    matchCount: number;
    eligibleCount: number;
    truncated: boolean;
  };

  expect(result.skills).toHaveLength(5);
  expect(result.matchCount).toBe(25);
  expect(result.eligibleCount).toBe(25);
  expect(result.truncated).toBe(true);
});
