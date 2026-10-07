import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_DISABLED_SKILLS } from '../src/config/cloud-defaults.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-config-seed-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

let dataDir: string;

beforeEach(() => {
  dataDir = makeTempDir();
  vi.stubEnv('HOME', dataDir);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
});

async function importSeed() {
  vi.resetModules();
  const seed = await import('../src/config/config-seed.js');
  const runtimeConfig = await import('../src/config/runtime-config.js');
  return { ...seed, ...runtimeConfig };
}

function writeDemoPlugin(): string {
  const sourceDir = path.join(makeTempDir(), 'demo-plugin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'hybridclaw.plugin.yaml'),
    'id: demo-plugin\nname: Demo Plugin\nversion: 1.0.0\nkind: tool\n',
  );
  fs.writeFileSync(path.join(sourceDir, 'index.js'), 'export default {};\n');
  return sourceDir;
}

const CLOUD_SEED = {
  set: {
    'deployment.mode': 'cloud',
    'deployment.public_url': 'https://agent.example.com',
  },
  disabledTools: ['web_search'],
  disabledSkills: ['search.web'],
};

describe('config seed', () => {
  it.each([
    ['invalid JSON', '{'],
    ['a non-object', '[]'],
    ['an unknown key', '{"enable": {}}'],
    ['a non-object set', '{"set": []}'],
    ['a non-array name list', '{"disabledTools": "web_search"}'],
    ['an empty name', '{"plugins": [""]}'],
    ['invalid plugin config', '{"pluginConfig": {"demo-plugin": []}}'],
  ])('rejects %s', async (_label, raw) => {
    const { parseConfigSeed } = await importSeed();
    expect(() => parseConfigSeed(raw)).toThrow(/HYBRIDCLAW_CONFIG_SEED/);
  });

  it('applies config keys, tool and skill disables, and plugins', async () => {
    const pluginSource = writeDemoPlugin();
    const {
      applyConfigSeed,
      getRuntimeConfig,
      getRuntimeDisabledToolNames,
      getRuntimeSkillScopeDisabledNames,
    } = await importSeed();

    await applyConfigSeed({ ...CLOUD_SEED, plugins: [pluginSource] });

    const config = getRuntimeConfig();
    expect(config.deployment).toMatchObject({
      mode: 'cloud',
      public_url: 'https://agent.example.com',
    });
    expect(getRuntimeDisabledToolNames(config)).toContain('web_search');
    expect(getRuntimeSkillScopeDisabledNames(config)).toContain('search.web');
    expect(
      fs.existsSync(
        path.join(dataDir, 'plugins', 'demo-plugin', 'hybridclaw.plugin.yaml'),
      ),
    ).toBe(true);
  });

  it('writes nothing when the config already matches and keeps user choices', async () => {
    const {
      applyConfigSeed,
      getRuntimeConfig,
      getRuntimeDisabledToolNames,
      runtimeConfigPath,
      setRuntimeToolEnabled,
      updateRuntimeConfig,
    } = await importSeed();
    const seed = { ...CLOUD_SEED, plugins: [] };
    await applyConfigSeed(seed);
    updateRuntimeConfig((draft) => {
      setRuntimeToolEnabled(draft, 'browser_navigate', false);
    });
    const before = fs.readFileSync(runtimeConfigPath(), 'utf-8');

    await applyConfigSeed(seed);

    expect(fs.readFileSync(runtimeConfigPath(), 'utf-8')).toBe(before);
    expect(getRuntimeDisabledToolNames(getRuntimeConfig())).toEqual(
      new Set(['browser_navigate', 'web_search']),
    );
  });

  const NO_OP_SEED = {
    set: { 'deployment.mode': 'cloud' },
    disabledTools: [],
    disabledSkills: [],
    plugins: [],
  };

  it.each([
    [
      'an unknown config key',
      { ...NO_OP_SEED, set: { ...NO_OP_SEED.set, 'deployment.nope': true } },
    ],
    ['an unknown tool', { ...NO_OP_SEED, disabledTools: ['no_such_tool'] }],
  ])('fails on %s before writing anything', async (_label, seed) => {
    const { applyConfigSeed, getRuntimeConfig } = await importSeed();
    const before = JSON.stringify(getRuntimeConfig());

    await expect(applyConfigSeed(seed)).rejects.toThrow();
    expect(JSON.stringify(getRuntimeConfig())).toBe(before);
  });

  it('reads the seed from the environment', async () => {
    vi.stubEnv('HYBRIDCLAW_CONFIG_SEED', JSON.stringify(CLOUD_SEED));
    const { applyConfigSeedFromEnv, getRuntimeConfig } = await importSeed();

    await applyConfigSeedFromEnv();

    expect(getRuntimeConfig().deployment.mode).toBe('cloud');
  });
});
it('excludes host and LAN skills from cloud catalogs while retaining cloud APIs', async () => {
  const {
    applyConfigSeed,
    getRuntimeConfig,
    getRuntimeSkillScopeDisabledNames,
  } = await importSeed();
  await applyConfigSeed({ ...CLOUD_SEED, plugins: [] });
  const disabled = getRuntimeSkillScopeDisabledNames(getRuntimeConfig());
  for (const name of CLOUD_DISABLED_SKILLS) expect(disabled).toContain(name);
  for (const name of ['hue', 'shelly', 'fronius', 'microsoft-365', 'pdf']) {
    expect(disabled).not.toContain(name);
  }
  const { loadSkills } = await import('../src/skills/skills.js');
  const names = loadSkills('main').map((skill) => skill.name);
  for (const name of CLOUD_DISABLED_SKILLS) expect(names).not.toContain(name);
});

it('leaves local deployment skill choices intact', async () => {
  const {
    applyConfigSeed,
    getRuntimeConfig,
    getRuntimeSkillScopeDisabledNames,
  } = await importSeed();
  await applyConfigSeed({
    set: { 'deployment.mode': 'local' },
    disabledTools: [],
    disabledSkills: [],
    plugins: [],
  });
  const disabled = getRuntimeSkillScopeDisabledNames(getRuntimeConfig());
  for (const name of CLOUD_DISABLED_SKILLS) expect(disabled).not.toContain(name);
});

it('seeds installed plugin config while preserving other plugins and choices', async () => {
  const source = writeDemoPlugin();
  const { applyConfigSeed, getRuntimeConfig, updateRuntimeConfig } =
    await importSeed();
  await applyConfigSeed({
    set: {},
    disabledTools: [],
    disabledSkills: [],
    plugins: [source],
    pluginConfig: { 'demo-plugin': { ownerUserId: 'alice' } },
  });
  expect(
    getRuntimeConfig().plugins.list.find((entry) => entry.id === 'demo-plugin')
      ?.config,
  ).toEqual({ ownerUserId: 'alice' });
  updateRuntimeConfig((draft) => {
    draft.plugins.list.find(
      (entry) => entry.id === 'demo-plugin',
    )!.config.custom = true;
  });
  await applyConfigSeed({
    set: {},
    disabledTools: [],
    disabledSkills: [],
    plugins: [],
    pluginConfig: { 'demo-plugin': { ownerUserId: 'alice' } },
  });
  expect(
    getRuntimeConfig().plugins.list.find((entry) => entry.id === 'demo-plugin')
      ?.config,
  ).toEqual({ ownerUserId: 'alice', custom: true });
  await expect(
    applyConfigSeed({
      set: {},
      disabledTools: [],
      disabledSkills: [],
      plugins: [],
      pluginConfig: { missing: {} },
    }),
  ).rejects.toThrow(/not installed/);
});
