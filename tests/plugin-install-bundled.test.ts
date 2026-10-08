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

// A checkout's `.hybridclaw/plugins/<id>` is auto-discovered, but it must not
// replace a bundled plugin the operator installed in place, as it never
// replaced the home copy older releases installed.
test('an installed bundled plugin outranks a project plugin with the same id', async () => {
  const homeDir = makeTempDir();
  const cwd = makeTempDir();
  const state = runtimeConfigState();
  const projectCopy = path.join(cwd, '.hybridclaw', 'plugins', 'distill');
  fs.cpSync(BUNDLED_DISTILL_DIR, projectCopy, { recursive: true });
  expect(await discoveredDistillDir(homeDir, cwd, state)).toBe(projectCopy);

  const { installPlugin } = await import('../src/plugins/plugin-install.js');
  await installPlugin('distill', { homeDir, cwd, ...state });
  expect(await discoveredDistillDir(homeDir, cwd, state)).toBe(
    BUNDLED_DISTILL_DIR,
  );
});
