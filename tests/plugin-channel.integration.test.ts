/**
 * Real plugin loading for the plugin channels: the plugin manager discovers
 * the bundled LINE plugin source and a fixture of the create-only WhatsApp
 * 0.1.x plugin in an isolated data dir that already holds 0.39.1
 * credentials. Core reaches LINE only through the transport registry and
 * refuses the 0.1.x WhatsApp plugin with the reinstall command.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { getChannelPluginCatalogEntry } from '../src/channels/channel-plugin-catalog.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SELF_MID = `u${'a'.repeat(32)}`;
const makeTempDir = useTempDir('hybridclaw-plugin-channel-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

let shutdown: (() => Promise<void>) | null = null;
afterEach(async () => {
  await shutdown?.();
  shutdown = null;
});

function copyPlugin(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`),
  });
}

/** Lays out a data dir the way HybridClaw 0.39.1 left it after pairing. */
function seed039DataDir(options: { linePlugin: 'current' | 'legacy' }) {
  const dataDir = makeTempDir();
  const pluginsDir = path.join(dataDir, 'plugins');
  copyPlugin(
    path.join(ROOT, 'tests/fixtures/legacy-whatsapp-plugin'),
    path.join(pluginsDir, 'whatsapp'),
  );
  if (options.linePlugin === 'current') {
    copyPlugin(path.join(ROOT, 'plugins/line'), path.join(pluginsDir, 'line'));
  } else {
    const legacyDir = path.join(pluginsDir, 'line');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'hybridclaw.plugin.yaml'),
      'id: line\nname: LINE\nversion: 0.1.0\nkind: channel\nentrypoint: index.js\n',
    );
    // The 0.1.0 plugin registered only the transport factory.
    fs.writeFileSync(
      path.join(legacyDir, 'index.js'),
      "export default { id: 'line', register(api) { api.registerChannelTransport({ kind: 'line', create() { throw new Error('unused'); } }); } };\n",
    );
  }

  const whatsappAuth = path.join(dataDir, 'credentials', 'whatsapp');
  fs.mkdirSync(whatsappAuth, { recursive: true });
  fs.writeFileSync(
    path.join(whatsappAuth, 'creds.json'),
    JSON.stringify({
      registered: true,
      me: { id: '491701234567:7@s.whatsapp.net' },
    }),
  );
  const lineAuth = path.join(dataDir, 'credentials', 'line');
  fs.mkdirSync(lineAuth, { recursive: true });
  fs.writeFileSync(
    path.join(lineAuth, 'storage.json'),
    JSON.stringify({
      '.hybridclaw:authToken': 'test-token',
      '.hybridclaw:profileMid': SELF_MID,
    }),
  );
  return dataDir;
}

async function loadCore(dataDir: string) {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
  const runtimeConfig = await import('../src/config/runtime-config.js');
  runtimeConfig.ensureRuntimeConfigFile();
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.whatsapp.dmPolicy = 'pairing';
    draft.line.enabled = true;
  });
  const pluginManager = await import('../src/plugins/plugin-manager.js');
  shutdown = async () => {
    const runtime = await import('../src/channels/plugin-channel/runtime.js');
    await runtime.shutdownPluginChannel('whatsapp');
    await pluginManager.shutdownPluginManager();
  };
  const manager = await pluginManager.ensurePluginManagerInitialized();
  return {
    manager,
    getRuntimeConfig: runtimeConfig.getRuntimeConfig,
    transports: await import('../src/channels/channel-transport.js'),
    descriptors: await import('../src/channels/channel-descriptors.js'),
    status: await import('../src/channels/plugin-channel/status.js'),
    toolSend: await import('../src/channels/plugin-channel/tool-send.js'),
    gateway: await import('../src/channels/plugin-channel/gateway.js'),
  };
}

test('a 0.39.1 LINE pairing keeps working through its plugin registration', async () => {
  const dataDir = seed039DataDir({ linePlugin: 'current' });
  const core = await loadCore(dataDir);

  expect(
    core.manager.getLoadedPlugins().find((plugin) => plugin.id === 'line'),
  ).toMatchObject({ status: 'loaded' });

  const lineTarget = `line:${SELF_MID}`;
  expect(core.descriptors.resolveChannelTargetKind(lineTarget)).toBe('line');

  const before = await core.status.getPluginChannelGatewayStatuses(
    core.getRuntimeConfig(),
  );
  expect(before.line).toMatchObject({
    enabled: true,
    linked: true,
    mid: SELF_MID,
    pairingQrSvg: null,
  });

  await expect(
    core.status.checkPluginChannels(core.getRuntimeConfig()),
  ).resolves.toContainEqual({ severity: 'ok', message: 'LINE linked' });

  const lineRegistration = core.transports.requireChannelTransport('line');
  await expect(lineRegistration.resetAuth()).resolves.toBe(
    path.join(dataDir, 'credentials', 'line'),
  );
  await expect(lineRegistration.getAuthStatus()).resolves.toEqual({
    linked: false,
    mid: null,
  });
}, 60_000);

