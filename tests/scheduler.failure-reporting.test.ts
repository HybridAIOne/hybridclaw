import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

const makeTempHome = useTempDir('hybridclaw-scheduler-failures-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    vi.useRealTimers();
    restoreEnvVar('HOME', ORIGINAL_HOME);
    restoreEnvVar(
      'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
      ORIGINAL_DISABLE_CONFIG_WATCHER,
    );
  },
  resetModules: true,
});

async function setupScheduler(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const jobs = await import('../src/memory/jobs.ts');
  const scheduler = await import('../src/scheduler/scheduler.ts');
  const { getGatewayAdminScheduler } = await import(
    '../src/gateway/gateway-scheduled-task-service.ts'
  );
  initDatabase({ quiet: true });
  jobs.replaceJobs([]);
  return { jobs, scheduler, getGatewayAdminScheduler };
}

test('one-shot tasks whose run fails are preserved with the failure reason', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T08:00:00.000Z'));
  const { jobs, scheduler, getGatewayAdminScheduler } = await setupScheduler(
    makeTempHome(),
  );

  const taskId = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: 'dm:user-a',
    channelId: '123456789012345678',
    cronExpr: '',
    runAt: '2026-09-06T07:59:00.000Z',
    prompt: 'Drink water',
  });

  const runner = vi.fn(async () => {
    throw new Error('No chatbot configured for model "gpt-4.1-mini"');
  });
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(0);
  scheduler.stopScheduler();

  expect(runner).toHaveBeenCalledTimes(1);
  const task = jobs.getJob(taskId, { kind: 'scheduled_task' });
  expect(task).toMatchObject({
    enabled: 1,
    last_status: 'error',
    last_error: 'No chatbot configured for model "gpt-4.1-mini"',
    consecutive_errors: 1,
  });
  expect(task?.last_run).toBeTruthy();

  const adminJob = getGatewayAdminScheduler().jobs.find(
    (job) => job.id === `task:${taskId}`,
  );
  expect(adminJob).toMatchObject({
    lastStatus: 'error',
    lastError: 'No chatbot configured for model "gpt-4.1-mini"',
    consecutiveErrors: 1,
  });
});

test('tasks with unparsable cron expressions are disabled once with the parse error recorded', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T08:00:00.000Z'));
  const { jobs, scheduler } = await setupScheduler(makeTempHome());

  const taskId = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: 'dm:user-a',
    channelId: '123456789012345678',
    cronExpr: '61 * * * *',
    prompt: 'Broken cron',
  });

  const runner = vi.fn(async () => {});
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(120_000);
  scheduler.stopScheduler();

  expect(runner).not.toHaveBeenCalled();
  const task = jobs.getJob(taskId, { kind: 'scheduled_task' });
  expect(task).toMatchObject({
    enabled: 0,
    last_status: 'error',
  });
  expect(task?.last_error).toContain('Invalid cron expression "61 * * * *"');
  expect(
    jobs.getAllJobs({ kind: 'scheduled_task', enabledOnly: true }),
  ).toHaveLength(0);
});

test('config scheduler jobs expose the failure reason in their runtime state', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T08:00:00.000Z'));
  const { jobs, scheduler, getGatewayAdminScheduler } = await setupScheduler(
    makeTempHome(),
  );

  jobs.upsertJob({
    id: 'ops-ping',
    name: 'Ops ping',
    enabled: true,
    schedule: {
      kind: 'every',
      at: null,
      everyMs: 60_000,
      expr: null,
      tz: '',
    },
    action: { kind: 'agent_turn', message: 'Ping ops.' },
    delivery: { kind: 'channel', channel: 'tui', to: 'tui', webhookUrl: '' },
  });

  const runner = vi.fn(async () => {
    throw new Error('Delivery to tui failed: inbox closed');
  });
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(0);
  scheduler.stopScheduler();

  expect(runner).toHaveBeenCalledTimes(1);
  expect(scheduler.getConfigJobState('ops-ping')).toMatchObject({
    lastStatus: 'error',
    lastError: 'Delivery to tui failed: inbox closed',
    consecutiveErrors: 1,
  });
  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === 'ops-ping'),
  ).toMatchObject({
    lastStatus: 'error',
    lastError: 'Delivery to tui failed: inbox closed',
  });
});
