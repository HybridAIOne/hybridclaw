import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true });

// Importing runtime config under the real HOME would migrate the developer's
// live ~/.hybridclaw/config.json.
beforeEach(() => {
  vi.stubEnv('HOME', makeTempDir('hybridclaw-browser-plugins-home-'));
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
});

let server: http.Server | undefined;
afterEach(async () => {
  const { clearBrowserProviders } = await import(
    '../src/browser/provider-factory.js'
  );
  clearBrowserProviders();
  if (server) await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

function runtimeConfig(
  plugins: RuntimeConfig['plugins']['list'],
): RuntimeConfig {
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.plugins.list = plugins;
  return config;
}

async function loadBundledPlugins(
  plugins: RuntimeConfig['plugins']['list'],
) {
  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const config = runtimeConfig(plugins);
  const manager = new PluginManager({
    homeDir: makeTempDir('hybridclaw-browser-plugins-runtime-'),
    cwd: makeTempDir('hybridclaw-browser-plugins-project-'),
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();
  const factory = await import('../src/browser/provider-factory.js');
  const create = (provider: string) =>
    factory.createBrowserProvider({
      ...config.browser,
      provider,
    });
  return { manager, create };
}

const ALL_BROWSER_PLUGINS = [
  'camofox',
  'browser-use-cloud',
  'managed-cloud',
  'mac-cua',
].map((id) => ({ id, enabled: true, config: {} }));

test('bundled browser plugins register their provider kinds and unregister on shutdown', async () => {
  const { manager, create } = await loadBundledPlugins(ALL_BROWSER_PLUGINS);

  expect(
    manager.listPluginSummary().filter((plugin) => plugin.error),
  ).toEqual([]);
  expect(create('camofox').constructor.name).toBe('CamofoxProvider');
  expect(create('browser-use-cloud').constructor.name).toBe(
    'BrowserUseCloudProvider',
  );
  expect(create('managed-cloud').constructor.name).toBe(
    'ManagedCloudBrowserProvider',
  );
  // Linux CI has no Cua Driver: reaching this error proves the kind is
  // routed into the plugin's provider rather than to the local browser.
  if (process.platform !== 'darwin') {
    expect(() => create('mac-cua')).toThrow(/only supported on macOS/u);
  }
  expect(manager.findCommand('browser-pool')).toBeDefined();
  expect(manager.findCommand('mac-cua')).toBeDefined();

  await manager.shutdown();
  expect(() => create('managed-cloud')).toThrow(/not available/u);
});

test('camofox plugin refuses launch options HybridClaw manages', async () => {
  const { manager } = await loadBundledPlugins([
    { id: 'camofox', enabled: true, config: { launchOptions: { timeout: 5 } } },
  ]);

  expect(
    manager.listPluginSummary().find((plugin) => plugin.id === 'camofox')
      ?.error,
  ).toMatch(/launchOptions\.timeout is managed by HybridClaw/u);
});

test('managed-cloud browser-pool doctor reads the pool health with the declared token', async () => {
  vi.stubEnv('MANAGED_BROWSER_POOL_TOKEN', 'pool-token');
  const seen: Array<string | undefined> = [];
  server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        nodes: [{ status: 'idle' }, { status: 'leased' }, { status: 'down' }],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server?.listen(0, '127.0.0.1', resolve),
  );
  const { port } = server.address() as { port: number };
  const { manager } = await loadBundledPlugins([
    {
      id: 'managed-cloud',
      enabled: true,
      config: { endpointUrl: `http://127.0.0.1:${port}` },
    },
  ]);

  const result = await manager
    .findCommand('browser-pool')
    ?.handler(['doctor'], { sessionId: 's', channelId: 'tui' });

  expect(result).toMatchObject({
    kind: 'info',
    text: expect.stringContaining('Nodes: 2/3'),
  });
  expect(seen).toEqual(['Bearer pool-token']);
});

test('mac-cua doctor reports the platform gate off macOS', async () => {
  const { manager } = await loadBundledPlugins([
    { id: 'mac-cua', enabled: true, config: {} },
  ]);
  const result = await manager
    .findCommand('mac-cua')
    ?.handler(['doctor'], { sessionId: 's', channelId: 'tui' });

  if (process.platform === 'darwin') return;
  expect(result).toMatchObject({
    kind: 'error',
    text: expect.stringContaining('only supported on macOS'),
  });
});
