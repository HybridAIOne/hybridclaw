import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { MAX_MINI_SKILL_CHARS } from '../container/shared/skill-catalog.js';
import {
  runSkillsList,
  setEligibleSkillsCatalog,
  setSkillDiscoveryTools,
} from '../container/src/tools/skills-list.js';
import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import { buildEligibleSkillCatalog } from '../src/skills/skill-catalog.js';
import { parseSkillManifestFile } from '../src/skills/skill-manifest.js';
import type { Skill } from '../src/skills/skills.js';
import {
  buildSkillsPrompt,
  buildSkillsSection,
} from '../src/skills/skills-prompt.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-mini-skills-');

function makeSkill(body: string, overrides: Partial<Skill> = {}): Skill {
  const baseDir = makeTempDir();
  const filePath = path.join(baseDir, 'SKILL.md');
  fs.writeFileSync(filePath, `---\nname: route\nmini: true\n---\n\n${body}`);
  return {
    name: 'route',
    manifest: parseSkillManifestFile(filePath, { name: 'route' }),
    description: 'Travel routing',
    category: 'travel',
    filePath,
    baseDir,
    location: 'skills/route/SKILL.md',
    source: 'bundled',
    mini: true,
    always: false,
    disableModelInvocation: false,
    userInvocable: true,
    requires: { bins: [], env: [], nodeModules: [] },
    metadata: { hybridclaw: { tags: [], relatedSkills: [], install: [] } },
    ...overrides,
  };
}

test('the complete mini body survives host catalog, IPC and worker discovery without a read', () => {
  const body = 'https://example.com/search; fill origin+dest; verify date.';
  const skill = makeSkill(body);
  const catalog = JSON.parse(
    JSON.stringify(buildEligibleSkillCatalog([skill])),
  );
  setEligibleSkillsCatalog(catalog);
  setSkillDiscoveryTools([], []);
  const found = JSON.parse(runSkillsList({ query: 'travel' })).skills[0];
  expect(found).toMatchObject({
    instructions: body,
    instructionsLoaded: true,
    next: null,
  });
  const selected = JSON.parse(runSkillsList({ name: skill.name }));
  expect(selected).toMatchObject({
    skill: { instructions: body },
    instructionsLoaded: true,
    next: null,
  });
});

test.each(['xml', 'lines'] as const)(
  'mini cards are loaded and escaped in the %s prompt',
  (format) => {
    const skill = makeSkill('https://example.com/?a=1&b=2; <verify>');
    const prompt = buildSkillsSection([skill], format);
    expect(prompt).toContain(
      '<mini_skill name="route" instructions_loaded="true">',
    );
    expect(prompt).toContain('a=1&amp;b=2; &lt;verify&gt;');
    expect(prompt).not.toContain('<location>');
    expect(prompt).not.toContain('skills/route/SKILL.md');
  },
);

test('compact hooks keep metadata while discovery retains complete mini guidance', () => {
  const skill = makeSkill('https://example.com/search; verify date.');
  const context = {
    agentId: 'main',
    skills: [skill],
    includePromptParts: ['skills'] as const,
  };
  expect(buildSystemPromptFromHooks(context)).toContain('<mini_skill ');
  const compact = buildSystemPromptFromHooks({
    ...context,
    skillPromptMode: 'compact',
  });
  expect(compact).not.toContain('<mini_skill ');
  expect(compact).not.toContain('https://example.com/search');
  expect(compact).toContain(skill.name);
  setEligibleSkillsCatalog(buildEligibleSkillCatalog(context.skills));
  expect(
    JSON.parse(runSkillsList({ name: skill.name })).skill.instructions,
  ).toBeDefined();
});

test.each([0, MAX_MINI_SKILL_CHARS + 1])(
  'empty/oversized body (%i chars) stays metadata, never a partial loaded card',
  (length) => {
    const skill = makeSkill('x'.repeat(length));
    const [entry] = buildEligibleSkillCatalog([skill]);
    expect(entry).not.toHaveProperty('instructions');
    const prompt = buildSkillsPrompt([skill]);
    expect(prompt).not.toContain('<mini_skill');
    expect(prompt).toContain('<location>skills/route/SKILL.md</location>');
  },
);

