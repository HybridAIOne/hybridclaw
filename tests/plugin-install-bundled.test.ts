import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useTempDir } from './test-utils.js';

// A bundled plugin with nothing to install is enabled in place, so upgrading
// HybridClaw upgrades it too; a home copy left by an older install shadows
// the bundled one until `plugin reinstall` replaces it with the reference.
const makeTempDir = useTempDir('hybridclaw-plugin-bundled-');
const BUNDLED_DISTILL_DIR = path.resolve('plugins', 'distill');

function runtimeConfigState() {
  let config = { plugins: { list: [] } } as unknown as RuntimeConfig;
  return {
    current: () => config,
    getRuntimeConfig: () => structuredClone(config),
    updateRuntimeConfig: (mutator: (draft: RuntimeConfig) => void) => {
      const draft = structuredClone(config);
      mutator(draft);
      config = draft;
      return structuredClone(config);
    },
  };
}

async function discoveredDistillDir(
  homeDir: string,
  cwd: string,
  state: ReturnType<typeof runtimeConfigState>,
): Promise<string | undefined> {
  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: state.getRuntimeConfig,
  });
  return (await manager.discoverPlugins()).find(
    (candidate) => candidate.id === 'distill',
  )?.dir;
}

test('installing a bundled plugin by id enables the packaged copy instead of copying it', async () => {
  const homeDir = makeTempDir();
  const cwd = makeTempDir();
  const state = runtimeConfigState();
  const { installPlugin, uninstallPlugin } = await import(
    '../src/plugins/plugin-install.js'
  );

  const first = await installPlugin('distill', { homeDir, cwd, ...state });
  expect(first).toMatchObject({
    pluginId: 'distill',
    pluginDir: BUNDLED_DISTILL_DIR,
    alreadyInstalled: false,
    enabledInPlace: true,
  });
  expect(fs.existsSync(path.join(homeDir, 'plugins', 'distill'))).toBe(false);
  expect(state.current().plugins.list).toEqual([
    { id: 'distill', enabled: true, config: {} },
  ]);
  expect(await discoveredDistillDir(homeDir, cwd, state)).toBe(
    BUNDLED_DISTILL_DIR,
  );

  const again = await installPlugin(BUNDLED_DISTILL_DIR, {
    homeDir,
    cwd,
    ...state,
  });
  expect(again).toMatchObject({
    pluginDir: BUNDLED_DISTILL_DIR,
    alreadyInstalled: true,
  });

  await uninstallPlugin('distill', { homeDir, ...state });
  expect(state.current().plugins.list).toEqual([]);
  expect(fs.existsSync(path.join(BUNDLED_DISTILL_DIR, 'src', 'index.js'))).toBe(
    true,
  );
  expect(await discoveredDistillDir(homeDir, cwd, state)).toBeUndefined();
});

test('a stale home copy from an older release is replaced by the bundled reference on reinstall', async () => {
  const homeDir = makeTempDir();
  const cwd = makeTempDir();
  const state = runtimeConfigState();
  const homeCopy = path.join(homeDir, 'plugins', 'distill');
  fs.cpSync(BUNDLED_DISTILL_DIR, homeCopy, { recursive: true });
  const manifestPath = path.join(homeCopy, 'hybridclaw.plugin.yaml');
  fs.writeFileSync(
    manifestPath,
    fs
      .readFileSync(manifestPath, 'utf-8')
      .replace(/^version: .*$/m, 'version: 0.0.1'),
  );
  expect(await discoveredDistillDir(homeDir, cwd, state)).toBe(homeCopy);

  const { installPlugin, reinstallPlugin } = await import(
    '../src/plugins/plugin-install.js'
  );
  await expect(
    installPlugin('distill', { homeDir, cwd, ...state }),
  ).rejects.toThrow(/plugin reinstall distill/);
  expect(fs.existsSync(homeCopy)).toBe(true);

  const result = await reinstallPlugin('distill', { homeDir, cwd, ...state });
  expect(result).toMatchObject({
    pluginDir: BUNDLED_DISTILL_DIR,
    replacedExistingInstall: true,
    enabledInPlace: true,
  });
  expect(fs.existsSync(homeCopy)).toBe(false);
  expect(await discoveredDistillDir(homeDir, cwd, state)).toBe(
    BUNDLED_DISTILL_DIR,
  );
});

