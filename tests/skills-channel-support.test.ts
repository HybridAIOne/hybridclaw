import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

import { loadIsolatedSkillsRuntime } from './helpers/skills-workspace-runtime.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-skills-channel-support-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../src/infra/install-root.js'],
});

async function createRuntime() {
  const runtime = await loadIsolatedSkillsRuntime(makeTempDir());
  for (const [name, channels] of [
    ['default-skill', ''],
    ['threema-only', 'supported_channels: [threema]'],
    ['slack-only', 'supported_channels: [slack]'],
  ]) {
    const skillFile = path.join(runtime.bundledDir, name, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(
      skillFile,
      `---\nname: ${name}\ndescription: Test skill\n${channels}\n---\n\nUse the skill.\n`,
    );
  }
  return runtime;
}

test('loadSkills loads default and explicitly supported skills for Threema', async () => {
  const { skills, workspaceDir } = await createRuntime();

  expect(skills.loadSkills('main', 'threema').map((skill) => skill.name)).toEqual([
    'default-skill',
    'threema-only',
  ]);
  expect(
    fs.existsSync(path.join(workspaceDir, 'skills', 'default-skill', 'SKILL.md')),
  ).toBe(true);
  expect(skills.loadSkills('main', 'slack').map((skill) => skill.name)).toEqual([
    'default-skill',
    'slack-only',
  ]);
});

test('iMessage skill disabling persists and affects only iMessage', async () => {
  const { skills } = await createRuntime();
  const config = await import('../src/config/runtime-config.js');
  config.ensureRuntimeConfigFile();
  config.updateRuntimeConfig((draft) => {
    draft.skills.channelDisabled = { imessage: ['default-skill'] };
  });

  expect(config.getRuntimeConfig().skills.channelDisabled?.imessage).toEqual([
    'default-skill',
  ]);
  expect(skills.loadSkills('main', 'imessage')).toEqual([]);
  expect(skills.loadSkills('main', 'threema').map((skill) => skill.name)).toContain(
    'default-skill',
  );
});