test('accepts the exact card limit and keeps full-length ordinary bodies out of discovery', () => {
  expect(
    buildEligibleSkillCatalog([makeSkill('x'.repeat(MAX_MINI_SKILL_CHARS))])[0]
      .instructions,
  ).toHaveLength(MAX_MINI_SKILL_CHARS);
  expect(
    buildEligibleSkillCatalog([makeSkill('ordinary body', { mini: false })])[0],
  ).not.toHaveProperty('instructions');
});

test('model-disabled mini content is absent and removal resets the pooled worker catalog', () => {
  const skill = makeSkill('private instructions', {
    disableModelInvocation: true,
  });
  expect(buildSkillsPrompt([skill])).toBe('');
  expect(buildEligibleSkillCatalog([skill])[0]).not.toHaveProperty(
    'instructions',
  );
  setEligibleSkillsCatalog(
    buildEligibleSkillCatalog([makeSkill('complete guidance')]),
  );
  expect(JSON.parse(runSkillsList({ name: 'route' })).instructionsLoaded).toBe(
    true,
  );
  setEligibleSkillsCatalog([]);
  expect(JSON.parse(runSkillsList({})).skills).toEqual([]);
  expect(() => runSkillsList({ name: 'route' })).toThrow('not eligible');
});

test.each(['', ' '.repeat(10), 'x'.repeat(MAX_MINI_SKILL_CHARS + 1)])(
  'worker rejects invalid wire instructions rather than claiming them loaded',
  (instructions) => {
    setEligibleSkillsCatalog([
      {
        name: 'invalid',
        description: 'Invalid card',
        category: 'test',
        location: 'skills/invalid/SKILL.md',
        instructions,
      },
    ]);
    setSkillDiscoveryTools([], []);
    const selected = JSON.parse(runSkillsList({ name: 'invalid' }));
    expect(selected.instructionsLoaded).toBe(false);
    expect(selected.skill).not.toHaveProperty('instructions');
    expect(JSON.parse(runSkillsList({})).skills[0]).not.toHaveProperty(
      'instructions',
    );
  },
);

test('page and prompt budgets omit whole cards, with exact discovery recovering them', () => {
  const skills = Array.from({ length: 20 }, (_, i) =>
    makeSkill('x'.repeat(MAX_MINI_SKILL_CHARS), { name: `route-${i}` }),
  );
  const prompt = buildSkillsPrompt(skills);
  expect((prompt.match(/<mini_skill /g) || []).length).toBeLessThan(
    skills.length,
  );
  setEligibleSkillsCatalog(buildEligibleSkillCatalog(skills));
  setSkillDiscoveryTools([], []);
  const found = JSON.parse(runSkillsList({ limit: 100 })).skills;
  expect(
    found.filter(
      (entry: { instructionsLoaded?: boolean }) => entry.instructionsLoaded,
    ),
  ).toHaveLength(10);
  expect(found[10]).not.toHaveProperty('instructions');
  expect(
    JSON.parse(runSkillsList({ name: found[10].name })).skill.instructions,
  ).toHaveLength(MAX_MINI_SKILL_CHARS);
});

test('mini cards consume only the inline budget remaining after always skills', () => {
  const minis = Array.from({ length: 10 }, (_, i) =>
    makeSkill('x'.repeat(MAX_MINI_SKILL_CHARS), { name: `route-${i}` }),
  );
  const always = makeSkill('mandatory instructions', {
    name: 'mandatory',
    mini: false,
    always: true,
  });
  const prompt = buildSkillsPrompt([...minis, always]);
  expect(prompt.indexOf('<skill_always ')).toBeLessThan(
    prompt.indexOf('<mini_skill '),
  );
  expect(prompt).toContain('mandatory instructions');
});
