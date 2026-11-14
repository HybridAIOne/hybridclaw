import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  getChannelPluginCatalogEntry,
  getChannelPluginCatalogEntryByPluginId,
} from '../src/channels/channel-plugin-catalog.js';
import {
  describeMissingChannelTransport,
  diffChannelPluginTransportAvailability,
  getChannelPluginStatuses,
  getChannelTransport,
  hasChannelTransport,
  registerChannelTransport,
  requireChannelTransport,
  snapshotChannelPluginTransportAvailability,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { fakeWhatsAppRegistration } from './helpers/fake-channel-transport.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-channel-transport-');

afterEach(() => {
  unregisterChannelTransport('whatsapp');
  vi.restoreAllMocks();
});

test('registers, resolves, and unregisters a channel transport', () => {
  const registration = fakeWhatsAppRegistration();
  const registered = registerChannelTransport(registration);

  expect(registered).toBe(registration);
  expect(hasChannelTransport('whatsapp')).toBe(true);
  expect(getChannelTransport('whatsapp')).toBe(registered);
  expect(() =>
    registerChannelTransport(fakeWhatsAppRegistration()),
  ).toThrow('already registered');

  unregisterChannelTransport('whatsapp');
  expect(hasChannelTransport('whatsapp')).toBe(false);
});

test.each([
  { kind: 'telegram', error: 'Unknown channel transport kind "telegram"' },
  { kind: 'constructor', error: 'Unknown channel transport kind' },
  { kind: 'line', error: 'hybridclaw plugin reinstall line' },
  { kind: 'whatsapp', error: 'hybridclaw plugin reinstall https://github.com/HybridAIOne/hybridclaw-whatsapp/' },
])('rejects $kind registrations loudly', ({ kind, error }) => {
  expect(() =>
    registerChannelTransport({ kind, create: vi.fn() } as never),
  ).toThrow(error);
  expect(hasChannelTransport(kind)).toBe(false);
});

test('rejects a registration that skips required hooks', () => {
  expect(() =>
    registerChannelTransport({
      kind: 'whatsapp', create: vi.fn(), matchesTarget: () => false,
    } as never),
  ).toThrow(
    'Channel transport "whatsapp" is missing normalizeTarget, getAuthStatus, resetAuth.',
  );
  expect(hasChannelTransport('whatsapp')).toBe(false);
});

test.each([
  {
    name: 'a misspelled matchesTarget',
    hooks: {
      matchTarget: () => false,
      normalizeTarget: () => null,
      getAuthStatus: async () => ({ linked: false }),
      resetAuth: async () => '/tmp/unused',
    },
    missing: 'matchesTarget',
  },
  {
    name: 'only optional hooks',
    hooks: { getPairingState: () => null, describeSend: () => null },
    missing: 'matchesTarget, normalizeTarget, getAuthStatus, resetAuth',
  },
  {
    name: 'an undefined required hook',
    hooks: { getAuthStatus: undefined },
    missing: 'matchesTarget, normalizeTarget, getAuthStatus, resetAuth',
  },
])(
  'a WhatsApp registration with $name is refused',
  ({ hooks, missing }) => {
    expect(() =>
      registerChannelTransport({
        kind: 'whatsapp', create: vi.fn(), ...hooks,
      } as never),
    ).toThrow(`Channel transport "whatsapp" is missing ${missing}.`);
    expect(hasChannelTransport('whatsapp')).toBe(false);
  },
);

test('resolving an unknown kind throws instead of returning nothing', () => {
  expect(() => getChannelTransport('telegram')).toThrow(
    'Unknown channel transport kind "telegram"',
  );
  expect(() => requireChannelTransport('whatsapp')).toThrow(
    'WhatsApp transport plugin is not installed. Install it with: hybridclaw plugin install https://github.com/HybridAIOne/hybridclaw-whatsapp/',
  );
});

