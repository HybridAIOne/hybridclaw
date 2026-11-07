import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir();
useCleanMocks({
  cleanup: async () => {
    const scheduler = await import('../src/scheduler/scheduler.js');
    scheduler.stopScheduler();
    await cleanupGatewayRuntime();
    vi.useRealTimers();
  },
  resetModules: true,
  unstubAllEnvs: true,
});

async function setup() {
  vi.stubEnv('HOME', makeTempDir());
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const scheduler = await import('../src/scheduler/scheduler.js');
  db.initDatabase({ quiet: true });
  jobs.replaceJobs([]);
  return { db, jobs, scheduler };
}

test.each(['one_shot', 'at', 'every', 'cron'] as const)(
  '%s jobs do not overlap and release the guard on settlement',
  async (kind) => {
    const { jobs, scheduler } = await setup();
    jobs.replaceJobs([
      {
        id: 'test-job',
        name: 'Test job',
        enabled: true,
        schedule: {
          kind,
          at: '2026-11-07T12:00:00Z',
          everyMs: 60000,
          expr: '* * * * *',
          tz: 'UTC',
        },
        action: { kind: 'agent_turn', message: 'Prepare a report' },
        delivery: { kind: 'channel', to: 'tui', webhookUrl: null },
      },
    ]);
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const runner = vi.fn(() => pending);
    scheduler.startScheduler(runner);
    await vi.advanceTimersByTimeAsync(kind === 'cron' ? 60000 : 0);
    expect(runner).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180000);
    expect(runner).toHaveBeenCalledOnce();
    expect(scheduler.getSchedulerStatus()[0].nextRunAt).toBeNull();
    runner.mockResolvedValue();
    reject(new Error('Test failure'));
    await vi.advanceTimersByTimeAsync(0);
    if (runner.mock.calls.length === 1)
      await vi.advanceTimersByTimeAsync(60000);
    expect(runner).toHaveBeenCalledTimes(2);
    if (kind === 'one_shot' || kind === 'at') {
      await vi.advanceTimersByTimeAsync(180000);
      expect(runner).toHaveBeenCalledTimes(2);
    }
  },
);
