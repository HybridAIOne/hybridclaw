import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  getChannelTransport,
  hasChannelTransport,
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-channel-transport-');

afterEach(() => {
  unregisterChannelTransport('whatsapp');
  vi.restoreAllMocks();
});

function createTransportRegistration() {
  return {
    kind: 'whatsapp' as const,
    create: vi.fn(() => ({
      init: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendMedia: vi.fn(async () => {}),
    })),
  };
}

test('registers, resolves, and unregisters a channel transport', () => {
  const registration = createTransportRegistration();
  registerChannelTransport(registration);

  expect(hasChannelTransport('whatsapp')).toBe(true);
  expect(getChannelTransport('whatsapp')).toBe(registration);
  expect(() =>
    registerChannelTransport(createTransportRegistration()),
  ).toThrow('already registered');

  unregisterChannelTransport('whatsapp');
  expect(hasChannelTransport('whatsapp')).toBe(false);
});

test('plugin registration rollback removes a transport from a failed plugin', async () => {
  const cwd = await makeTempDir();
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'broken-channel');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    ['id: broken-channel', 'kind: channel', 'entrypoint: index.ts', ''].join(
      '\n',
    ),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'broken-channel',",
      '  register(api) {',
      '    api.registerChannelTransport({',
      "      kind: 'whatsapp',",
      '      create() { throw new Error("not used"); },',
      '    });',
      '    throw new Error("registration failed");',
      '  },',
      '};',
      '',
    ].join('\n'),
  );

  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  const manager = new PluginManager({
    cwd,
    homeDir: path.join(cwd, 'home'),
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(hasChannelTransport('whatsapp')).toBe(false);
  expect(manager.getLoadedPlugins()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'broken-channel', status: 'failed' }),
    ]),
  );
  await manager.shutdown();
});

test('plugin manager shutdown unregisters its channel transports', async () => {
  const cwd = await makeTempDir();
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  const manager = new PluginManager({
    cwd,
    homeDir: path.join(cwd, 'home'),
    getRuntimeConfig: () => config,
  });

  manager.registerChannelTransport('whatsapp-plugin', createTransportRegistration());
  expect(hasChannelTransport('whatsapp')).toBe(true);

  await manager.shutdown();
  expect(hasChannelTransport('whatsapp')).toBe(false);
});
