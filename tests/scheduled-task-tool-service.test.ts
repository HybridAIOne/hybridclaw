import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-cron-tool-service-');

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
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
});

async function setup() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const rearmScheduler = vi.fn();
  vi.doMock('../src/scheduler/scheduler.js', () => ({ rearmScheduler }));

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getOrCreateSession } = await import('../src/memory/sessions.ts');
  const { createJob, getAllJobs } = await import('../src/memory/jobs.ts');
  const { runScheduledTaskToolAction } = await import(
    '../src/gateway/scheduled-task-tool-service.ts'
  );
  const { GatewayRequestError } = await import(
    '../src/errors/gateway-request-error.ts'
  );

  initDatabase({ quiet: true });
  getOrCreateSession('session-1', null, 'discord-channel-1');

  return {
    rearmScheduler,
    createJob,
    getAllJobs,
    runScheduledTaskToolAction,
    GatewayRequestError,
  };
}

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? -1;
  }
  return 200;
}

test('add persists the job before returning its id and re-arms the scheduler', async () => {
  const { rearmScheduler, getAllJobs, runScheduledTaskToolAction } =
    await setup();

  const result = runScheduledTaskToolAction({
    action: 'add',
    sessionId: 'session-1',
    channelId: 'ops@example.com',
    everyMs: 1_800_000,
    prompt: 'Write a short operational update email.',
  });

  expect(result).toMatchObject({
    ok: true,
    action: 'add',
    channelId: 'ops@example.com',
    everyMs: 1_800_000,
  });
  const tasks = getAllJobs({ kind: 'scheduled_task', sessionId: 'session-1' });
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    id: result.taskId,
    session_id: 'session-1',
    channel_id: 'ops@example.com',
    every_ms: 1_800_000,
    prompt: 'Write a short operational update email.',
  });
  expect(rearmScheduler).toHaveBeenCalledTimes(1);
});

test('add falls back to the session channel for delivery', async () => {
  const { getAllJobs, runScheduledTaskToolAction } = await setup();

  runScheduledTaskToolAction({
    action: 'add',
    sessionId: 'session-1',
    cronExpr: '0 7 * * *',
    prompt: 'Write the briefing.',
  });

  expect(
    getAllJobs({ kind: 'scheduled_task', sessionId: 'session-1' })[0],
  ).toMatchObject({ channel_id: 'discord-channel-1', cron_expr: '0 7 * * *' });
});

test('rejects unknown sessions and malformed payloads without creating jobs', async () => {
  const { getAllJobs, rearmScheduler, runScheduledTaskToolAction } =
    await setup();

  expect(statusOf(() => runScheduledTaskToolAction('nope'))).toBe(400);
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({ action: 'list', sessionId: 'session-1' }),
    ),
  ).toBe(400);
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'add',
        sessionId: 'session-missing',
        everyMs: 60_000,
        prompt: 'x',
      }),
    ),
  ).toBe(404);
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'add',
        sessionId: 'session-1',
        everyMs: 60_000,
      }),
    ),
  ).toBe(400);
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'add',
        sessionId: 'session-1',
        everyMs: 60_000,
        cronExpr: '0 7 * * *',
        prompt: 'x',
      }),
    ),
  ).toBe(400);
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'add',
        sessionId: 'session-1',
        runAt: '2000-01-01T00:00:00.000Z',
        prompt: 'x',
      }),
    ),
  ).toBe(400);

  expect(getAllJobs({ kind: 'scheduled_task' })).toHaveLength(0);
  expect(rearmScheduler).not.toHaveBeenCalled();
});

test('remove only deletes tasks owned by the calling session', async () => {
  const { createJob, getAllJobs, runScheduledTaskToolAction } = await setup();
  const ownTaskId = createJob({
    kind: 'scheduled_task',
    sessionId: 'session-1',
    channelId: 'discord-channel-1',
    cronExpr: '0 7 * * *',
    prompt: 'mine',
  });
  const otherTaskId = createJob({
    kind: 'scheduled_task',
    sessionId: 'session-2',
    channelId: 'discord-channel-2',
    cronExpr: '0 8 * * *',
    prompt: 'theirs',
  });

  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'remove',
        sessionId: 'session-1',
        taskId: otherTaskId,
      }),
    ),
  ).toBe(404);
  expect(
    runScheduledTaskToolAction({
      action: 'remove',
      sessionId: 'session-1',
      taskId: ownTaskId,
    }),
  ).toEqual({
    ok: true,
    action: 'remove',
    taskId: ownTaskId,
    sessionId: 'session-1',
  });

  const remaining = getAllJobs({ kind: 'scheduled_task' });
  expect(remaining.map((task) => task.id)).toEqual([otherTaskId]);
});
