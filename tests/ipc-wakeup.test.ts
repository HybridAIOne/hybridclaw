import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createIpcWakeup,
  IPC_RECONCILE_INTERVAL_MS,
} from '../container/shared/ipc-wakeup.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-ipc-wakeup-');
useCleanMocks({ restoreAllMocks: true });
afterEach(() => vi.useRealTimers());

test('a real directory rename wakes a reader before reconciliation', async () => {
  const directory = makeTempDir();
  const wakeup = createIpcWakeup(directory);
  try {
    const waiting = wakeup
      .wait(500)
      .then(() => fs.existsSync(path.join(directory, 'reply.json')));
    const temporary = path.join(directory, 'reply.tmp');
    fs.writeFileSync(temporary, '{}');
    fs.renameSync(temporary, path.join(directory, 'reply.json'));
    const start = Date.now();
    await expect(waiting).resolves.toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  } finally {
    wakeup.close();
  }
});

test('events between scans and waits are remembered and bursts coalesce', async () => {
  vi.useFakeTimers();
  const watcher = mockIpcWatcher();
  const wakeup = createIpcWakeup(makeTempDir());
  try {
    watcher.notify();
    watcher.notify();
    await expect(wakeup.wait(IPC_RECONCILE_INTERVAL_MS)).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    let settled = false;
    const waiting = wakeup.wait(IPC_RECONCILE_INTERVAL_MS).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    watcher.notify();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    wakeup.close();
  }
});

test.each(['missing event', 'setup failure', 'watch error', 'watch close'])(
  '%s still permits periodic reconciliation',
  async (mode) => {
    vi.useFakeTimers();
    const watcher = mockIpcWatcher();
    if (mode === 'setup failure')
      watcher.watch.mockImplementation(() => {
        throw new Error('unsupported');
      });
    const wakeup = createIpcWakeup(makeTempDir());
    try {
      const firstWait = wakeup.wait(IPC_RECONCILE_INTERVAL_MS);
      if (mode === 'watch error')
        watcher.watchers[0].emit('error', new Error('unavailable'));
      if (mode === 'watch close') watcher.watchers[0].close();
      await vi.advanceTimersByTimeAsync(IPC_RECONCILE_INTERVAL_MS);
      await expect(firstWait).resolves.toBe(false);
      const nextWait = wakeup.wait(IPC_RECONCILE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(IPC_RECONCILE_INTERVAL_MS);
      await expect(nextWait).resolves.toBe(false);
    } finally {
      wakeup.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(['abort', 'close'])(
  '%s settles an active wait and removes its timer and abort listener',
  async (mode) => {
    vi.useFakeTimers();
    const watcher = mockIpcWatcher();
    const wakeup = createIpcWakeup(makeTempDir());
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = wakeup.wait(IPC_RECONCILE_INTERVAL_MS, controller.signal);
    if (mode === 'abort') controller.abort();
    else wakeup.close();
    await expect(waiting).resolves.toBe(mode === 'abort');
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    wakeup.close();
    expect(watcher.watchers[0].closed).toBe(true);
    await expect(wakeup.wait(IPC_RECONCILE_INTERVAL_MS)).resolves.toBe(false);
  },
);

test('an already aborted signal schedules no wait', async () => {
  vi.useFakeTimers();
  mockIpcWatcher();
  const wakeup = createIpcWakeup(makeTempDir());
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(
      wakeup.wait(IPC_RECONCILE_INTERVAL_MS, controller.signal),
    ).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    wakeup.close();
  }
});
