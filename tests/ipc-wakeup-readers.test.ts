import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { encodeAuthenticatedInput } from '../container/shared/ipc-input-auth.js';
import { ipcOutputFileName } from '../container/shared/ipc-output-files.js';
import { IPC_RECONCILE_INTERVAL_MS } from '../container/shared/ipc-wakeup.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-ipc-readers-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
});
afterEach(() => vi.useRealTimers());

async function reader(direction: 'input' | 'output' | 'health') {
  const dataDir = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  const input = { sessionId: 'session-a', messages: [] };
  const output = { status: 'success', result: 'ok', toolsUsed: [] };
  vi.stubEnv('HOME', dataDir);
  const gateway = await import('../src/infra/ipc.js');
  gateway.ensureSessionDirs('session-a');
  const ipcDir = gateway.getSessionPaths('session-a', 'main').ipcPath;
  vi.stubEnv('HYBRIDCLAW_AGENT_IPC_DIR', ipcDir);
  const worker = await import('../container/src/ipc.js');
  worker.setIpcAuthSecret('test-key');
  const choices = {
    input: {
      wait: () => worker.waitForInput(10_000),
      name: 'input.json',
      payload: encodeAuthenticatedInput('test-key', JSON.stringify(input)),
      expected: input,
    },
    output: {
      wait: () => gateway.readOutput('session-a', 'request-a', 10_000),
      name: ipcOutputFileName('request-a'),
      payload: JSON.stringify(output),
      expected: output,
    },
    health: {
      wait: () => gateway.readHealthOutput('session-a', 10_000),
      name: 'health-output.json',
      payload: JSON.stringify(output),
      expected: output,
    },
  };
  const choice = choices[direction];
  return { ...choice, file: path.join(ipcDir, choice.name) };
}

test.each(['input', 'output', 'health'] as const)(
  '%s consumes a pre-existing file and closes its watcher',
  async (direction) => {
    const watcher = mockIpcWatcher();
    const ipc = await reader(direction);
    fs.writeFileSync(ipc.file, ipc.payload);
    await expect(ipc.wait()).resolves.toEqual(ipc.expected);
    expect(watcher.watchers[0].closed).toBe(true);
    expect(fs.existsSync(ipc.file)).toBe(false);
  },
);

test.each(['input', 'output'] as const)(
  '%s preserves a partial file, then recovers completion without a second event',
  async (direction) => {
    vi.useFakeTimers();
    const watcher = mockIpcWatcher();
    const ipc = await reader(direction);
    let settled = false;
    const waiting = ipc.wait().finally(() => {
      settled = true;
    });
    fs.writeFileSync(ipc.file, '{');
    watcher.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(fs.existsSync(ipc.file)).toBe(true);
    fs.writeFileSync(ipc.file, ipc.payload);
    await vi.advanceTimersByTimeAsync(IPC_RECONCILE_INTERVAL_MS);
    await expect(waiting).resolves.toEqual(ipc.expected);
    expect(watcher.watchers[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([
  ['input', 'missed'],
  ['output', 'missed'],
  ['input', 'unavailable'],
  ['output', 'unavailable'],
  ['input', 'error'],
  ['output', 'error'],
] as const)(
  '%s reconciles files when watcher delivery is %s',
  async (direction, mode) => {
    vi.useFakeTimers();
    const watcher = mockIpcWatcher();
    if (mode === 'unavailable')
      watcher.watch.mockImplementation(() => {
        throw new Error('unsupported');
      });
    const ipc = await reader(direction);
    const waiting = ipc.wait();
    if (mode === 'error') {
      watcher.watchers[0].emit('error', new Error('unavailable'));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(123);
    fs.writeFileSync(ipc.file, ipc.payload);
    await vi.advanceTimersByTimeAsync(IPC_RECONCILE_INTERVAL_MS);
    await expect(waiting).resolves.toEqual(ipc.expected);
    expect(fs.existsSync(ipc.file)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(['input', 'output'] as const)(
  '%s checks idle files once per second and cleans up on timeout',
  async (direction) => {
    vi.useFakeTimers();
    const watcher = mockIpcWatcher();
    const ipc = await reader(direction);
    const exists = vi.spyOn(fs, 'existsSync');
    const waiting = ipc.wait();
    await vi.advanceTimersByTimeAsync(9_500);
    expect(exists).toHaveBeenCalledTimes(direction === 'input' ? 20 : 10);
    await vi.advanceTimersByTimeAsync(500);
    if (direction === 'input') await expect(waiting).resolves.toBeNull();
    else
      await expect(waiting).resolves.toMatchObject({
        status: 'error',
        error: expect.stringContaining('Timeout'),
      });
    expect(watcher.watchers[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);
