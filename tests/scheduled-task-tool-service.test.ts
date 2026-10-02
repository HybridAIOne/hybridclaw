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
  const { createJob, getAllJobs, markJobFailure } = await import(
    '../src/memory/jobs.ts'
  );
  const { runScheduledTaskToolAction } = await import(
    '../src/gateway/scheduled-task-tool-service.ts'
  );
  const { listManageableScheduledTasks } = await import(
    '../src/gateway/scheduled-task-access.ts'
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
    getOrCreateSession,
    listManageableScheduledTasks,
    markJobFailure,
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

test('add stores a valid cron timezone and rejects unknown ones', async () => {
  const { getAllJobs, runScheduledTaskToolAction } = await setup();

  const created = runScheduledTaskToolAction({
    action: 'add',
    sessionId: 'session-1',
    cronExpr: '0 9 * * *',
    tz: 'Europe/Berlin',
    prompt: 'Write the briefing.',
  });

  expect(created).toMatchObject({ ok: true, tz: 'Europe/Berlin' });
  expect(
    getAllJobs({ kind: 'scheduled_task', sessionId: 'session-1' })[0],
  ).toMatchObject({ cron_expr: '0 9 * * *', tz: 'Europe/Berlin' });
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'add',
        sessionId: 'session-1',
        cronExpr: '0 9 * * *',
        tz: 'Mars/Olympus',
        prompt: 'Write the briefing.',
      }),
    ),
  ).toBe(400);
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'add',
        sessionId: 'session-1',
        everyMs: 60_000,
        tz: 'Europe/Berlin',
        prompt: 'Write the briefing.',
      }),
    ),
  ).toBe(400);
  expect(
    getAllJobs({ kind: 'scheduled_task', sessionId: 'session-1' }),
  ).toHaveLength(1);
});

