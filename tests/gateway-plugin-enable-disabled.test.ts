/**
 * Gateway `/plugin enable` for a home-installed plugin whose `plugins.list[]`
 * entry is `enabled: false`: discovery skips it, so the command must re-enable
 * it in config rather than report it missing or reinstall it (issue #1927).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-gateway-plugin-enable-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

let shutdown: (() => Promise<void>) | null = null;
afterEach(async () => {
  await shutdown?.();
  shutdown = null;
});

function writeHomePlugin(dataDir: string, pluginId: string): void {
  const dir = path.join(dataDir, 'plugins', pluginId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    `id: ${pluginId}\nversion: 1.0.0\nentrypoint: index.js\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `export default { id: ${JSON.stringify(pluginId)}, register() {} };\n`,
  );
}

test('/plugin enable re-enables a disabled home-installed plugin and reloads it', async () => {
  const pluginId = 'echo-home';
  const dataDir = makeTempDir();
  writeHomePlugin(dataDir, pluginId);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');

  const runtimeConfig = await import('../src/config/runtime-config.js');
  runtimeConfig.ensureRuntimeConfigFile();
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.plugins.list = [{ id: pluginId, enabled: false, config: {} }];
  });
  const plugins = await import('../src/plugins/plugin-manager.js');
  const pluginService = await import('../src/gateway/gateway-plugin-service.js');
  shutdown = plugins.shutdownPluginManager;

  const loaded = async () =>
    (await plugins.ensurePluginManagerInitialized())
      .getLoadedPlugins()
      .some((plugin) => plugin.id === pluginId);
  expect(await loaded()).toBe(false);

  const result = await pluginService.handlePluginGatewayCommand({
    req: {
      sessionId: 'session-plugin-enable-disabled',
      guildId: null,
      channelId: 'tui',
      args: ['plugin', 'enable', pluginId],
    },
    pluginManager: await plugins.ensurePluginManagerInitialized(),
    pluginInitError: null,
  });

  expect(result).toMatchObject({ kind: 'info', title: 'Plugin Enabled' });
  expect(
    runtimeConfig
      .getRuntimeConfig()
      .plugins.list.find((entry) => entry.id === pluginId)?.enabled ?? true,
  ).toBe(true);
  expect(await loaded()).toBe(true);
}, 60_000);
