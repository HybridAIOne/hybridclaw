import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
// The LINE transport lives in the bundled install-on-demand plugin; its
// linejs-free modules are imported directly so the suite runs without the
// plugin's dependency closure installed.
import {
  createLineAuthStore,
  LINE_STORAGE_KEYS,
  LineAuthLockError,
} from '../plugins/line/src/auth.js';
import { prepareLineTextChunks } from '../plugins/line/src/delivery.js';
import { createLineHost } from '../plugins/line/src/host.js';
import { processInboundLineSelfMessage } from '../plugins/line/src/inbound.js';
import linePlugin from '../plugins/line/src/index.js';
import { createLinePairingState } from '../plugins/line/src/pairing-state.js';
import {
  buildLineChannelId,
  isLineChannelId,
  normalizeLineChannelId,
  normalizeLineMessageTarget,
} from '../plugins/line/src/target.js';
import { DEFAULT_AGENT_ID } from '../src/agents/agent-types.js';
import { normalizeNativeAgentAddressingText } from '../src/channels/agent-addressing.js';
import { resolveChannelTargetKind } from '../src/channels/channel-descriptors.js';
import {
  type ChannelTransportHost,
  type ChannelTransportRegistration,
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import type { HybridClawPluginApi } from '../src/plugins/plugin-sdk.js';
import { buildSessionKey } from '../src/session/session-key.js';
import { useTempDir } from './test-utils.js';

const SELF_MID = `u${'a'.repeat(32)}`;
const OTHER_MID = `u${'b'.repeat(32)}`;
const makeTempDir = useTempDir('hybridclaw-line-plugin-');

function makeBaseHost(): ChannelTransportHost {
  return {
    defaultAgentId: DEFAULT_AGENT_ID,
    logger: {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    getConfig: () => ({ enabled: true, textChunkLimit: 5_000 }),
    text: { normalizeNativeAgentAddressingText },
    buildSessionKey,
    renderQrSvg: (input: string) => `<svg data-input="${input}"/>`,
  } as unknown as ChannelTransportHost;
}

function makeHost(authDir = '/tmp/unused') {
  return createLineHost(
    makeBaseHost(),
    createLineAuthStore(authDir),
    createLinePairingState(),
  );
}

function registerPlugin(homeDir: string): ChannelTransportRegistration {
  const registered: ChannelTransportRegistration[] = [];
  linePlugin.register({
    runtime: { homeDir },
    registerChannelTransport(transport: ChannelTransportRegistration) {
      registered.push(transport);
    },
  } as unknown as HybridClawPluginApi);
  expect(registered).toHaveLength(1);
  return registered[0] as ChannelTransportRegistration;
}

function makeMessage(params?: {
  from?: string;
  to?: string;
  text?: string;
  contentType?: string;
}) {
  const from = params?.from ?? SELF_MID;
  const to = params?.to ?? SELF_MID;
  return {
    from: { id: from, type: 'USER' },
    to: { id: to, type: 'USER' },
    text: params?.text ?? 'hello',
    raw: { id: '123', from, to, contentType: params?.contentType ?? 'NONE' },
  } as Parameters<typeof processInboundLineSelfMessage>[1]['message'];
}

afterEach(() => {
  unregisterChannelTransport('line');
  vi.restoreAllMocks();
});

test('normalizes only explicit LINE user-MID channel ids', () => {
  expect(buildLineChannelId(SELF_MID.toUpperCase())).toBe(`line:${SELF_MID}`);
  expect(normalizeLineChannelId(` LINE:${SELF_MID} `)).toBe(
    `line:${SELF_MID}`,
  );
  expect(isLineChannelId(`line:${SELF_MID}`)).toBe(true);
  expect(isLineChannelId(SELF_MID)).toBe(false);
  expect(normalizeLineChannelId('line:self')).toBeNull();
  expect(normalizeLineMessageTarget('telegram:123')).toBeNull();
  expect(() => normalizeLineMessageTarget('line:self')).toThrow(
    'LINE send targets must use `line:<linked-user-mid>`.',
  );
});

test('accepts only unprefixed text sent from the linked account to itself', () => {
  const host = makeHost();
  const accepted = processInboundLineSelfMessage(host, {
    message: makeMessage(),
    selfMid: SELF_MID,
    displayName: 'Test User',
  });
  expect(accepted).toMatchObject({
    channelId: `line:${SELF_MID}`,
    userId: SELF_MID,
    username: 'Test User',
    content: 'hello',
  });
  expect(accepted?.sessionId).toContain('channel:line:chat:dm');

  for (const message of [
    makeMessage({ to: OTHER_MID }),
    makeMessage({ from: OTHER_MID }),
    makeMessage({ text: '[HybridClaw] reflected reply' }),
    makeMessage({ contentType: 'IMAGE' }),
  ]) {
    expect(
      processInboundLineSelfMessage(host, { message, selfMid: SELF_MID }),
    ).toBeNull();
  }
});

test('chunks LINE text without dropping content', () => {
  const input = `${'a'.repeat(150)} ${'b'.repeat(150)} ${'c'.repeat(150)}`;
  const chunks = prepareLineTextChunks(input, 200);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
  expect(chunks.join(' ')).toBe(input);
});

test('persists linked LINE status and enforces single-process auth ownership', async () => {
  const store = createLineAuthStore(path.join(makeTempDir(), 'auth'));
  fs.mkdirSync(store.authDir, { recursive: true });
  fs.writeFileSync(
    store.storagePath,
    JSON.stringify({
      [LINE_STORAGE_KEYS.authToken]: 'test-token',
      [LINE_STORAGE_KEYS.profileMid]: SELF_MID,
    }),
  );
  await expect(store.getStatus()).resolves.toEqual({
    linked: true,
    mid: SELF_MID,
  });

  const release = await store.acquireLock('test');
  expect(fs.existsSync(store.lockPath)).toBe(true);
  await expect(store.acquireLock('second')).rejects.toBeInstanceOf(
    LineAuthLockError,
  );
  release();

  await expect(store.reset()).resolves.toBe(store.authDir);
  await expect(store.getStatus()).resolves.toEqual({
    linked: false,
    mid: null,
  });
});

test('transport rejects outbound LINE sends to any account except self', async () => {
  vi.resetModules();
  const sendMessage = vi.fn(async () => {});
  const client = {
    base: { profile: { displayName: 'Test' }, talk: { sendMessage } },
  };
  const manager = {
    getClient: vi.fn(() => client),
    getSelfMid: vi.fn(() => SELF_MID),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    waitForClient: vi.fn(async () => client),
  };
  vi.doMock('../plugins/line/src/connection.js', () => ({
    createLineConnectionManager: vi.fn(() => manager),
  }));

  const { createLineTransport } = await import(
    '../plugins/line/src/transport.js'
  );
  const transport = createLineTransport(makeHost());
  await transport.init(vi.fn(async () => {}));
  await expect(
    transport.sendText(`line:${OTHER_MID}`, 'blocked'),
  ).rejects.toThrow('only permits sends to the linked account');
  await transport.sendText(`line:${SELF_MID}`, 'allowed');
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      to: SELF_MID,
      text: '[HybridClaw] allowed',
      e2ee: true,
    }),
  );
  await expect(
    transport.sendMedia({ jid: `line:${SELF_MID}`, filePath: '/tmp/x' }),
  ).rejects.toThrow('does not support media delivery');
  await transport.shutdown();
  expect(manager.stop).toHaveBeenCalledTimes(1);
});

