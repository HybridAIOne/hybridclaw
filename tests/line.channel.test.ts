import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
// The LINE transport lives in the bundled install-on-demand plugin; its
// linejs-free modules are imported directly so the suite runs without the
// plugin's dependency closure installed.
import { prepareLineTextChunks } from '../plugins/line/src/delivery.js';
import { processInboundLineSelfMessage } from '../plugins/line/src/inbound.js';
import { DEFAULT_AGENT_ID } from '../src/agents/agent-types.js';
import { normalizeNativeAgentAddressingText } from '../src/channels/agent-addressing.js';
import {
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import {
  acquireLineAuthLock,
  getLineAuthStatus,
  LINE_AUTH_STORAGE_KEY,
  LINE_PROFILE_MID_STORAGE_KEY,
  LineAuthLockError,
  lineAuthLockPath,
  lineAuthStoragePath,
  resetLineAuthState,
} from '../src/channels/line/auth.js';
import {
  createLinePairingSession,
  initLine,
  isLineTransportInstalled,
  LINE_PLUGIN_INSTALL_COMMAND,
  LineTransportMissingError,
  sendToLineSelfChat,
  shutdownLine,
} from '../src/channels/line/runtime.js';
import {
  buildLineChannelId,
  isLineChannelId,
  normalizeLineChannelId,
  normalizeLineUserMid,
} from '../src/channels/line/target.js';
import type { LineTransportHost } from '../src/channels/line/transport-host.js';
import { buildSessionKey } from '../src/session/session-key.js';

const SELF_MID = `u${'a'.repeat(32)}`;
const OTHER_MID = `u${'b'.repeat(32)}`;

function makeHost(): LineTransportHost {
  return {
    defaultAgentId: DEFAULT_AGENT_ID,
    logger: {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as LineTransportHost['logger'],
    getConfig: () => ({ enabled: true, textChunkLimit: 5_000 }),
    auth: {
      authDir: '/tmp/unused',
      storageKeys: {
        authToken: LINE_AUTH_STORAGE_KEY,
        profileMid: LINE_PROFILE_MID_STORAGE_KEY,
        sync: '.hybridclaw:sync',
      },
      acquireLock: vi.fn(async () => () => {}),
      ensureStoragePath: vi.fn(async () => '/tmp/unused/storage.json'),
    },
    pairing: {
      clear: vi.fn(),
      setError: vi.fn(),
      setPincode: vi.fn(),
      setQr: vi.fn(),
    },
    target: {
      normalizeUserMid: normalizeLineUserMid,
      buildChannelId: buildLineChannelId,
      normalizeChannelId: normalizeLineChannelId,
    },
    text: {
      normalizeNativeAgentAddressingText,
    },
    buildSessionKey,
  };
}

function makeMessage(params?: {
  from?: string;
  to?: string;
  text?: string;
  contentType?: string;
}) {
  const from = params?.from ?? SELF_MID;
  const to = params?.to ?? SELF_MID;
  const text = params?.text ?? 'hello';
  return {
    from: { id: from, type: 'USER' },
    to: { id: to, type: 'USER' },
    text,
    raw: {
      id: '123',
      from,
      to,
      contentType: params?.contentType ?? 'NONE',
    },
  } as Parameters<typeof processInboundLineSelfMessage>[1]['message'];
}

function makeTempAuthDir(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-line-auth-')),
    'auth',
  );
}

afterEach(async () => {
  await shutdownLine();
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

  expect(
    processInboundLineSelfMessage(host, {
      message: makeMessage({ to: OTHER_MID }),
      selfMid: SELF_MID,
    }),
  ).toBeNull();
  expect(
    processInboundLineSelfMessage(host, {
      message: makeMessage({ from: OTHER_MID }),
      selfMid: SELF_MID,
    }),
  ).toBeNull();
  expect(
    processInboundLineSelfMessage(host, {
      message: makeMessage({ text: '[HybridClaw] reflected reply' }),
      selfMid: SELF_MID,
    }),
  ).toBeNull();
  expect(
    processInboundLineSelfMessage(host, {
      message: makeMessage({ contentType: 'IMAGE' }),
      selfMid: SELF_MID,
    }),
  ).toBeNull();
});

test('chunks LINE text without dropping content', () => {
  const input = `${'a'.repeat(150)} ${'b'.repeat(150)} ${'c'.repeat(150)}`;
  const chunks = prepareLineTextChunks(input, 200);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
  expect(chunks.join(' ')).toBe(input);
});

test('persists linked LINE status and enforces single-process auth ownership', async () => {
  const authDir = makeTempAuthDir();
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    lineAuthStoragePath(authDir),
    JSON.stringify({
      [LINE_AUTH_STORAGE_KEY]: 'test-token',
      [LINE_PROFILE_MID_STORAGE_KEY]: SELF_MID,
    }),
  );
  await expect(getLineAuthStatus(authDir)).resolves.toEqual({
    linked: true,
    mid: SELF_MID,
  });

  const release = await acquireLineAuthLock(authDir, 'test');
  expect(fs.existsSync(lineAuthLockPath(authDir))).toBe(true);
  await expect(acquireLineAuthLock(authDir, 'second')).rejects.toBeInstanceOf(
    LineAuthLockError,
  );
  release();

  await resetLineAuthState(authDir);
  await expect(getLineAuthStatus(authDir)).resolves.toEqual({
    linked: false,
    mid: null,
  });
});

