import { afterEach, expect, test, vi } from 'vitest';
import { useTempDir, useCleanMocks } from './test-utils.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';

const home = useTempDir('managed-routines-');
useCleanMocks({ unstubAllEnvs: true });
afterEach(async () => { await cleanupGatewayRuntime(); vi.useRealTimers(); vi.resetModules(); });

async function setup() {
  vi.stubEnv('HOME', home());
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const jobs = await import('../src/memory/jobs.js');
  const { handleScheduleCommand } = await import('../src/gateway/schedule-command.js');
  const session = db.getOrCreateSession('main-a', null, 'web', 'hy');
  const sibling = db.getOrCreateSession('web-b', null, 'web', 'hy');
  const run = (args: string[], chat = session, user = 'user-a') => handleScheduleCommand({ sessionId: chat.id, channelId: 'web', guildId: null, userId: user, args: ['schedule', ...args] }, chat);
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
  const config = { revision: null, enabled: true, hour: 8, minute: 0, weekdays: false, tz: 'Europe/Berlin' };
  const save = (data = config, chat = session, user = 'user-a') => run(['routine', '--json', 'daily-brief', encode(data)], chat, user);
  const read = () => JSON.parse(run(['routine', '--json', 'daily-brief']).text);
  return { db, jobs, run, save, read, config, session, sibling };
}

test('two clients and lost acknowledgements keep one routine, with revision-checked changes', async () => {
  const { jobs, save, read, config, sibling } = await setup();
  expect(read().task).toBeNull();
  expect(save().kind).toBe('plain');
  expect(save(config, sibling).kind).toBe('plain');
  expect(jobs.getAllJobs({ kind: 'scheduled_task' })).toHaveLength(1);
  const first = read();
  expect(first.task.managed_key).toBe('daily-brief');
  const change = { ...config, revision: first.task.revision, hour: 9 };
  expect(save(change).kind).toBe('plain');
  expect(save(change, sibling).kind).toBe('plain');
  expect(save({ ...config, revision: first.task.revision, hour: 10 }).kind).toBe('error');
  expect(read().settings.hour).toBe(9);
});

test('owners, agents and scopes cannot read or change another routine through generic schedule commands', async () => {
  const { db, jobs, run, save, read, session } = await setup();
  save(); const task = read().task;
  const other = db.getOrCreateSession('other', null, 'web', 'another-agent');
  for (const [chat, owner] of [[session, 'user-b'], [other, 'user-a']] as const) {
    for (const verb of ['toggle', 'pause', 'remove', 'runs', 'results'])
      expect(run([verb, String(task.id), '--json'], chat, owner).kind).toBe('error');
    expect(JSON.parse(run(['list', '--json'], chat, owner).text).tasks).toEqual([]);
  }
  expect(jobs.getAllJobs({ kind: 'scheduled_task' })).toHaveLength(1);
  expect(run(['routine', 'daily-brief'], { ...session, scope: 'scope-a' }).kind).toBe('error');
});

test('invalid payloads cannot choose owners, instructions or destinations', async () => {
  const { save, config, jobs } = await setup();
  for (const patch of [{ hour: 24 }, { minute: -1 }, { tz: 'bad' }, { weekdays: 1 }, { prompt: 'Other' }, { owner: 'other' }, { session_id: 'other' }]) {
    expect(save({ ...config, ...patch } as typeof config).kind).toBe('error');
  }
  expect(jobs.getAllJobs({ kind: 'scheduled_task' })).toEqual([]);
});

test('editions survive restart and schedule edits, missed slots do not generate backlog', async () => {
  const { db, jobs, save, read } = await setup();
  save(); const task = jobs.getJob(read().task.id, { kind: 'scheduled_task' })!;
  const { claimRoutineEdition, saveEdition, savedEdition, pendingEdition } = await import('../src/scheduler/routine-editions.js');
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T00:30:00Z'));
  const first = claimRoutineEdition(task, Date.now())!;
  saveEdition(first, { text: 'Prepared brief', storedMessage: { sessionId: 'web-a', id: 123 } });
  db.closeDatabase(); db.initDatabase({ quiet: true });
  expect(claimRoutineEdition({ ...task, cron_expr: '30 3 * * *' }, Date.now() + 3600000)).toBeNull();
  expect(savedEdition(first)?.text).toBe('Prepared brief');
  expect(pendingEdition(task)).toBe(first);
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  expect(claimRoutineEdition(task, Date.now() - 3600000)).toBeNull();
  const { listTaskRuns } = await import('../src/scheduler/task-runs.js');
  expect(listTaskRuns(task.id, 50)[0].outcome).toBe('missed');
});

