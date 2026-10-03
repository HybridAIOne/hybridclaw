import { afterEach, expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({ tempHomePrefix: 'hy-connector-events-' });
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
const NOW = new Date('2026-10-05T08:05:00Z'); // Monday 10:05 in Berlin
async function load() {
  setupHome();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const { initDatabase, getOrCreateSession } = await import('../src/memory/db.ts');
  const jobs = await import('../src/memory/jobs.ts');
  const events = await import('../src/scheduler/connector-events.ts');
  const scheduler = await import('../src/scheduler/scheduler.ts');
  const device = await import('../src/gateway/device-data.ts');
  initDatabase({ quiet: true });
  const session = getOrCreateSession('app-alice', null, 'web', 'main');
  const create = (ownerUserId: string | undefined = 'alice', cronExpr = '*/30 8-21 * * *') => jobs.createJob({
    kind: 'scheduled_task', sessionId: session.id, channelId: 'web', cronExpr,
    tz: 'Europe/Berlin', prompt: 'Prepare a useful draft. Stay quiet if nothing needs attention.',
    ownerUserId, replyOnly: true, alert: 'proactive',
  });
  const change = (taskId: number, eventId = 'event-1', userId = 'alice') => events.queueConnectorChange({ taskId, eventId, userId, source: 'gmail' });
  stop = scheduler.stopScheduler;
  return { jobs, events, scheduler, device, create, change };
}

test('an event wakes the existing scheduler before the next periodic check', async () => {
  const { jobs, scheduler, create, change } = await load();
  const parent = create();
  const runner = vi.fn(async () => {});
  scheduler.startScheduler(runner);
  const result = change(parent);
  expect(result.status).toBe('queued');
  const queued = jobs.getJob(result.taskId!, { kind: 'scheduled_task' });
  expect(queued).toMatchObject({ owner_user_id: 'alice', event_parent_id: parent, reply_only: true, alert: 'proactive', session_id: 'app-alice', run_at: '2026-10-05T08:05:15.000Z' });
  expect(queued?.prompt).toContain('Prepare a useful draft');
  expect(queued?.prompt).not.toContain('event-1');
  await vi.advanceTimersByTimeAsync(15_100);
  expect(runner).toHaveBeenCalledOnce();
  expect(runner.mock.calls[0][0]).toMatchObject({ taskId: result.taskId, resultSourceTaskId: parent, replyOnly: true, taskOwner: { userId: 'alice', sessionId: 'app-alice' } });
  expect(jobs.getJob(result.taskId!, { kind: 'scheduled_task' })).toBeNull();
  expect(jobs.getJob(parent, { kind: 'scheduled_task' })?.enabled).toBe(1);
});

test('duplicates persist across module reload; bursts and cooldown bound extra checks', async () => {
  const { jobs, create, change } = await load();
  const parent = create();
  const first = change(parent);
  expect(change(parent).status).toBe('duplicate');
  expect(change(parent, 'event-2')).toMatchObject({ status: 'coalesced', taskId: first.taskId });
  vi.resetModules();
  const reloaded = await import('../src/scheduler/connector-events.ts');
  expect(reloaded.queueConnectorChange({ taskId: parent, source: 'gmail', userId: 'alice', eventId: 'event-1' }).status).toBe('duplicate');
  jobs.deleteJob(first.taskId!);
  vi.setSystemTime(new Date(NOW.getTime() + 20_000));
  const second = change(parent, 'event-3');
  expect(jobs.getJob(second.taskId!, { kind: 'scheduled_task' })?.run_at).toBe('2026-10-05T08:10:15.000Z');
});

test('quiet hours, timezone boundaries and a sooner regular check use periodic fallback', async () => {
  const { create, change, jobs } = await load();
  const parent = create();
  for (const [event, time] of [
    ['quiet', '2026-10-05T21:05:00Z'], // 23:05 Berlin
    ['boundary', '2026-10-05T19:59:50Z'], // debounce crosses 22:00
    ['due-soon', '2026-10-05T08:29:50Z'],
  ]) {
    vi.setSystemTime(new Date(time));
    expect(change(parent, event).status).toBe('scheduled');
  }
  expect(jobs.getAllJobs({ kind: 'scheduled_task' })).toHaveLength(1);
});

test('wrong owner, ownerless, paused and non-proactive policies do not enqueue', async () => {
  const { create, change, jobs } = await load();
  const id = create();
  expect(change(id, 'wrong-owner', 'bob').status).toBe('ignored');
  jobs.setJobEnabled(id, false);
  expect(change(id).status).toBe('ignored');
  const ownerless = create('');
  expect(change(ownerless).status).toBe('ignored');
  const other = jobs.createJob({ kind: 'scheduled_task', sessionId: 'app-alice', channelId: 'web', cronExpr: '*/30 * * * *', prompt: 'Send a message', ownerUserId: 'alice' });
  expect(change(other).status).toBe('ignored');
});

test('pausing, editing or deleting a policy cancels its queued copy at dispatch', async () => {
  const { create, change, jobs, scheduler, events } = await load();
  const runner = vi.fn(async () => {});
  scheduler.startScheduler(runner);
  const parent = create();
  const first = change(parent);
  jobs.setJobEnabled(parent, false);
  expect(events.isConnectorEventCurrent(jobs.getJob(first.taskId!, { kind: 'scheduled_task' })!)).toBe(false);
  await vi.advanceTimersByTimeAsync(15_100);
  expect(runner).not.toHaveBeenCalled();
  expect(jobs.getJob(first.taskId!, { kind: 'scheduled_task' })).toBeNull();
  jobs.setJobEnabled(parent, true);
  const second = change(parent, 'changed-policy');
  jobs.updateScheduledTask(parent, { prompt: 'New priorities', cronExpr: '*/30 8-21 * * *', tz: 'Europe/Berlin', channelId: 'web' });
  expect(events.isConnectorEventCurrent(jobs.getJob(second.taskId!, { kind: 'scheduled_task' })!)).toBe(false);
  jobs.deleteJob(parent);
  expect(events.isConnectorEventCurrent(jobs.getJob(second.taskId!, { kind: 'scheduled_task' })!)).toBe(false);
});

test('changed phone content emits events; identical freshness updates do not', async () => {
  const { create, jobs, device } = await load();
  const alice = create();
  const bob = create('bob');
  device.writeDeviceSources('alice', { calendar: 'Calendar\n- Team review' });
  let copies = jobs.getAllJobs({ kind: 'scheduled_task' }).filter((job) => job.event_parent_id);
  expect(copies).toHaveLength(1);
  expect(copies[0].event_parent_id).toBe(alice);
  expect(copies[0].event_parent_id).not.toBe(bob);
  jobs.deleteJob(copies[0].id);
  device.writeDeviceSources('alice', { calendar: 'Calendar\n- Team review' });
  copies = jobs.getAllJobs({ kind: 'scheduled_task' }).filter((job) => job.event_parent_id);
  expect(copies).toHaveLength(0);
  device.writeDeviceSources('alice', { calendar: 'Calendar\n- New meeting' });
  expect(jobs.getAllJobs({ kind: 'scheduled_task' }).filter((job) => job.event_parent_id)).toHaveLength(1);
});

test('a failed early check does not absorb later connector events forever', async () => {
  const { create, change, jobs } = await load();
  const parent = create();
  const first = change(parent);
  jobs.markJobRunStarted(first.taskId!);
  jobs.markJobFailure(first.taskId!, 5, 'provider unavailable');
  const second = change(parent, 'new-after-failure');
  expect(second.status).toBe('queued');
  expect(second.taskId).not.toBe(first.taskId);
  expect(jobs.getJob(first.taskId!, { kind: 'scheduled_task' })).toBeNull();
  expect(jobs.getJob(parent, { kind: 'scheduled_task' })?.enabled).toBe(1);
});

test('weekday-only policies stay quiet on weekends', async () => {
  const { create, change } = await load();
  const parent = create('alice', '*/30 8-21 * * 1-5');
  vi.setSystemTime(new Date('2026-10-10T08:05:00Z'));
  expect(change(parent).status).toBe('scheduled');
});
