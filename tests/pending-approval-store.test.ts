import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { lockMemoryFile } from '../container/shared/memory-file.js';
import {
  loadSessionPendingApprovals,
  saveSessionPendingApprovals,
  type PendingApproval,
} from '../container/src/pending-approval-store.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeDir = useTempDir('hy-pending-store-');
useCleanMocks({ restoreAllMocks: true });
function request(sessionHash: string, id = sessionHash): PendingApproval {
  return {
    id,
    sessionHash,
    userHash: 'user-a',
    fingerprint: 'fingerprint',
    actionKey: 'action',
    toolName: 'example_tool',
    argsJson: '{"value":"example"}',
    intent: 'example action',
    consequenceIfDenied: 'skip action',
    reason: 'requires review',
    commandPreview: 'example',
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    originalPrompt: 'perform action',
    pinned: true,
  };
}

test('independent sessions saving concurrently retain both requests', async () => {
  const file = path.join(makeDir(), 'pending.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, pending: [] }));
  const moduleUrl = new URL(
    '../container/src/pending-approval-store.ts',
    import.meta.url,
  ).href;
  const children = ['session-a', 'session-b'].map((session) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs';
      import { saveSessionPendingApprovals } from ${JSON.stringify(moduleUrl)};
      const file = process.argv[1];
      const read = fs.readFileSync;
      fs.readFileSync = function(target, ...args) {
        const result = read.call(this, target, ...args);
        if (target === file) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        return result;
      };
      process.on('message', () => {
        try { saveSessionPendingApprovals(file, process.argv[2], [JSON.parse(process.argv[3])]); process.disconnect(); }
        catch (error) { console.error(error); process.exit(1); }
      });
      process.send('ready');
    `,
        file,
        session,
        JSON.stringify(request(session)),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', () =>
        reject(new Error(stderr || 'exited before ready')),
      );
    });
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
    });
    // Observe rejection immediately, while waiting for the start barrier.
    void done.catch(() => {});
    return { child, ready, done };
  });
  try {
    await Promise.all(children.map((item) => item.ready));
    for (const item of children) item.child.send('save');
    await Promise.all(children.map((item) => item.done));
    expect(
      JSON.parse(fs.readFileSync(file, 'utf8'))
        .pending.map((entry: PendingApproval) => entry.sessionHash)
        .sort(),
    ).toEqual(['session-a', 'session-b']);
  } finally {
    for (const item of children)
      if (item.child.exitCode === null) item.child.kill();
    await Promise.allSettled(children.map((item) => item.done));
  }
});

test('failed persistence throws, preserves the file and releases the lock', () => {
  const file = path.join(makeDir(), 'pending.json');
  saveSessionPendingApprovals(file, 'session-a', [request('session-a')]);
  const before = fs.readFileSync(file, 'utf8');
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('write failed');
  });
  expect(() =>
    saveSessionPendingApprovals(file, 'session-b', [request('session-b')]),
  ).toThrow('write failed');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  const release = lockMemoryFile(file);
  release();
});

test('an unreadable or malformed store cannot be overwritten as an empty store', () => {
  const file = path.join(makeDir(), 'pending.json');
  fs.writeFileSync(file, '{invalid');
  expect(() =>
    saveSessionPendingApprovals(file, 'session-a', [request('session-a')]),
  ).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('{invalid');
});

test('expiry pruning preserves live requests from all sessions', () => {
  const file = path.join(makeDir(), 'pending.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      pending: [
        request('session-a'),
        request('session-b'),
        { ...request('session-a', 'expired'), expiresAtMs: Date.now() - 1 },
      ],
    }),
  );
  expect(
    loadSessionPendingApprovals(file, 'session-a').map((item) => item.id),
  ).toEqual(['session-a']);
  expect(
    loadSessionPendingApprovals(file, 'session-b').map((item) => item.id),
  ).toEqual(['session-b']);
});

test('a held or abandoned lock fails closed without stealing it', () => {
  const file = path.join(makeDir(), 'pending.json');
  const release = lockMemoryFile(file);
  const pending = request('session-a');
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValue(5_001);
  try {
    expect(() =>
      saveSessionPendingApprovals(file, 'session-a', [pending]),
    ).toThrow('locked');
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    now.mockRestore();
    release();
  }
});

test('a session cannot save requests owned by another session', () => {
  const file = path.join(makeDir(), 'pending.json');
  expect(() =>
    saveSessionPendingApprovals(file, 'session-a', [request('session-b')]),
  ).toThrow('session mismatch');
  expect(fs.existsSync(file)).toBe(false);
});