test('transport rejects outbound LINE sends to any account except self', async () => {
  vi.resetModules();
  const sendMessage = vi.fn(async () => {});
  const client = {
    base: {
      profile: { displayName: 'Test' },
      talk: { sendMessage },
    },
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

test('reports actionable errors when the LINE transport is not installed', async () => {
  expect(isLineTransportInstalled()).toBe(false);
  await expect(initLine(vi.fn(async () => {}))).rejects.toBeInstanceOf(
    LineTransportMissingError,
  );
  await expect(sendToLineSelfChat(`line:${SELF_MID}`, 'hello')).rejects.toThrow(
    LINE_PLUGIN_INSTALL_COMMAND,
  );
});

test('runtime facade drives the registered transport and retains it for shutdown', async () => {
  const pairingSession = {
    start: vi.fn(async () => {}),
    waitForConnection: vi.fn(async () => ({ id: SELF_MID })),
    stop: vi.fn(async () => {}),
  };
  const instance = {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendMedia: vi.fn(async () => {}),
    createPairingSession: vi.fn(async () => pairingSession),
  };
  const create = vi.fn(() => instance);
  registerChannelTransport({ kind: 'line', create });

  const handler = vi.fn(async () => {});
  await initLine(handler);
  await sendToLineSelfChat(`line:${SELF_MID}`, 'hello');
  await expect(createLinePairingSession()).resolves.toBe(pairingSession);

  expect(create).toHaveBeenCalledTimes(1);
  expect(instance.init).toHaveBeenCalledTimes(1);
  expect(instance.sendText).toHaveBeenCalledWith(`line:${SELF_MID}`, 'hello');

  const wrappedHandler = instance.init.mock.calls[0]?.[0] as (
    ...args: unknown[]
  ) => Promise<void>;
  const reply = vi.fn(async () => {});
  const context = {
    abortSignal: new AbortController().signal,
    batchedMessages: [],
    rawMessage: {},
    chatJid: `line:${SELF_MID}`,
    senderJid: SELF_MID,
    isGroup: false,
  };
  await wrappedHandler(
    'session',
    null,
    `line:${SELF_MID}`,
    SELF_MID,
    'Test User',
    'hello',
    [],
    reply,
    context,
  );
  expect(handler).toHaveBeenCalledWith(
    'session',
    null,
    `line:${SELF_MID}`,
    SELF_MID,
    'Test User',
    'hello',
    [],
    reply,
    context,
  );

  unregisterChannelTransport('line');
  await shutdownLine();
  expect(instance.shutdown).toHaveBeenCalledTimes(1);
});