test('rejects unknown sessions and malformed payloads without creating jobs', async () => {
  const { getAllJobs, rearmScheduler, runScheduledTaskToolAction } =
    await setup();

  expect(statusOf(() => runScheduledTaskToolAction('nope'))).toBe(400);
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({ action: 'explode', sessionId: 'session-1' }),
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

test('list shows the tasks as stored now, with delivery and a failing run', async () => {
  const { createJob, markJobFailure, runScheduledTaskToolAction } =
    await setup();
  const briefing = createJob({
    kind: 'scheduled_task',
    sessionId: 'session-1',
    channelId: 'ops@example.com',
    cronExpr: '0 9 * * *',
    tz: 'Europe/Berlin',
    prompt: 'Morning briefing',
  });
  markJobFailure(briefing, 5, 'Delivery to email failed: not linked');
  const broken = createJob({
    kind: 'scheduled_task',
    sessionId: 'session-1',
    channelId: 'ops@example.com',
    cronExpr: '0 8 * * *',
    prompt: 'Broken',
  });
  markJobFailure(broken, 1, 'Model unavailable');
  const pulse = createJob({
    kind: 'scheduled_task',
    sessionId: 'session-1',
    channelId: 'ops@example.com',
    everyMs: 60_000,
    prompt: 'Healthy',
  });

  const listed = runScheduledTaskToolAction({
    action: 'list',
    sessionId: 'session-1',
  });
  expect(listed).toMatchObject({ ok: true, action: 'list' });
  expect(listed.text.split('\n').sort()).toEqual([
    `#${briefing} [enabled] 0 9 * * * (Europe/Berlin) -> ops@example.com — Morning briefing (last run failed: Delivery to email failed: not linked)`,
    `#${broken} [disabled] 0 8 * * * -> ops@example.com — Broken (last run failed: Model unavailable)`,
    `#${pulse} [enabled] every 60s -> ops@example.com — Healthy`,
  ]);

  runScheduledTaskToolAction({
    action: 'remove',
    sessionId: 'session-1',
    taskId: pulse,
  });
  expect(
    runScheduledTaskToolAction({ action: 'list', sessionId: 'session-1' })
      .text,
  ).not.toContain('Healthy');
});

test('list says when other chats of the agent hold tasks this one cannot see', async () => {
  const { createJob, getOrCreateSession, runScheduledTaskToolAction } =
    await setup();
  const web = getOrCreateSession('web-own', null, 'web', 'main');
  const discord = getOrCreateSession('discord-own', null, 'discord-2', 'main');
  createJob({
    kind: 'scheduled_task',
    sessionId: discord.id,
    channelId: 'discord-2',
    cronExpr: '0 9 * * *',
    prompt: 'discord peer',
  });

  expect(
    runScheduledTaskToolAction({ action: 'list', sessionId: web.id }).text,
  ).toMatch(/^No scheduled tasks in this chat\. 1 more task\(s\)/);
  expect(
    runScheduledTaskToolAction({ action: 'list', sessionId: discord.id }).text,
  ).not.toContain('more task(s)');
});

test('a goal check-in or todo reminder is listed as theirs and left to their tool', async () => {
  const { getAllJobs, getOrCreateSession, runScheduledTaskToolAction } =
    await setup();
  const chat = getOrCreateSession('web-chat-1', null, 'web', 'main');
  const { addTracked } = await import('../src/tracking/track-store.ts');
  const { addTodo } = await import('../src/todos/todo-store.ts');
  const daily = [0, 1, 2, 3, 4, 5, 6];
  const goal = addTracked(
    chat,
    { title: 'Half marathon', every: daily, at: '07:15', tz: 'UTC' },
    'agent',
  );
  const todo = addTodo(chat, {
    title: 'Stretch',
    repeat: daily,
    remind: '07:16',
    tz: 'UTC',
  });
  const stored = getAllJobs({ kind: 'scheduled_task' });

  const listed = runScheduledTaskToolAction({
    action: 'list',
    sessionId: chat.id,
  }).text;
  expect(listed).toContain(
    `#${goal.checkTaskId} [enabled] 15 7 * * * (UTC) -> web — the check-in of goal #1 "Half marathon"; change or stop it with the \`track\` tool`,
  );
  expect(listed).toContain(
    `#${todo.reminderTaskId} [enabled] 16 7 * * * (UTC) -> web — the reminder of todo #1 "Stretch"; change or stop it with the \`todo\` tool`,
  );

  // The live run that found this: the model "fixed" the check-in's zone and
  // prompt through cron, the goal disowned it and set a second one.
  for (const taskId of [goal.checkTaskId, todo.reminderTaskId]) {
    expect(
      statusOf(() =>
        runScheduledTaskToolAction({
          action: 'update',
          sessionId: chat.id,
          taskId,
          tz: 'Europe/Berlin',
          prompt: 'Ask Ben how training went.',
        }),
      ),
    ).toBe(409);
    expect(
      statusOf(() =>
        runScheduledTaskToolAction({
          action: 'remove',
          sessionId: chat.id,
          taskId,
        }),
      ),
    ).toBe(409);
  }
  expect(getAllJobs({ kind: 'scheduled_task' })).toEqual(stored);
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
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'remove',
        sessionId: 'session-1',
        taskId: otherTaskId + 1000,
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

test('update changes the schedule and clears prior run history', async () => {
  const {
    createJob,
    getAllJobs,
    markJobFailure,
    rearmScheduler,
    runScheduledTaskToolAction,
  } = await setup();
  const taskId = createJob({
    kind: 'scheduled_task',
    sessionId: 'session-1',
    channelId: 'discord-channel-1',
    cronExpr: '0 9 * * *',
    tz: 'Europe/Berlin',
    prompt: 'Write the briefing.',
  });
  markJobFailure(taskId, 5, 'boom');

  const result = runScheduledTaskToolAction({
    action: 'update',
    sessionId: 'session-1',
    taskId,
    cronExpr: '30 8 * * 1-5',
    tz: 'America/New_York',
  });

  expect(result).toMatchObject({
    ok: true,
    action: 'update',
    taskId,
    cronExpr: '30 8 * * 1-5',
    tz: 'America/New_York',
    channelId: 'discord-channel-1',
    prompt: 'Write the briefing.',
  });
  const [task] = getAllJobs({ kind: 'scheduled_task', sessionId: 'session-1' });
  expect(task).toMatchObject({
    cron_expr: '30 8 * * 1-5',
    tz: 'America/New_York',
    last_status: null,
    last_error: null,
    consecutive_errors: 0,
  });
  expect(task.last_run).not.toBeNull();
  expect(rearmScheduler).toHaveBeenCalledTimes(1);
});

test('update rejects a task belonging to a different session', async () => {
  const { createJob, runScheduledTaskToolAction } = await setup();
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
        action: 'update',
        sessionId: 'session-1',
        taskId: otherTaskId,
        prompt: 'stolen',
      }),
    ),
  ).toBe(404);
});


