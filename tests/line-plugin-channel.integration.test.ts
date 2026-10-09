/**
 * The bundled LINE plugin driven through core's generic plugin-channel stack:
 * registration, gateway integration (slash commands, agent replies, artifact
 * policy), and proactive delivery. Only the linejs connection (LINE's servers)
 * and the agent turn are faked; plugin code, host, and gateway wiring are real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChannelTransportRegistration } from '../src/channels/channel-transport.js';
import type { HybridClawPluginApi } from '../src/plugins/plugin-sdk.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const SELF_MID = `u${'a'.repeat(32)}`;
const LINE_CHANNEL = `line:${SELF_MID}`;
const makeTempDir = useTempDir('hybridclaw-line-plugin-channel-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

let shutdown: (() => Promise<void>) | null = null;
afterEach(async () => {
  await shutdown?.();
  shutdown = null;
});

function makeTalkMessage(text: string) {
  return {
    from: { id: SELF_MID, type: 'USER' },
    to: { id: SELF_MID, type: 'USER' },
    text,
    raw: { id: text, from: SELF_MID, to: SELF_MID, contentType: 'NONE' },
  };
}

async function bootLine() {
  const dataDir = makeTempDir();
  const lineAuth = path.join(dataDir, 'credentials', 'line');
  fs.mkdirSync(lineAuth, { recursive: true });
  fs.writeFileSync(
    path.join(lineAuth, 'storage.json'),
    JSON.stringify({
      '.hybridclaw:authToken': 'test-token',
      '.hybridclaw:profileMid': SELF_MID,
    }),
  );
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();

  const sendMessage = vi.fn(async () => {});
  const client = {
    base: { profile: { displayName: 'Self' }, talk: { sendMessage } },
  };
  const connection = {
    onMessage: null as ((message: unknown) => void) | null,
  };
  vi.doMock('../plugins/line/src/connection.js', () => ({
    createLineConnectionManager: (
      _host: unknown,
      params?: { onMessage?: (message: unknown) => void },
    ) => {
      if (params?.onMessage) connection.onMessage = params.onMessage;
      return {
        getClient: () => client,
        getSelfMid: () => SELF_MID,
        start: async () => {},
        stop: async () => {},
        waitForClient: async () => client,
      };
    },
  }));
  const handleGatewayMessage = vi.fn(async () => ({
    status: 'success',
    result: 'agent reply',
    toolsUsed: [],
    artifacts: ['a.png', 'b.png', 'c.pdf'].map((filename) => ({
      path: path.join(dataDir, filename),
      filename,
      mimeType: 'application/octet-stream',
    })),
  }));
  vi.doMock('../src/gateway/gateway-chat-service.js', () => ({
    handleGatewayMessage,
  }));

  const runtimeConfig = await import('../src/config/runtime-config.js');
  runtimeConfig.ensureRuntimeConfigFile();
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.line.enabled = true;
  });
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const { logger } = await import('../src/logger.js');
  const warn = vi.spyOn(logger, 'warn');

  // What the plugin manager does with the bundled plugin's entrypoint.
  const transports = await import('../src/channels/channel-transport.js');
  const { default: linePlugin } = await import('../plugins/line/src/index.js');
  linePlugin.register({
    runtime: { homeDir: dataDir },
    registerChannelTransport: (registration: ChannelTransportRegistration) =>
      transports.registerChannelTransport(registration),
  } as unknown as HybridClawPluginApi);

  const runtime = await import('../src/channels/plugin-channel/runtime.js');
  const pluginManager = await import('../src/plugins/plugin-manager.js');
  shutdown = async () => {
    await runtime.shutdownPluginChannel('line');
    transports.unregisterChannelTransport('line');
    await pluginManager.shutdownPluginManager();
  };
  return {
    connection,
    sendMessage,
    handleGatewayMessage,
    warn,
    gateway: await import('../src/channels/plugin-channel/gateway.js'),
    descriptors: await import('../src/channels/channel-descriptors.js'),
    toolSend: await import('../src/channels/plugin-channel/tool-send.js'),
  };
}

test('an inbound LINE self-chat turn runs slash commands and agent replies through the generic integration', async () => {
  const line = await bootLine();
  await expect(line.gateway.startPluginChannelIntegration('line')).resolves.toBe(
    true,
  );
  expect(line.connection.onMessage).toBeTypeOf('function');

  line.connection.onMessage?.(makeTalkMessage('/help'));
  await vi.waitFor(() => expect(line.sendMessage).toHaveBeenCalled());
  expect(line.handleGatewayMessage).not.toHaveBeenCalled();
  expect(line.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    to: SELF_MID,
    text: expect.stringMatching(/^\[HybridClaw\] \S/),
  });

  line.sendMessage.mockClear();
  line.connection.onMessage?.(makeTalkMessage('hello agent'));
  await vi.waitFor(() => expect(line.sendMessage).toHaveBeenCalled());
  expect(line.handleGatewayMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: LINE_CHANNEL,
      userId: SELF_MID,
      content: 'hello agent',
      source: 'line',
    }),
  );
  expect(line.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ to: SELF_MID, text: '[HybridClaw] agent reply' }),
  );

  // LINE declares `attachments: false`: one notice, no per-artifact attempts.
  const artifactWarnings = line.warn.mock.calls.filter(([, message]) =>
    String(message ?? '').includes('artifact'),
  );
  expect(artifactWarnings).toEqual([
    [
      { channelId: LINE_CHANNEL, artifactCount: 3 },
      'LINE does not support artifact delivery',
    ],
  ]);
}, 60_000);

test('proactive LINE delivery and message-tool sends reach the linked self-chat', async () => {
  const line = await bootLine();
  await expect(line.gateway.startPluginChannelIntegration('line')).resolves.toBe(
    true,
  );
  const descriptor = line.descriptors.getChannelDescriptorForTarget(LINE_CHANNEL);
  expect(descriptor?.kind).toBe('line');

  await expect(
    descriptor?.sendProactive?.(LINE_CHANNEL, 'scheduled note', 'heartbeat'),
  ).resolves.toEqual({ status: 'delivered' });
  expect(line.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ to: SELF_MID, text: '[HybridClaw] scheduled note' }),
  );

  const target = line.toolSend.resolvePluginChannelTarget(LINE_CHANNEL);
  expect(target).toEqual({ kind: 'line', channelId: LINE_CHANNEL });
  await expect(
    line.toolSend.sendPluginChannelToolMessage({
      ...(target as NonNullable<typeof target>),
      content: 'tool note',
      filePath: null,
      hasComponents: false,
      from: undefined,
    }),
  ).resolves.toMatchObject({ ok: true, transport: 'line', channelId: LINE_CHANNEL });
  await expect(
    line.toolSend.sendPluginChannelToolMessage({
      ...(target as NonNullable<typeof target>),
      content: 'with file',
      filePath: '/tmp/x.png',
      hasComponents: false,
      from: undefined,
    }),
  ).rejects.toThrow('filePath is not supported for LINE sends.');
}, 60_000);
