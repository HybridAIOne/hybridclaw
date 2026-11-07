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

test('reports and pauses an interrupted one-shot even without run history', async () => {
  const { jobs, scheduler } = await setup();
  const id = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: 'test-session',
    channelId: 'tui',
    cronExpr: '',
    runAt: '2026-11-07T11:59:00Z',
    prompt: 'Prepare a report',
  });
  jobs.markJobRunStarted(id);
  const runner = vi.fn(async () => {});
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(runner).not.toHaveBeenCalled();
  const task = jobs.getJob(id, { kind: 'scheduled_task' });
  expect(task).toMatchObject({ enabled: 0, last_status: 'error' });
  expect(task?.last_error).toContain('interrupted');
  scheduler.stopScheduler();
  scheduler.startScheduler(runner);
  expect(jobs.getJob(id, { kind: 'scheduled_task' })).toEqual(task);
});

test.each(['fresh', 'paused', 'failed', 'successful', 'interval'] as const)(
  'recovery leaves %s tasks unchanged',
  async (kind) => {
    const { jobs, scheduler } = await setup();
    const id = jobs.createJob({
      kind: 'scheduled_task',
      sessionId: 'test-session',
      channelId: 'tui',
      cronExpr: '',
      ...(kind === 'interval'
        ? { everyMs: 60000 }
        : { runAt: '2026-11-08T12:00:00Z' }),
      prompt: 'Prepare a report',
    });
    if (kind !== 'fresh') jobs.markJobRunStarted(id);
    if (kind === 'paused') jobs.setJobEnabled(id, false);
    if (kind === 'failed') jobs.markJobFailure(id, 5, 'Test failure');
    if (kind === 'successful') jobs.markJobSuccess(id);
    const before = jobs.getJob(id, { kind: 'scheduled_task' });
    scheduler.startScheduler(vi.fn(async () => {}));
    expect(jobs.getJob(id, { kind: 'scheduled_task' })).toEqual(before);
  },
);

test('restarting the timer does not pause a run still active in this process', async () => {
  const { jobs, scheduler } = await setup();
  const id = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: 'test-session',
    channelId: 'tui',
    cronExpr: '',
    runAt: '2026-11-07T11:59:00Z',
    prompt: 'Prepare a report',
  });
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const runner = vi.fn(() => pending);
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(0);
  scheduler.stopScheduler();
  scheduler.startScheduler(runner);
  expect(jobs.getJob(id, { kind: 'scheduled_task' })?.enabled).toBe(1);
  expect(runner).toHaveBeenCalledOnce();
  resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(jobs.getJob(id, { kind: 'scheduled_task' })).toBeNull();
});