test('web chats of the same agent can list, update, and remove prior web tasks', async () => {
  const {
    getAllJobs,
    getOrCreateSession,
    listManageableScheduledTasks,
    runScheduledTaskToolAction,
  } = await setup();
  const first = getOrCreateSession('web-chat-1', null, 'web', 'main');
  const second = getOrCreateSession('web-chat-2', null, 'web', 'main');
  const taskId = runScheduledTaskToolAction({
    action: 'add',
    sessionId: first.id,
    channelId: 'ops@example.com',
    cronExpr: '0 9 * * *',
    prompt: 'Check competitors.',
  }).taskId;

  expect(
    listManageableScheduledTasks(second).tasks.map((task) => task.id),
  ).toContain(taskId);
  expect(
    runScheduledTaskToolAction({
      action: 'update',
      sessionId: second.id,
      taskId,
      prompt: 'Check competitors and summarize changes.',
    }),
  ).toMatchObject({ taskId, prompt: 'Check competitors and summarize changes.' });
  expect(getAllJobs({ kind: 'scheduled_task' })[0]).toMatchObject({
    id: taskId,
    session_id: first.id,
    channel_id: 'ops@example.com',
  });
  expect(
    runScheduledTaskToolAction({ action: 'remove', sessionId: second.id, taskId }),
  ).toMatchObject({ taskId, action: 'remove' });
  expect(getAllJobs({ kind: 'scheduled_task' })).toHaveLength(0);
});

test('web cron access excludes other agents and messaging sessions', async () => {
  const {
    createJob,
    getOrCreateSession,
    listManageableScheduledTasks,
    runScheduledTaskToolAction,
  } = await setup();
  const ownWeb = getOrCreateSession('web-own', null, 'web', 'main');
  const otherWeb = getOrCreateSession('web-other', null, 'web', 'other-agent');
  const discord = getOrCreateSession(
    'discord-other',
    null,
    'discord-channel-2',
    'main',
  );
  const ownTaskId = createJob({
    kind: 'scheduled_task',
    sessionId: ownWeb.id,
    channelId: 'ops@example.com',
    cronExpr: '0 9 * * *',
    prompt: 'mine',
  });
  const otherTaskId = createJob({
    kind: 'scheduled_task',
    sessionId: otherWeb.id,
    channelId: 'other@example.com',
    cronExpr: '0 9 * * *',
    prompt: 'other agent',
  });
  const discordTaskId = createJob({
    kind: 'scheduled_task',
    sessionId: discord.id,
    channelId: 'discord-channel-2',
    cronExpr: '0 9 * * *',
    prompt: 'discord peer',
  });

  // The Discord task is the same agent's, so the web chat learns it exists;
  // the Discord peer never learns about the web chat's task.
  expect(listManageableScheduledTasks(ownWeb)).toMatchObject({
    tasks: [{ id: ownTaskId }],
    hiddenCount: 1,
  });
  expect(listManageableScheduledTasks(discord)).toMatchObject({
    tasks: [{ id: discordTaskId }],
    hiddenCount: 0,
  });
  for (const taskId of [otherTaskId, discordTaskId]) {
    expect(
      statusOf(() =>
        runScheduledTaskToolAction({
          action: 'update',
          sessionId: ownWeb.id,
          taskId,
          prompt: 'changed',
        }),
      ),
    ).toBe(404);
    expect(
      statusOf(() =>
        runScheduledTaskToolAction({
          action: 'remove',
          sessionId: ownWeb.id,
          taskId,
        }),
      ),
    ).toBe(404);
  }
  expect(
    statusOf(() =>
      runScheduledTaskToolAction({
        action: 'remove',
        sessionId: discord.id,
        taskId: ownTaskId,
      }),
    ),
  ).toBe(404);
});

// "update" shares validateScheduledTaskFields() with "add", so its
// multi-schedule-field rejection is already covered by the "add" test
// above; the container-level equivalent still exercises update directly.
