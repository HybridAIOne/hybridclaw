/**
 * `hybridclaw channels line setup [--reset]` and `auth line reset` driven
 * through the real CLI and the bundled LINE plugin. Only plugin discovery and
 * the linejs transport are faked; config, credential store, and pairing
 * wiring are real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChannelTransportRegistration } from '../src/plugins/plugin-sdk.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const SELF_MID = `u${'b'.repeat(32)}`;
const makeTempDir = useTempDir('hybridclaw-line-cli-');
useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  resetModules: true,
  unmock: [
    '../src/plugins/plugin-manager.js',
    '../plugins/line/src/transport.js',
  ],
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[
    Symbol.for('hybridclaw.line.pairingState')
  ];
});

async function importCli(options: { pluginLoadFails?: boolean } = {}) {
  const homeDir = makeTempDir();
  const dataDir = path.join(homeDir, '.hybridclaw');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();

  const pairing = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    waitForConnection: vi.fn(async () => ({ id: SELF_MID })),
  };
  vi.doMock('../plugins/line/src/transport.js', () => ({
    createLineTransport: () => ({
      init: async () => {},
      shutdown: async () => {},
      sendText: async () => {},
      sendMedia: async () => {},
      createPairingSession: async () => pairing,
    }),
  }));
  const shutdownPluginManager = vi.fn(async () => {});
  vi.doMock('../src/plugins/plugin-manager.js', () => ({
    ensurePluginManagerInitialized: async () => {
      const transports = await import('../src/channels/channel-transport.js');
      if (options.pluginLoadFails) {
        transports.markChannelPluginLoadFailed('line');
      } else if (!transports.hasChannelTransport('line')) {
        const { default: plugin } = await import(
          '../plugins/line/src/index.js'
        );
        plugin.register({
          runtime: { homeDir: dataDir },
          registerChannelTransport: (
            registration: ChannelTransportRegistration,
          ) => transports.registerChannelTransport(registration),
        } as never);
      }
      return {};
    },
    shutdownPluginManager,
  }));

  const storagePath = path.join(dataDir, 'credentials', 'line', 'storage.json');
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(
    storagePath,
    JSON.stringify({
      '.hybridclaw:authToken': 'stale-token',
      '.hybridclaw:profileMid': SELF_MID,
    }),
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    cli: await import('../src/cli.ts'),
    dataDir,
    storagePath,
    pairing,
    shutdownPluginManager,
    logged: () => log.mock.calls.map((call) => String(call[0])),
    errors: () => error.mock.calls.map((call) => String(call[0])),
  };
}

function readStorage(storagePath: string): Record<string, unknown> {
  return fs.existsSync(storagePath)
    ? (JSON.parse(fs.readFileSync(storagePath, 'utf-8')) as Record<
        string,
        unknown
      >)
    : {};
}

test.each([
  { args: [], resets: false },
  { args: ['--reset'], resets: true },
])('channels line setup $args enables LINE and pairs through the plugin', async ({
  args,
  resets,
}) => {
  const run = await importCli();

  await run.cli.main(['channels', 'line', 'setup', ...args]);

  const config = JSON.parse(
    fs.readFileSync(path.join(run.dataDir, 'config.json'), 'utf-8'),
  );
  expect(config.line.enabled).toBe(true);
  expect(run.pairing.start).toHaveBeenCalledTimes(1);
  expect(run.pairing.stop).toHaveBeenCalledTimes(1);
  expect(run.logged()).toContain(`LINE linked: ${SELF_MID}`);
  expect(
    run.logged().some((line) => line.startsWith('Reset LINE auth state at ')),
  ).toBe(resets);
  expect(readStorage(run.storagePath)['.hybridclaw:authToken']).toBe(
    resets ? undefined : 'stale-token',
  );
  expect(process.exitCode ?? 0).toBe(0);
});

test('auth line reset clears the plugin credential store and stops plugins', async () => {
  const run = await importCli();

  await run.cli.main(['auth', 'line', 'reset']);

  expect(readStorage(run.storagePath)).not.toHaveProperty(
    '.hybridclaw:authToken',
  );
  expect(run.logged()).toContain(
    'Linked LINE account cleared. Re-run `hybridclaw channels line setup` to pair again.',
  );
  expect(run.pairing.start).not.toHaveBeenCalled();
  expect(run.shutdownPluginManager).toHaveBeenCalledTimes(1);
});

test('channels line setup with a plugin that failed to load names reinstall and keeps the pairing', async () => {
  const run = await importCli({ pluginLoadFails: true });

  try {
    await run.cli.main(['channels', 'line', 'setup', '--reset']);
    expect(run.errors()).toEqual([
      expect.stringContaining('Reinstall it with: hybridclaw plugin reinstall'),
    ]);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = 0;
  }
  expect(readStorage(run.storagePath)['.hybridclaw:authToken']).toBe(
    'stale-token',
  );
});