// Running the install from a source checkout (or any directory with its own
// `plugins/distill`) must still enable the package's copy in place.
test('a bare id resolves to the bundled plugin even when the cwd has plugins/<id>', async () => {
  const homeDir = makeTempDir();
  const cwd = makeTempDir();
  const state = runtimeConfigState();
  fs.cpSync(BUNDLED_DISTILL_DIR, path.join(cwd, 'plugins', 'distill'), {
    recursive: true,
  });
  const { installPlugin } = await import('../src/plugins/plugin-install.js');

  const result = await installPlugin('distill', { homeDir, cwd, ...state });
  expect(result).toMatchObject({ pluginDir: BUNDLED_DISTILL_DIR });
  expect(fs.existsSync(path.join(homeDir, 'plugins', 'distill'))).toBe(false);
  expect(state.current().plugins.list).toEqual([
    { id: 'distill', enabled: true, config: {} },
  ]);
});

function writeHomeCopyFixture(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    'id: fixture-plugin\nversion: 1.0.0\nentrypoint: index.js\n',
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "export default { id: 'fixture-plugin', register() {} };\n",
  );
  return dir;
}

// The guidance after install must match what the install did: a bundled
// plugin loads only through the plugins.list[] entry the install wrote, so
// calling that entry optional invites deleting the install itself.
test.each([
  ['install', 'bundled', true],
  ['install', 'home copy', false],
  ['reinstall', 'bundled', true],
  ['reinstall', 'home copy', false],
] as const)('%s of a %s plugin reports where it loads from', async (verb, _kind, inPlace) => {
  const homeDir = makeTempDir();
  const cwd = makeTempDir();
  const state = runtimeConfigState();
  const source = inPlace
    ? 'distill'
    : writeHomeCopyFixture(path.join(makeTempDir(), 'fixture-plugin'));
  const { installPlugin, reinstallPlugin } = await import(
    '../src/plugins/plugin-install.js'
  );
  const { formatPluginInstallGuidance } = await import(
    '../src/plugins/plugin-formatting.js'
  );
  const run = verb === 'install' ? installPlugin : reinstallPlugin;

  const result = await run(source, { homeDir, cwd, ...state });
  const guidance = formatPluginInstallGuidance(result, '/cfg/config.json');

  expect(result.enabledInPlace).toBe(inPlace);
  expect(state.current().plugins.list.length > 0).toBe(inPlace);
  expect(guidance.some((line) => line.includes(result.pluginDir))).toBe(true);
  expect(
    guidance.some((line) =>
      line.includes(`hybridclaw plugin uninstall ${result.pluginId}`),
    ),
  ).toBe(inPlace);
  if (inPlace) {
    expect(guidance.join('\n')).not.toMatch(/no config entry is required/i);
  }
});

test.each([
  [true, []],
  [true, ['apiKey']],
  [false, []],
  [false, ['apiKey']],
] as const)('guidance with enabledInPlace=%s and required keys %j wraps paths and names every need', async (enabledInPlace, requiredConfigKeys) => {
  const { formatPluginInstallGuidance } = await import(
    '../src/plugins/plugin-formatting.js'
  );
  const lines = formatPluginInstallGuidance(
    {
      pluginId: 'example',
      pluginDir: '/plugins/example',
      enabledInPlace,
      requiresEnv: ['EXAMPLE_TOKEN'],
      requiredConfigKeys: [...requiredConfigKeys],
    },
    '/cfg/config.json',
    (value) => `<${value}>`,
  );
  expect(lines.some((line) => line.includes('</plugins/example>'))).toBe(true);
  expect(lines.some((line) => line.includes('EXAMPLE_TOKEN'))).toBe(true);
  for (const key of requiredConfigKeys) {
    expect(lines.some((line) => line.includes(key))).toBe(true);
  }
  expect(lines.some((line) => line.includes('</cfg/config.json>'))).toBe(true);
});
