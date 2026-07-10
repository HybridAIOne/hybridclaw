import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TalkMessage } from '@jsr/evex__linejs';
import { expect, test, vi } from 'vitest';
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
import { prepareLineTextChunks } from '../src/channels/line/delivery.js';
import { processInboundLineSelfMessage } from '../src/channels/line/inbound.js';
import {
  buildLineChannelId,
  isLineChannelId,
  normalizeLineChannelId,
} from '../src/channels/line/target.js';

const SELF_MID = `u${'a'.repeat(32)}`;
const OTHER_MID = `u${'b'.repeat(32)}`;

function makeMessage(params?: {
  from?: string;
  to?: string;
  text?: string;
  contentType?: string;
}): TalkMessage {
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
  } as unknown as TalkMessage;
}

function makeTempAuthDir(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-line-auth-')),
    'auth',
  );
}

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
  const accepted = processInboundLineSelfMessage({
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
    processInboundLineSelfMessage({
      message: makeMessage({ to: OTHER_MID }),
      selfMid: SELF_MID,
    }),
  ).toBeNull();
  expect(
    processInboundLineSelfMessage({
      message: makeMessage({ from: OTHER_MID }),
      selfMid: SELF_MID,
    }),
  ).toBeNull();
  expect(
    processInboundLineSelfMessage({
      message: makeMessage({ text: '[HybridClaw] reflected reply' }),
      selfMid: SELF_MID,
    }),
  ).toBeNull();
  expect(
    processInboundLineSelfMessage({
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

test('runtime rejects outbound LINE sends to any account except self', async () => {
  vi.resetModules();
  const sendChunkedLineText = vi.fn(async () => {});
  const manager = {
    getClient: vi.fn(() => ({ base: { profile: { displayName: 'Test' } } })),
    getSelfMid: vi.fn(() => SELF_MID),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    waitForClient: vi.fn(async () => ({ base: {} })),
  };
  vi.doMock('../src/channels/line/connection.js', () => ({
    createLineConnectionManager: vi.fn(() => manager),
  }));
  vi.doMock('../src/channels/line/delivery.js', () => ({ sendChunkedLineText }));
  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: vi.fn(() => ({
      line: { enabled: true, textChunkLimit: 5_000 },
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: { warn: vi.fn() },
  }));

  const { createLineRuntime } = await import(
    '../src/channels/line/runtime.js'
  );
  const runtime = createLineRuntime();
  await runtime.initLine(async () => {});
  await expect(
    runtime.sendToLineSelfChat(`line:${OTHER_MID}`, 'blocked'),
  ).rejects.toThrow('only permits sends to the linked account');
  await runtime.sendToLineSelfChat(`line:${SELF_MID}`, 'allowed');
  expect(sendChunkedLineText).toHaveBeenCalledWith(
    expect.objectContaining({ to: SELF_MID, text: '[HybridClaw] allowed' }),
  );
  await runtime.shutdownLine();
});
