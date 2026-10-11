import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

const makeTempHome = useTempDir('hybridclaw-task-runs-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

// SQLite stamps a task's changes with the real clock, so the fake one starts a
// day ahead of it, on the hour.
const HOUR = 3_600_000;
const BASE = Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR;
const at = (hours: number) => new Date(BASE + hours * HOUR).toISOString();

async function setup() {
  process.env.HOME = makeTempHome();
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRecentMessages } = await import('../src/memory/messages.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const jobs = await import('../src/memory/jobs.ts');
  const scheduler = await import('../src/scheduler/scheduler.ts');
  const runs = await import('../src/scheduler/task-runs.ts');
  const { handleScheduleCommand } = await import(
    '../src/gateway/schedule-command.ts'
  );
  initDatabase({ quiet: true });
  jobs.replaceJobs([]);
  const session = memoryService.getOrCreateSession('web-chat', null, 'web');
  const command = (args: string[]) =>
    JSON.parse(
      handleScheduleCommand(
        { sessionId: session.id, guildId: null, channelId: 'web', args },
        session,
      ).text,
    );
  const notices = () =>
    getRecentMessages(session.id, 50).filter((message) =>
      message.source?.startsWith('schedule-notice'),
    );
  return { jobs, scheduler, runs, session, command, notices };
}

test('due times the scheduler never ran are recorded as missed and told once', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE + 30_000));
  const { jobs, scheduler, session, command, notices } = await setup();
  const taskId = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: session.id,
    channelId: 'web',
    cronExpr: '0 * * * *',
    prompt: '[Inbox] Summarize my inbox\nKeep it short.',
  });

  // The runtime was down from the first half minute until 3:10 hours later.
  vi.setSystemTime(new Date(BASE + 3 * HOUR + 10 * 60_000));
  const runner = vi.fn(async () => {});
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
  scheduler.stopScheduler();

  // Catch-up still runs once, for the latest due time.
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0]?.[0]).toMatchObject({
    taskId,
    taskRunId: expect.any(Number),
  });

  const answer = command(['schedule', 'runs', String(taskId), '--json']);
  expect(
    answer.runs.map((run: { due_at: string; outcome: string }) => [
      run.due_at,
      run.outcome,
    ]),
  ).toEqual([
    [at(3), 'done'],
    [at(2), 'missed'],
    [at(1), 'missed'],
  ]);
  expect(answer.runs[0]).toMatchObject({
    started_at: new Date(BASE + 3 * HOUR + 15 * 60_000).toISOString(),
    duration_ms: expect.any(Number),
    error: null,
  });

  const listed = command(['schedule', 'list', '--json']);
  expect(listed.tasks[0].runs).toEqual({
    last: 'done',
    last_due_at: at(3),
    failed_24h: 0,
    missed_24h: 2,
  });

  expect(notices()).toHaveLength(1);
  expect(notices()[0]).toMatchObject({
    role: 'assistant',
    source: `schedule-notice:${taskId}`,
  });
  expect(notices()[0]?.content).toContain(
    'Your routine “Summarize my inbox” missed 2 runs',
  );
});

test('due times while a task was paused do not count as missed', async () => {
  const { jobs, runs } = await setup();
  const taskId = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: 'web-chat',
    channelId: 'web',
    cronExpr: '0 * * * *',
    prompt: 'Summarize my inbox',
  });
  const task = jobs.getJob(taskId, { kind: 'scheduled_task' });
  if (!task) throw new Error('task missing');
  // Last run at the start, resumed 3.5 hours later; due again at 5 hours.
  const resumed = { ...task, last_run: at(0), updated_at: at(3.5) };

  expect(runs.missedDueTimes(resumed, BASE + 5 * HOUR)).toEqual([
    BASE + 4 * HOUR,
  ]);
  expect(
    runs.missedDueTimes({ ...resumed, updated_at: at(0) }, BASE + 5 * HOUR),
  ).toEqual([1, 2, 3, 4].map((hours) => BASE + hours * HOUR));
});

test('failed runs keep their error and the chat hears of it once a day', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE + 30_000));
  const { jobs, scheduler, runs, command, notices, session } = await setup();
  const taskId = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: session.id,
    channelId: 'web',
    cronExpr: '*/30 * * * *',
    title: 'Morning briefing',
    prompt: 'Write my briefing',
  });

  const runner = vi.fn(async () => {
    throw new Error('Model quota exceeded');
  });
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  scheduler.stopScheduler();
  expect(runner).toHaveBeenCalledTimes(1);

  const stored = jobs.getJob(taskId, { kind: 'scheduled_task' });
  if (!stored) throw new Error('task missing');
  // As the scheduler would see it: last run on the fake clock.
  const task = { ...stored, last_run: at(0.5), updated_at: at(0.5) };
  const second = runs.startTaskRun(task, BASE + HOUR);
  runs.finishTaskRun(task, second, {
    error: new Error('Model quota exceeded'),
  });
  await vi.advanceTimersByTimeAsync(0);

  const answer = command(['schedule', 'runs', String(taskId), '--json']);
  expect(
    answer.runs.map((run: { outcome: string; error: string }) => [
      run.outcome,
      run.error,
    ]),
  ).toEqual([
    ['failed', 'Model quota exceeded'],
    ['failed', 'Model quota exceeded'],
  ]);
  expect(notices()).toHaveLength(1);
  expect(notices()[0]?.content).toMatch(
    /^Your routine “Morning briefing” failed \(due .+\): Model quota exceeded\.$/,
  );

  // A routine paused after repeated failures is told at once.
  const third = runs.startTaskRun(
    { ...task, last_run: at(1), updated_at: at(1) },
    BASE + 1.5 * HOUR,
  );
  runs.finishTaskRun(task, third, {
    error: 'Model quota exceeded',
    pausedAfter: 5,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(notices()).toHaveLength(2);
  expect(notices()[1]?.content).toContain('I paused it after 5 failed runs');
});

test('apps find the run history by its subcommand in the command list', async () => {
  const { buildTuiSlashMenuEntries, rankTuiSlashMenuEntries } = await import(
    '../src/tui-slash-menu.ts'
  );
  const ranked = rankTuiSlashMenuEntries(
    buildTuiSlashMenuEntries([], 'web'),
    'schedule runs',
  ).slice(0, 12);
  expect(ranked).toContainEqual(
    expect.objectContaining({ id: 'schedule.runs', depth: 2 }),
  );
});