test('the plugin reads a LINE pairing written by HybridClaw 0.39.1', async () => {
  const homeDir = makeTempDir();
  // 0.39.1 core wrote LINE credentials here with these exact storage keys.
  const authDir = path.join(homeDir, 'credentials', 'line');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, 'storage.json'),
    JSON.stringify({
      '.hybridclaw:authToken': 'test-token',
      '.hybridclaw:profileMid': SELF_MID,
      '.hybridclaw:sync': '{}',
    }),
  );

  const registration = registerPlugin(homeDir);
  await expect(registration.getAuthStatus()).resolves.toEqual({
    linked: true,
    mid: SELF_MID,
  });
  await expect(registration.doctorChecks?.({ enabled: true })).resolves.toEqual(
    [{ severity: 'ok', message: 'LINE linked' }],
  );
  await expect(registration.doctorChecks?.({ enabled: false })).resolves.toEqual(
    [],
  );
  await expect(registration.resetAuth()).resolves.toBe(authDir);
  await expect(registration.getAuthStatus()).resolves.toEqual({
    linked: false,
    mid: null,
  });
});

test('the pairing prompt carries a host-rendered QR SVG and the PIN', () => {
  const pairing = createLinePairingState();
  const host = createLineHost(
    makeBaseHost(),
    createLineAuthStore('/tmp/unused'),
    pairing,
  );
  host.pairing.setQr({ text: 'qr-text', url: 'https://line.example/qr' });
  host.pairing.setPincode('1234');
  expect(pairing.get()).toMatchObject({
    pairingQrText: 'qr-text',
    pairingQrSvg: '<svg data-input="https://line.example/qr"/>',
    pairingUrl: 'https://line.example/qr',
    pincode: '1234',
    error: null,
  });
  host.pairing.clear();
  expect(pairing.get().pairingQrText).toBeNull();
});

test('the registration answers target and prompt questions for core', () => {
  const registration = registerPlugin(makeTempDir());
  expect(registration.getPairingState?.()).toMatchObject({
    pairingQrText: null,
    updatedAt: null,
    error: null,
  });
  expect(registration.matchesTarget(`line:${SELF_MID}`)).toBe(true);
  expect(registration.matchesTarget('491234@s.whatsapp.net')).toBe(false);
  expect(registration.normalizeTarget(` LINE:${SELF_MID} `)).toBe(
    `line:${SELF_MID}`,
  );
  expect(
    registration.messageToolHints?.({ channelId: `line:${SELF_MID}` })[0],
  ).toContain(`line:${SELF_MID}`);
});

test('the registered LINE plugin decides which line: ids are targets', () => {
  const malformed = 'line:self';
  // Without the plugin, stored line: ids stay LINE's (and fail with the
  // install hint) instead of falling through to another channel.
  expect(resolveChannelTargetKind(malformed)).toBe('line');
  registerChannelTransport(registerPlugin(makeTempDir()));
  expect(resolveChannelTargetKind(`line:${SELF_MID}`)).toBe('line');
  expect(resolveChannelTargetKind(malformed)).toBeUndefined();
});

test('core refuses the retired create-only LINE registration', () => {
  expect(() =>
    registerChannelTransport({ kind: 'line', create: vi.fn() } as never),
  ).toThrow(
    'Channel transport "line" uses the retired create-only contract. Update the plugin: hybridclaw plugin reinstall line',
  );
});
