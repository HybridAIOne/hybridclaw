import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import plugin from '../plugins/concierge-router/src/index.js';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

test('concierge plugin delegates all decisions to shared gateway routing', async () => {
  const api = {
    registerCommand: vi.fn(),
    registerMiddleware: vi.fn(),
    writeConfigValue: vi.fn(),
    getRoutingConfig: () => ({
      enabled: true,
      mode: 'auto',
      preference: 'balanced',
      concierge: { model: 'test-router' },
    }),
  };
  plugin.register(api);
  expect(api.registerMiddleware).not.toHaveBeenCalled();
  const command = api.registerCommand.mock.calls[0][0];
  expect(await command.handler([])).toContain('auto');
});

test('concierge plugin loads with its pre-v0.32 config and names the ignored keys', async () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.plugins.list = [
    {
      id: 'concierge-router',
      enabled: true,
      path: path.resolve('plugins/concierge-router'),
      config: { model: 'test-router', profiles: { asap: 'test-fast' } },
    },
  ];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir: makeTempDir('hybridclaw-concierge-home-'),
    cwd: makeTempDir('hybridclaw-concierge-project-'),
    getRuntimeConfig: () => config,
    logger: logger as never,
  });
  await manager.ensureInitialized();

  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({ id: 'concierge-router', status: 'loaded' }),
  ]);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      pluginId: 'concierge-router',
      ignoredConfigKeys: ['model', 'profiles'],
    },
    expect.any(String),
  );
});
