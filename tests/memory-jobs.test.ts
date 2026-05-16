import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-memory-jobs-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  cleanup: () => {
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
});

test('updateJob only updates persisted scheduler jobs', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, withMemoryDatabase } = await import(
    '../src/memory/db.ts'
  );
  const { createJob, getAllJobs, updateJob, upsertJob } = await import(
    '../src/memory/jobs.ts'
  );

  initDatabase({ quiet: true });

  const legacyTaskId = createJob({
    kind: 'scheduled_task',
    sessionId: 'session-1',
    channelId: 'channel-1',
    cronExpr: '* * * * *',
    prompt: 'Run the legacy task.',
  });

  expect(legacyTaskId).toBe(1);
  expect(() =>
    updateJob({
      id: `task:${legacyTaskId}`,
      schedule: {
        kind: 'cron',
        at: null,
        everyMs: null,
        expr: '*/5 * * * *',
        tz: 'UTC',
      },
      action: {
        kind: 'agent_turn',
        message: 'This must not overwrite the scheduled task.',
      },
      delivery: {
        kind: 'channel',
        channel: 'channel-1',
        to: 'channel-1',
        webhookUrl: '',
      },
      enabled: true,
    }),
  ).toThrow('Scheduler job `task:1` was not found.');

  const scheduledTasks = getAllJobs({ kind: 'scheduled_task' });
  expect(scheduledTasks).toHaveLength(1);
  expect(scheduledTasks[0]).toMatchObject({
    id: legacyTaskId,
    prompt: 'Run the legacy task.',
  });
  expect(
    withMemoryDatabase((database) =>
      database
        .prepare(
          "SELECT sort_order AS sortOrder FROM jobs WHERE kind = 'scheduled_task' AND legacy_task_id = ?",
        )
        .get(legacyTaskId),
    ),
  ).toMatchObject({ sortOrder: 0 });

  upsertJob({
    id: 'scheduler-job',
    schedule: {
      kind: 'cron',
      at: null,
      everyMs: null,
      expr: '* * * * *',
      tz: 'UTC',
    },
    action: {
      kind: 'agent_turn',
      message: 'Run the scheduler job.',
    },
    delivery: {
      kind: 'channel',
      channel: 'channel-1',
      to: 'channel-1',
      webhookUrl: '',
    },
    enabled: true,
  });

  expect(
    updateJob({
      id: 'scheduler-job',
      schedule: {
        kind: 'cron',
        at: null,
        everyMs: null,
        expr: '*/10 * * * *',
        tz: 'UTC',
      },
      action: {
        kind: 'agent_turn',
        message: 'Run the updated scheduler job.',
      },
      delivery: {
        kind: 'channel',
        channel: 'channel-1',
        to: 'channel-1',
        webhookUrl: '',
      },
      enabled: true,
    }),
  ).toMatchObject({
    id: 'scheduler-job',
    action: {
      kind: 'agent_turn',
      message: 'Run the updated scheduler job.',
    },
  });
});
