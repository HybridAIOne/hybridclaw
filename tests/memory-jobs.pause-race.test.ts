import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir();
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
});
async function setup() {
  vi.stubEnv('HOME', makeTempDir());
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  return db;
}

test.each([1, 5])(
  'a late failure preserves a paused task at threshold %s',
  async (threshold) => {
    await setup();
    const jobs = await import('../src/memory/jobs.js');
    const id = jobs.createJob({
      kind: 'scheduled_task',
      sessionId: 'test-session',
      channelId: 'tui',
      cronExpr: '',
      everyMs: 60000,
      prompt: 'Prepare a report',
    });
    jobs.markJobRunStarted(id);
    jobs.setJobEnabled(id, false);
    jobs.markJobFailure(id, threshold, new Error('Test failure'));
    expect(jobs.getJob(id, { kind: 'scheduled_task' })).toMatchObject({
      enabled: 0,
      last_status: 'error',
      last_error: 'Test failure',
      consecutive_errors: 1,
    });
  },
);

test('failure keeps enabled tasks enabled until the threshold, then pauses them', async () => {
  await setup();
  const jobs = await import('../src/memory/jobs.js');
  const id = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: 'test-session',
    channelId: 'tui',
    cronExpr: '',
    everyMs: 60000,
    prompt: 'Prepare a report',
  });
  expect(jobs.markJobFailure(id, 2, 'Test failure')).toEqual({
    disabled: false,
    consecutiveErrors: 1,
  });
  expect(jobs.getJob(id, { kind: 'scheduled_task' })?.enabled).toBe(1);
  expect(jobs.markJobFailure(id, 2, 'Test failure')).toEqual({
    disabled: true,
    consecutiveErrors: 2,
  });
  expect(jobs.getJob(id, { kind: 'scheduled_task' })?.enabled).toBe(0);
});
