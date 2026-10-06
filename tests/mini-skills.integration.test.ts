import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { loadIsolatedSkillsRuntime } from './helpers/skills-workspace-runtime.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-mini-integration-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../src/infra/install-root.js'],
});

test('mini frontmatter uses existing discovery, channel and disabled-skill eligibility', async () => {
  const runtime = await loadIsolatedSkillsRuntime(makeTempDir());
  const file = path.join(runtime.bundledDir, 'route', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    '---\nname: route\ndescription: Travel routing\nmini: true\nsupported_channels: [web]\n---\n\nhttps://example.com; verify date.',
  );
  const { buildEligibleSkillCatalog } = await import(
    '../src/skills/skill-catalog.js'
  );
  const loaded = runtime.skills.loadSkills('main', 'web');
  expect(loaded).toHaveLength(1);
  expect(loaded[0].mini).toBe(true);
  expect(buildEligibleSkillCatalog(loaded)[0].instructions).toBeDefined();
  expect(runtime.skills.loadSkills('main', 'discord')).toEqual([]);
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  updateRuntimeConfig((draft) => {
    draft.skills.disabled = ['route'];
  });
  expect(
    buildEligibleSkillCatalog(runtime.skills.loadSkills('main', 'web')),
  ).toEqual([]);
});

test('bundled Booking workflow reaches the mobile prompt and worker catalog inline', async () => {
  const runtime = await loadIsolatedSkillsRuntime(makeTempDir());
  const file = path.join(runtime.bundledDir, 'booking', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(new URL('../skills/booking/SKILL.md', import.meta.url), file);
  const loaded = runtime.skills.loadSkills('main', 'web');
  const { buildEligibleSkillCatalog } = await import(
    '../src/skills/skill-catalog.js'
  );
  const { buildSystemPromptFromHooks } = await import(
    '../src/agent/prompt-hooks.js'
  );
  const catalog = JSON.parse(JSON.stringify(buildEligibleSkillCatalog(loaded)));
  expect(catalog).toHaveLength(1);
  expect(catalog[0].name).toBe('booking');
  expect(catalog[0].instructions).toContain('Booking→browser_navigate');
  const prompt = buildSystemPromptFromHooks({
    agentId: 'main',
    skills: loaded,
    runtimeInfo: { client: 'mobile', channelType: 'web' },
  });
  expect(prompt).toContain(
    '<mini_skill name="booking" instructions_loaded="true">',
  );
  expect(prompt).toContain('Keep -1.');
});