test('a create-only WhatsApp 0.1.x plugin fails loudly with the reinstall command', async () => {
  const dataDir = seed039DataDir({ linePlugin: 'current' });
  const core = await loadCore(dataDir);
  const reinstall = `Reinstall it with: hybridclaw plugin reinstall ${
    getChannelPluginCatalogEntry('whatsapp')?.installSource
  }`;

  expect(
    core.manager.getLoadedPlugins().find((plugin) => plugin.id === 'whatsapp'),
  ).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('retired create-only contract'),
  });
  expect(core.transports.hasChannelTransport('whatsapp')).toBe(false);
  // A stored JID stays WhatsApp's and fails instead of rerouting.
  const jid = '491701234567@s.whatsapp.net';
  expect(core.descriptors.resolveChannelTargetKind(jid)).toBe('whatsapp');
  await expect(
    core.status.checkPluginChannels(core.getRuntimeConfig()),
  ).resolves.toContainEqual({
    severity: 'error',
    message: expect.stringContaining(reinstall),
  });
  const target = core.toolSend.resolvePluginChannelTarget(
    'whatsapp:+49 170 1234567',
  );
  expect(target).toEqual({ kind: 'whatsapp', channelId: 'whatsapp:+49 170 1234567' });
  await expect(
    core.toolSend.sendPluginChannelToolMessage({
      ...(target as NonNullable<typeof target>),
      content: 'note',
      filePath: null,
      hasComponents: false,
      from: undefined,
    }),
  ).rejects.toThrow(reinstall);
  await expect(
    core.gateway.startPluginChannelIntegration('whatsapp'),
  ).resolves.toBe(false);
  // The linked credentials are untouched, so a reinstall resumes the session.
  expect(
    fs.existsSync(path.join(dataDir, 'credentials', 'whatsapp', 'creds.json')),
  ).toBe(true);
}, 60_000);

const REINSTALL_LINE =
  'LINE transport plugin failed to load (see `hybridclaw plugin list`). Reinstall it with: hybridclaw plugin reinstall line';

test('a stale create-only LINE plugin fails loudly with the reinstall command', async () => {
  const dataDir = seed039DataDir({ linePlugin: 'legacy' });
  const core = await loadCore(dataDir);
  const { logger } = await import('../src/logger.js');
  const warn = vi.spyOn(logger, 'warn');

  expect(
    core.manager.getLoadedPlugins().find((plugin) => plugin.id === 'line'),
  ).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('hybridclaw plugin reinstall line'),
  });
  expect(core.transports.hasChannelTransport('line')).toBe(false);
  // The stored LINE session id stays LINE's and fails instead of rerouting.
  const lineTarget = `line:${SELF_MID}`;
  expect(core.descriptors.resolveChannelTargetKind(lineTarget)).toBe('line');
  await expect(
    core.descriptors
      .getChannelDescriptorForTarget(lineTarget)
      ?.sendProactive?.(lineTarget, 'heartbeat', 'heartbeat'),
  ).resolves.toEqual({
    status: 'failed',
    reason: 'transport plugin is not installed',
  });
  // Every user-facing surface points at `reinstall`: `plugin install line`
  // refuses because the plugin directory already exists.
  await expect(
    core.status.checkPluginChannels(core.getRuntimeConfig()),
  ).resolves.toContainEqual({ severity: 'error', message: REINSTALL_LINE });
  expect(() => core.transports.requireChannelTransport('line')).toThrow(
    REINSTALL_LINE,
  );
  const toolTarget = core.toolSend.resolvePluginChannelTarget(lineTarget);
  expect(toolTarget).toEqual({ kind: 'line', channelId: lineTarget });
  await expect(
    core.toolSend.sendPluginChannelToolMessage({
      ...(toolTarget as NonNullable<typeof toolTarget>),
      content: 'note',
      filePath: null,
      hasComponents: false,
      from: undefined,
    }),
  ).rejects.toThrow(REINSTALL_LINE);
  await expect(core.gateway.startPluginChannelIntegration('line')).resolves.toBe(
    false,
  );
  expect(warn).toHaveBeenCalledWith(
    `LINE integration disabled: ${REINSTALL_LINE}`,
  );
  // The pairing file is untouched, so a reinstall resumes the old session.
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(dataDir, 'credentials', 'line', 'storage.json'),
        'utf-8',
      ),
    ),
  ).toHaveProperty(['.hybridclaw:profileMid'], SELF_MID);
}, 60_000);

test('a live plugin reload after reinstalling LINE brings the channel back without a restart', async () => {
  const dataDir = seed039DataDir({ linePlugin: 'legacy' });
  const core = await loadCore(dataDir);
  expect(core.transports.hasChannelTransport('line')).toBe(false);

  // `hybridclaw plugin reinstall line` replaces the plugin tree in place.
  const linePluginDir = path.join(dataDir, 'plugins', 'line');
  fs.rmSync(linePluginDir, { recursive: true, force: true });
  copyPlugin(path.join(ROOT, 'plugins/line'), linePluginDir);

  const pluginService = await import('../src/gateway/gateway-plugin-service.js');
  const changes: unknown[] = [];
  pluginService.setChannelPluginAvailabilityListener(async (next) => {
    changes.push(...next);
  });
  try {
    await expect(pluginService.reloadPluginRuntime()).resolves.toMatchObject({
      ok: true,
    });
  } finally {
    pluginService.setChannelPluginAvailabilityListener(null);
  }

  expect(changes).toEqual([{ channel: 'line', available: true }]);
  await expect(
    core.transports.requireChannelTransport('line').getAuthStatus(),
  ).resolves.toEqual({ linked: true, mid: SELF_MID });
  expect(core.transports.describeMissingChannelTransport('line')).toContain(
    'hybridclaw plugin install line',
  );
  await expect(
    core.status.getPluginChannelGatewayStatuses(core.getRuntimeConfig()),
  ).resolves.toMatchObject({ line: { linked: true, mid: SELF_MID } });
}, 60_000);
