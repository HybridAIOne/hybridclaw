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
