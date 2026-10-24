import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-plugin-node-');
const [major, minor, patch] = process.versions.node.split('.').map(Number);

test.each([
  [`>=${major}.${minor}.${patch} <${major + 1}`, true],
  [`>=${major}.${minor}.${patch + 1} <${major + 1}`, false],
  [`>=${major - 1}.0.0 <${major}`, false],
])('plugin range %s permits loading: %s', async (range, accepted) => {
  const cwd = makeTempDir();
  const dir = path.join(cwd, '.hybridclaw/plugins/test-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    `id: test-plugin\nname: Test Plugin\nkind: tool\nrequires:\n  node: '${range}'\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'index.ts'),
    accepted
      ? "export default { id: 'test-plugin', register() {} };"
      : 'throw new Error("unsupported plugin imported");',
  );
  const config = JSON.parse(
    fs.readFileSync('config.example.json', 'utf8'),
  ) as RuntimeConfig;
  config.plugins.list = [];
  const manager = new PluginManager({
    homeDir: makeTempDir(),
    cwd,
    getRuntimeConfig: () => config,
  });
  try {
    await manager.ensureInitialized();
    expect(manager.getLoadedPlugins()).toMatchObject(
      accepted ? [{ id: 'test-plugin', status: 'loaded' }] : [],
    );
  } finally {
    await manager.shutdown();
  }
});
