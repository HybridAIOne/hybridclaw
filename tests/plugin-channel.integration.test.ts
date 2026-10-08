/**
 * Real plugin loading for the plugin channels: the plugin manager discovers
 * the bundled LINE plugin source and a fixture of the released create-only
 * WhatsApp plugin in an isolated data dir that already holds 0.39.1
 * credentials, then core reaches both only through the transport registry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
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

test('0.39.1 WhatsApp and LINE pairings keep working through plugin registrations', async () => {
  const dataDir = seed039DataDir({ linePlugin: 'current' });
  const core = await loadCore(dataDir);

  expect(
    core.manager
      .getLoadedPlugins()
      .filter((plugin) => ['line', 'whatsapp'].includes(plugin.id))
      .map((plugin) => [plugin.id, plugin.status]),
  ).toEqual([
    ['line', 'loaded'],
    ['whatsapp', 'loaded'],
  ]);

  const jid = '491701234567@s.whatsapp.net';
  const lineTarget = `line:${SELF_MID}`;
  expect(core.descriptors.resolveChannelTargetKind(jid)).toBe('whatsapp');
  expect(core.descriptors.resolveChannelTargetKind(lineTarget)).toBe('line');

  const before = await core.status.getPluginChannelGatewayStatuses(
    core.getRuntimeConfig(),
  );
  expect(before.whatsapp).toMatchObject({
    enabled: true,
    linked: true,
    jid: '491701234567:7@s.whatsapp.net',
  });
  expect(before.line).toMatchObject({
    enabled: true,
    linked: true,
    mid: SELF_MID,
    pairingQrSvg: null,
  });

  await expect(
    core.status.checkPluginChannels(core.getRuntimeConfig()),
  ).resolves.toEqual([
    { severity: 'ok', message: 'LINE linked' },
    { severity: 'ok', message: 'WhatsApp linked' },
  ]);

  // The legacy plugin builds its runtime against the retired host extras.
  await expect(
    core.gateway.startPluginChannelIntegration('whatsapp'),
  ).resolves.toBe(true);
  expect(fs.existsSync(path.join(dataDir, 'credentials', 'whatsapp.lock'))).toBe(
    true,
  );

  const target = core.toolSend.resolvePluginChannelTarget(
    'whatsapp:+49 170 1234567',
  );
  expect(target).toEqual({ kind: 'whatsapp', channelId: jid });
  await expect(
    core.toolSend.sendPluginChannelToolMessage({
      ...(target as NonNullable<typeof target>),
      content: 'note to self',
      filePath: null,
      hasComponents: false,
      from: undefined,
    }),
  ).resolves.toMatchObject({
    ok: true,
    transport: 'whatsapp',
    sentFrom: '+491701234567',
    recipient: '+491701234567',
    messageIds: ['fake-1'],
    deliveryConfirmed: false,
    note: expect.stringContaining('does not send a push notification'),
  });

  const descriptor = core.descriptors.getChannelDescriptorForTarget(jid);
  await expect(
    descriptor?.sendProactive?.(jid, 'heartbeat', 'heartbeat'),
  ).resolves.toEqual({ status: 'delivered' });

  const lineRegistration = core.transports.requireChannelTransport('line');
  await expect(lineRegistration.resetAuth()).resolves.toBe(
    path.join(dataDir, 'credentials', 'line'),
  );
  await expect(lineRegistration.getAuthStatus()).resolves.toEqual({
    linked: false,
    mid: null,
  });
});

test('a stale create-only LINE plugin fails loudly with the reinstall command', async () => {
  const dataDir = seed039DataDir({ linePlugin: 'legacy' });
  const core = await loadCore(dataDir);

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
  await expect(
    core.status.checkPluginChannels(core.getRuntimeConfig()),
  ).resolves.toContainEqual({
    severity: 'error',
    message: 'LINE plugin not installed',
  });
  // The pairing file is untouched, so a reinstall resumes the old session.
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(dataDir, 'credentials', 'line', 'storage.json'),
        'utf-8',
      ),
    ),
  ).toHaveProperty(['.hybridclaw:profileMid'], SELF_MID);
});
