import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  acquireWhatsAppAuthLock,
  getWhatsAppAuthStatus,
  resetWhatsAppAuthState,
  WhatsAppAuthLockError,
  whatsappAuthLockPath,
} from '../src/channels/whatsapp/auth.ts';

function makeTempAuthDir(): string {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-whatsapp-auth-'),
  );
  const authDir = path.join(rootDir, 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.rmSync(whatsappAuthLockPath(authDir), { force: true });
  return authDir;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('treats me.id as linked even when registered is false', async () => {
  const authDir = makeTempAuthDir();
  const credsPath = path.join(authDir, 'creds.json');
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      registered: false,
      me: { id: '491701234567:18@s.whatsapp.net' },
    }),
    'utf-8',
  );

  await expect(getWhatsAppAuthStatus(authDir)).resolves.toEqual({
    linked: true,
    jid: '491701234567:18@s.whatsapp.net',
  });
});

test('returns unlinked when auth state is missing', async () => {
  const authDir = makeTempAuthDir();

  await expect(getWhatsAppAuthStatus(authDir)).resolves.toEqual({
    linked: false,
    jid: null,
  });
});

test('acquires and releases the WhatsApp auth lock', async () => {
  const authDir = makeTempAuthDir();

  const releaseLock = await acquireWhatsAppAuthLock(authDir, {
    purpose: 'test',
    timeoutMs: 0,
  });

  expect(fs.existsSync(whatsappAuthLockPath(authDir))).toBe(true);
  releaseLock();
  expect(fs.existsSync(whatsappAuthLockPath(authDir))).toBe(false);
});

test('fails to acquire the WhatsApp auth lock while the current process holds it', async () => {
  const authDir = makeTempAuthDir();
  const releaseLock = await acquireWhatsAppAuthLock(authDir, {
    purpose: 'test',
    timeoutMs: 0,
  });

  await expect(
    acquireWhatsAppAuthLock(authDir, {
      purpose: 'test-2',
      timeoutMs: 0,
    }),
  ).rejects.toBeInstanceOf(WhatsAppAuthLockError);

  releaseLock();
});

test('clears a stale WhatsApp auth lock owned by a dead pid', async () => {
  const authDir = makeTempAuthDir();
  const lockPath = whatsappAuthLockPath(authDir);
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 999_999,
      startedAt: '2026-03-13T00:00:00.000Z',
      purpose: 'stale',
      cwd: '/tmp',
    }),
    'utf-8',
  );

  const releaseLock = await acquireWhatsAppAuthLock(authDir, {
    purpose: 'fresh',
    timeoutMs: 0,
  });
  expect(fs.existsSync(lockPath)).toBe(true);
  releaseLock();
});

test('reset clears auth files and leaves the auth directory ready for re-pairing', async () => {
  const authDir = makeTempAuthDir();
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{"stale":true}', 'utf-8');

  await resetWhatsAppAuthState(authDir);

  expect(fs.existsSync(path.join(authDir, 'creds.json'))).toBe(false);
  expect(fs.existsSync(authDir)).toBe(true);
  expect(fs.existsSync(whatsappAuthLockPath(authDir))).toBe(false);
});