test('manual test creates a separate one-shot without altering the routine', async () => {
  const { jobs, run, save, read } = await setup();
  save(); const before = read().task;
  const result = JSON.parse(run(['routine', 'daily-brief', 'test', before.revision]).text);
  expect(result.test_task_id).not.toBe(before.id);
  const testJob = jobs.getJob(result.test_task_id, { kind: 'scheduled_task' })!;
  expect(testJob.run_at).not.toBeNull();
  expect(testJob.managed_key).toBeUndefined();
  expect(read().task.revision).toBe(before.revision);
});

test('local schedules handle weekdays, DST gaps and repeated hours', async () => {
  const { jobs, save, read } = await setup(); save();
  const task = { ...jobs.getJob(read().task.id, { kind: 'scheduled_task' })!, cron_expr: '30 2 * * *' };
  const { routineDue } = await import('../src/scheduler/routine-time.js');
  for (const [now, expected] of [
    ['2026-03-29T00:00:00Z', '2026-03-29T01:00:00Z'],
    ['2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z'],
    ['2026-10-25T00:45:00Z', '2026-10-26T01:30:00Z'],
  ]) expect(routineDue(task, Date.parse(now), 'next')).toBe(Date.parse(expected));
  expect(routineDue(task, Date.parse('2026-03-29T01:10:00Z'), 'previous')).toBe(Date.parse('2026-03-29T01:00:00Z'));
  expect(routineDue({ ...task, cron_expr: '0 8 * * 1-5' }, Date.parse('2026-10-23T08:00:00Z'), 'next')).toBe(Date.parse('2026-10-26T07:00:00Z'));
});

test('deleting and reusing a numeric task id never exposes a previous owner’s cached edition', async () => {
  const { jobs, save, read, config } = await setup();
  save(); const task = jobs.getJob(read().task.id, { kind: 'scheduled_task' })!;
  const editions = await import('../src/scheduler/routine-editions.js');
  const run = editions.claimRoutineEdition(task, Date.now())!;
  editions.saveEdition(run, { text: 'Private prepared result' });
  jobs.deleteJob(task.id);
  save(config, undefined, 'user-b');
  const replacement = jobs.getAllJobs({ kind: 'scheduled_task' })[0];
  expect(replacement.id).toBe(task.id);
  expect(editions.pendingEdition(replacement)).toBeNull();
});

test('pausing during an in-flight failure stays paused', async () => {
  const { jobs, save, read } = await setup(); save();
  const task = jobs.getJob(read().task.id, { kind: 'scheduled_task' })!;
  const { fireDbTask } = await import('../src/scheduler/db-task-runner.js');
  let reject!: (reason: Error) => void;
  fireDbTask(task, Date.now(), 'Cron', {}, () => new Promise<void>((_, fail) => { reject = fail; }));
  jobs.setJobEnabled(task.id, false);
  reject(new Error('Cancelled before delivery'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(jobs.getJob(task.id, { kind: 'scheduled_task' })?.enabled).toBe(0);
});

test('missed history uses the same first-valid-minute rule as the live DST timer', async () => {
  const { jobs, save, read } = await setup(); save();
  const task = { ...jobs.getJob(read().task.id, { kind: 'scheduled_task' })!, cron_expr: '30 2 * * *',
    last_run: '2026-03-28T12:00:00Z', updated_at: '2026-03-28T12:00:00Z' };
  const { missedDueTimes } = await import('../src/scheduler/task-runs.js');
  expect(missedDueTimes(task, Date.parse('2026-03-30T00:30:00Z'))).toEqual([Date.parse('2026-03-29T01:00:00Z')]);
});


test('consent withdrawal pauses managed tasks idempotently without editing their template', async () => {
  const { run, save, read } = await setup();
  save(); const task = read().task;
  for (let attempt = 0; attempt < 2; attempt++) {
    const paused = JSON.parse(run(['pause', String(task.id), '--json']).text).task;
    expect(paused.enabled).toBe(false);
    expect(paused.managed_key).toBe('daily-brief');
  }
  expect(read().settings.enabled).toBe(false);
});


test('pausing retires a pending edition so resuming cannot deliver it immediately', async () => {
  const { jobs, save, read } = await setup();
  save(); const task = jobs.getJob(read().task.id, { kind: 'scheduled_task' })!;
  const { claimRoutineEdition, saveEdition, pendingEdition } = await import('../src/scheduler/routine-editions.js');
  const run = claimRoutineEdition(task, Date.now())!;
  saveEdition(run, { text: 'Prepared brief' });
  expect(pendingEdition(task)).toBe(run);
  jobs.setJobEnabled(task.id, false);
  jobs.setJobEnabled(task.id, true);
  expect(pendingEdition(task)).toBeNull();
});
