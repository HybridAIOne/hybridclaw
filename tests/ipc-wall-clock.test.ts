import { beforeEach, expect, it, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-ipc-clock-');
const active: Array<{ controller: AbortController; output: Promise<unknown> }> =
  [];
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  cleanup: async () => {
    for (const { controller } of active) controller.abort();
    await vi.advanceTimersByTimeAsync(2_001);
    await Promise.allSettled(active.map(({ output }) => output));
    active.length = 0;
    vi.useRealTimers();
    await cleanupGatewayRuntime();
  },
});
beforeEach(() => {
  const home = makeTempDir();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', home);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  mockIpcWatcher();
  vi.useFakeTimers();
});

async function startRead(idle: number | null, wall?: number, tracking = false) {
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('example-session');
  const controller = new AbortController();
  const activity = tracking ? ipc.createActivityTracker() : undefined;
  const done = vi.fn();
  const output = ipc
    .readOutput('example-session', 'example-request', idle, {
      maxWallClockMs: wall,
      signal: controller.signal,
      activity,
    })
    .then((result) => {
      done(result);
      return result;
    });
  active.push({ controller, output });
  return { output, done, activity };
}

it.each([false, true])(
  'honors a shorter explicit wall limit (activity: %s)',
  async (tracking) => {
    const { output, done, activity } = await startRead(300, 180, tracking);
    await vi.advanceTimersByTimeAsync(179);
    activity?.notify();
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
    await expect(output).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('180ms total'),
    });
  },
);

it('keeps the independent shorter inactivity stop', async () => {
  const { output } = await startRead(100, 300);
  await vi.advanceTimersByTimeAsync(100);
  await expect(output).resolves.toMatchObject({
    status: 'error',
    error: 'Timeout waiting for agent output after 100ms',
  });
});

it.each([180, undefined])(
  'retains explicit or unbounded waits without inactivity (%s)',
  async (wall) => {
    const { output, done } = await startRead(null, wall);
    await vi.advanceTimersByTimeAsync(180);
    if (wall === undefined) expect(done).not.toHaveBeenCalled();
    else {
      expect(done).toHaveBeenCalledOnce();
      await expect(output).resolves.toMatchObject({
        status: 'error',
        error: expect.stringContaining('180ms total'),
      });
    }
  },
);

it('lets activity refresh inactivity while retaining a longer explicit cap', async () => {
  const { output, done, activity } = await startRead(100, 300, true);
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(80);
    activity?.notify();
  }
  await vi.advanceTimersByTimeAsync(59);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toHaveBeenCalledOnce();
  await expect(output).resolves.toMatchObject({
    status: 'error',
    error: expect.stringContaining('300ms total'),
  });
});
