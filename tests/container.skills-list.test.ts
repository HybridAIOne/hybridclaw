import { beforeEach, expect, test } from 'vitest';
import { runSkillsList, setEligibleSkillsCatalog, setSkillDiscoveryTools, SKILLS_LIST_TOOL_DEFINITION } from '../container/src/tools/skills-list.js';
import type { ToolDefinition } from '../container/src/types.js';
const tools: ToolDefinition[] = ['skills_list', 'read', 'tool_catalog'].map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, required: [] } } }));
const skills = [
  { name: 'calendar', description: 'Manage calendar events.', category: 'productivity', location: 'skills/calendar/SKILL.md' },
  { name: 'pdf', description: 'Create, inspect, and edit PDF files.', category: 'office', location: 'skills/pdf/SKILL.md', requiredCredentials: ['pdf-service-token'] },
];
beforeEach(() => {
  setEligibleSkillsCatalog(skills);
  setSkillDiscoveryTools(tools.slice(0, 2), [tools[0], tools[2]]);
});
test('search returns summaries and a precise next call, not instructions or credentials', () => {
  const result = JSON.parse(runSkillsList({ query: 'create PDF' }));
  expect(SKILLS_LIST_TOOL_DEFINITION.function.name).toBe('skills_list');
  expect(result.skills).toEqual([{ name: 'pdf', description: skills[1].description, category: 'office', next: { name: 'skills_list', arguments: { name: 'pdf' } } }]);
  expect(result).toMatchObject({ matchCount: 1, eligibleCount: 2, nextOffset: null, truncated: false });
  expect(result.hint).toContain('no instructions');
  expect(JSON.stringify(result.skills)).not.toContain('SKILL.md');
  expect(JSON.stringify(result)).not.toContain('pdf-service-token');
});
test('exact selection returns metadata and the permitted wrapper to read instructions', () => {
  const result = JSON.parse(runSkillsList({ name: 'pdf' }));
  expect(result).toMatchObject({ skill: skills[1], instructionsLoaded: false, next: { name: 'tool_catalog', arguments: { action: 'call', name: 'read', arguments: { path: 'skills/pdf/SKILL.md' } } } });
  expect(result.hint).toContain('remaining pages');
});
test('adapts each next call to catalog-only and full modes', () => {
  setSkillDiscoveryTools(tools.slice(0, 2), [tools[2]]);
  expect(JSON.parse(runSkillsList({ query: 'PDF' })).skills[0].next).toEqual({ name: 'tool_catalog', arguments: { action: 'call', name: 'skills_list', arguments: { name: 'pdf' } } });
  setSkillDiscoveryTools(tools.slice(0, 2), tools.slice(0, 2));
  expect(JSON.parse(runSkillsList({ name: 'pdf' })).next).toEqual({ name: 'read', arguments: { path: skills[1].location } });
});
test('does not offer blocked reads or reads hidden when discovery is disabled', () => {
  setSkillDiscoveryTools([tools[0]], [tools[0], tools[2]]);
  expect(JSON.parse(runSkillsList({ name: 'pdf' })).next).toBeNull();
  setSkillDiscoveryTools(tools.slice(0, 2), [tools[0]]);
  expect(JSON.parse(runSkillsList({ name: 'pdf' })).next).toBeNull();
  expect(JSON.parse(runSkillsList({ name: 'pdf' })).instructionsLoaded).toBe(false);
});
test('resets eligibility and callable routing between pooled requests', () => {
  setEligibleSkillsCatalog([skills[0]]);
  expect(() => runSkillsList({ name: 'pdf' })).toThrow('not eligible');
  expect(JSON.parse(runSkillsList({ name: 'calendar' })).next).toBeNull();
  expect(JSON.stringify(JSON.parse(runSkillsList({})))).not.toContain('pdf');
});
test('paginates ranked summaries and supports category browsing and empty matches', () => {
  setEligibleSkillsCatalog(Array.from({ length: 25 }, (_, index) => ({ name: `skill-${index}`, description: 'A discoverable skill.'.repeat(40), category: 'test', location: `skills/skill-${index}/SKILL.md` })));
  const first = JSON.parse(runSkillsList({ limit: 5 }));
  const last = JSON.parse(runSkillsList({ offset: 20, category: 'test' }));
  expect(first).toMatchObject({ matchCount: 25, eligibleCount: 25, nextOffset: 5, truncated: true });
  expect(first.skills).toHaveLength(5);
  expect(first.skills[0].description).toHaveLength(160);
  expect(last.skills).toHaveLength(5);
  expect(last).toMatchObject({ nextOffset: null, truncated: false });
  const empty = JSON.parse(runSkillsList({ query: 'no-match-here' }));
  expect(empty.skills).toEqual([]);
  expect(empty.categories).toEqual(['test']);
  expect(empty.hint).toContain('shorter query');
});
test.each([{ name: '../secret' }, { name: 'disabled' }, { name: {} }, { query: [] }, { category: 1 }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }])('rejects unknown names and invalid directory inputs: %j', (args) => {
  expect(() => runSkillsList(args)).toThrow();
});
