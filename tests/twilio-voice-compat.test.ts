import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

// compat: remove after v0.41, together with src/config/legacy-twilio-voice.ts
// and src/channels/voice/twilio-voice-compat.ts.

const makeTempDir = useTempDir('hybridclaw-twilio-compat-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

type PluginEntry = { id: string; enabled: boolean; path?: string };

async function loadStartupConfig(edit: (config: Record<string, any>) => void) {
  const home = makeTempDir();
  const configPath = path.join(home, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  );
  config.ops.dbPath = path.join(home, '.hybridclaw', 'data', 'hybridclaw.db');
  edit(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  vi.stubEnv('HOME', home);
  const runtimeConfig = await import('../src/config/runtime-config.ts');
  return {
    live: runtimeConfig.getRuntimeConfig().plugins.list as PluginEntry[],
    stored: JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      version: number;
      plugins: { list: PluginEntry[] };
    },
    configVersion: runtimeConfig.CONFIG_VERSION,
  };
}

test.each([
  {
    name: 'a v0.39 config with voice.enabled loads the bundled plugin',
    version: 40,
    enabled: true,
    list: [],
    expected: [{ id: 'twilio-voice', enabled: true }],
  },
  {
    name: 'a v0.39 config with voice off gains nothing',
    version: 40,
    enabled: false,
    list: [],
    expected: [],
  },
  {
    name: 'a migrated config whose operator removed the plugin keeps it removed',
    version: 41,
    enabled: true,
    list: [],
    expected: [],
  },
  {
    name: 'an explicitly disabled entry stays disabled',
    version: 40,
    enabled: true,
    list: [{ id: 'twilio-voice', enabled: false, config: {} }],
    expected: [{ id: 'twilio-voice', enabled: false }],
  },
])('$name', async ({ version, enabled, list, expected }) => {
  const { live, stored, configVersion } = await loadStartupConfig((config) => {
    config.version = version;
    config.voice.enabled = enabled;
    config.plugins = { list };
  });

  const twilio = (entries: PluginEntry[]) =>
    entries
      .filter((entry) => entry.id === 'twilio-voice')
      .map(({ id, enabled, path }) => ({ id, enabled, path }));
  const want = expected.map((entry) => ({ ...entry, path: undefined }));
  expect(twilio(live)).toEqual(want);
  expect(twilio(stored.plugins.list)).toEqual(want);
  expect(stored.version).toBe(configVersion);
});

test('only /voice/webhook is aliased, to the plugin incoming-call webhook', async () => {
  const { resolveLegacyTwilioVoiceWebhookPath } = await import(
    '../src/channels/voice/twilio-voice-compat.ts'
  );

  expect(resolveLegacyTwilioVoiceWebhookPath('/voice/webhook')).toBe(
    '/api/plugin-webhooks/twilio-voice/webhook',
  );
  for (const pathname of ['/voice/action', '/voice/relay', '/voice', '/x']) {
    expect(resolveLegacyTwilioVoiceWebhookPath(pathname)).toBeNull();
  }
});

test.each([
  { voiceEnabled: false, plugin: undefined, active: false, warns: false },
  {
    voiceEnabled: true,
    plugin: { id: 'twilio-voice', enabled: true },
    active: true,
    warns: false,
  },
  {
    voiceEnabled: true,
    plugin: { id: 'twilio-voice', enabled: false },
    active: false,
    warns: true,
  },
  {
    voiceEnabled: true,
    plugin: { id: 'twilio-voice', enabled: true, error: 'boom' },
    active: false,
    warns: true,
  },
  { voiceEnabled: true, plugin: undefined, active: false, warns: true },
])('the voice channel starts active only with the plugin loaded (%#)', async ({
  voiceEnabled,
  plugin,
  active,
  warns,
}) => {
  const warn = vi.fn();
  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({ voice: { enabled: voiceEnabled } }),
  }));
  vi.doMock('../src/logger.js', () => ({ logger: { warn } }));
  vi.doMock('../src/plugins/plugin-manager.js', () => ({
    getPluginManager: () => ({
      listPluginSummary: () => (plugin ? [plugin] : []),
    }),
  }));
  const { descriptor } = await import('../src/channels/voice/descriptor.ts');

  await expect(descriptor.start()).resolves.toBe(active);
  expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
});
