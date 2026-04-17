import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function writeSkill(
  root: string,
  relativePath: string,
  frontmatter: Record<string, string>,
  body: string,
): string {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const front = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  fs.writeFileSync(full, `---\n${front}\n---\n${body}`, 'utf-8');
  return full;
}

test('skill-locator finds SKILL.md under skills/, community-skills/, and plugins/', async () => {
  const repo = makeTempDir('hybridclaw-skill-evolver-repo-');

  writeSkill(
    repo,
    'skills/alpha/SKILL.md',
    { name: 'alpha', description: 'first skill' },
    '# Alpha\n\nDo alpha things.',
  );
  writeSkill(
    repo,
    'community-skills/beta/SKILL.md',
    { name: 'beta', description: 'second skill' },
    '# Beta\n\nDo beta things.',
  );
  writeSkill(
    repo,
    'plugins/some-plugin/skills/gamma/SKILL.md',
    { name: 'gamma', description: 'third skill' },
    '# Gamma\n\nDo gamma things.',
  );

  const { findSkill, listAllSkills, loadSkill } = await import(
    '../plugins/skill-evolver/src/skill-locator.js'
  );

  const all = listAllSkills(repo);
  expect(all.map((skill: { name: string }) => skill.name).sort()).toEqual([
    'alpha',
    'beta',
    'gamma',
  ]);

  const alphaPath = findSkill('alpha', repo);
  expect(alphaPath).toBeTruthy();
  const parsed = loadSkill(alphaPath!);
  expect(parsed.name).toBe('alpha');
  expect(parsed.description).toBe('first skill');
  expect(parsed.body.startsWith('# Alpha')).toBe(true);
});

test('skill-locator returns null for missing skills', async () => {
  const repo = makeTempDir('hybridclaw-skill-evolver-missing-');
  fs.mkdirSync(path.join(repo, 'skills'), { recursive: true });
  const { findSkill } = await import(
    '../plugins/skill-evolver/src/skill-locator.js'
  );
  expect(findSkill('nonexistent', repo)).toBeNull();
});

test('plugin default export registers a command and tools', async () => {
  const plugin = (
    await import('../plugins/skill-evolver/src/index.js')
  ).default;

  const commands: Array<{ name: string }> = [];
  const tools: Array<{ name: string }> = [];
  const api = {
    pluginConfig: {},
    logger: { info: () => undefined, warn: () => undefined },
    registerCommand: (spec: { name: string }) => commands.push(spec),
    registerTool: (spec: { name: string }) => tools.push(spec),
  } as unknown as Parameters<typeof plugin.register>[0];

  plugin.register(api);

  expect(commands.map((c) => c.name)).toContain('skill-evolver');
  expect(tools.map((t) => t.name).sort()).toEqual([
    'skill_evolver_extract',
    'skill_evolver_list',
  ]);
});