test('channel plugin catalog reports transport availability generically', () => {
  expect(getChannelPluginCatalogEntry('whatsapp')?.installSource).toMatch(
    /^https:\/\/github\.com\/HybridAIOne\/hybridclaw-whatsapp\/releases\/download\/v(\d+\.\d+\.\d+)\/hybridaione-hybridclaw-whatsapp-\1\.tgz$/,
  );
  expect(getChannelPluginCatalogEntry('whatsapp')).toEqual({
    channel: 'whatsapp',
    pluginId: 'whatsapp',
    installSource:
      getChannelPluginCatalogEntry('whatsapp')?.installSource,
  });
  expect(getChannelPluginCatalogEntryByPluginId('whatsapp')).toEqual({
    channel: 'whatsapp',
    pluginId: 'whatsapp',
    installSource:
      getChannelPluginCatalogEntry('whatsapp')?.installSource,
  });
  expect(getChannelPluginStatuses()).toContainEqual({
    channel: 'whatsapp',
    pluginId: 'whatsapp',
    installSource:
      getChannelPluginCatalogEntry('whatsapp')?.installSource,
    transportAvailable: false,
    loadFailed: false,
  });

  registerChannelTransport(fakeWhatsAppRegistration());

  expect(getChannelPluginStatuses()).toContainEqual(
    expect.objectContaining({
      channel: 'whatsapp',
      transportAvailable: true,
    }),
  );
});

test('channel plugin availability snapshot diff reports transitions', () => {
  const before = snapshotChannelPluginTransportAvailability();
  expect(before.get('whatsapp')).toBe(false);
  expect(
    diffChannelPluginTransportAvailability(
      before,
      snapshotChannelPluginTransportAvailability(),
    ),
  ).toEqual([]);

  registerChannelTransport(fakeWhatsAppRegistration());
  const after = snapshotChannelPluginTransportAvailability();
  expect(diffChannelPluginTransportAvailability(before, after)).toEqual([
    { channel: 'whatsapp', available: true },
  ]);

  unregisterChannelTransport('whatsapp');
  expect(
    diffChannelPluginTransportAvailability(
      after,
      snapshotChannelPluginTransportAvailability(),
    ),
  ).toEqual([{ channel: 'whatsapp', available: false }]);
});

test('channel plugin catalog resolves the bundled LINE plugin', () => {
  expect(getChannelPluginCatalogEntry('line')).toEqual({
    channel: 'line',
    pluginId: 'line',
    installSource: 'line',
  });
  expect(getChannelPluginCatalogEntryByPluginId('line')).toEqual({
    channel: 'line',
    pluginId: 'line',
    installSource: 'line',
  });
  expect(getChannelPluginStatuses()).toContainEqual({
    channel: 'line',
    pluginId: 'line',
    installSource: 'line',
    transportAvailable: false,
    loadFailed: false,
  });
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
      '      matchesTarget() { return false; }, normalizeTarget() { return null; },',
      '      async getAuthStatus() { return { linked: false }; }, async resetAuth() { return "/unused"; },',
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
      expect.objectContaining({ id: 'broken-channel', status: 'failed', error: expect.stringContaining('registration failed') }),
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

  manager.registerChannelTransport('whatsapp-plugin', fakeWhatsAppRegistration());
  expect(hasChannelTransport('whatsapp')).toBe(true);

  await manager.shutdown();
  expect(hasChannelTransport('whatsapp')).toBe(false);
});

test('an installed catalog plugin that failed to load asks for reinstall, not install', async () => {
  const cwd = await makeTempDir();
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'line');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    'id: line\nname: LINE\nversion: 0.1.0\nkind: channel\nentrypoint: index.js\n',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    "export default { id: 'line', register(api) { api.registerChannelTransport({ kind: 'line', create() {} }); } };\n",
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
  expect(getChannelPluginStatuses()).toContainEqual(
    expect.objectContaining({
      channel: 'line',
      transportAvailable: false,
      loadFailed: true,
    }),
  );
  expect(() => requireChannelTransport('line')).toThrow(
    'LINE transport plugin failed to load (see `hybridclaw plugin list`). Reinstall it with: hybridclaw plugin reinstall line',
  );
  expect(describeMissingChannelTransport('whatsapp')).toContain(
    'is not installed. Install it with: hybridclaw plugin install',
  );

  // After the plugin is gone, the next load reports it as not installed.
  await manager.shutdown();
  expect(describeMissingChannelTransport('line')).toBe(
    'LINE transport plugin is not installed. Install it with: hybridclaw plugin install line',
  );
});
