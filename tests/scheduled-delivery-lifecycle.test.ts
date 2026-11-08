import { beforeEach, expect, test, vi } from 'vitest';
import { ScheduledDeliveryLifecycle } from '../src/scheduler/scheduled-delivery-lifecycle.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const mocks = vi.hoisted(() => ({ run: vi.fn(), deliver: vi.fn() }));
vi.mock('../src/gateway/gateway-scheduled-task-service.js', () => ({ runGatewayScheduledTask: mocks.run }));
vi.mock('../src/gateway/web-scheduled-delivery.js', () => ({ mainChatForWebTask: () => null, deliverWebScheduledMessage: mocks.deliver }));
beforeEach(() => { mocks.run.mockReset(); mocks.deliver.mockReset(); });
const { setupHome } = setupGatewayTest({ tempHomePrefix: 'scheduled-lifecycle-' });

test('a run cannot deliver before preparation, or prepare and deliver twice', () => {
  const run = new ScheduledDeliveryLifecycle(null);
  expect(() => run.beginDelivery()).toThrow();
  run.prepare({ text: 'Saved result' });
  expect(run.beginDelivery()).toEqual({ text: 'Saved result' });
  expect(() => run.prepare({ text: 'Other result' })).toThrow();
  expect(() => run.beginDelivery()).toThrow();
  expect(() => run.finish()).toThrow();
  run.settle('queued');
  expect(run.finish()).toEqual({ execution: 'completed', delivery: 'queued' });
});

test('restored output bypasses execution and silent runs remain distinct from delivery', () => {
  const restored = new ScheduledDeliveryLifecycle({ text: 'Prepared earlier' });
  expect(() => restored.prepare({ text: 'Regenerated' })).toThrow();
  restored.beginDelivery();
  restored.settle('delivered');
  expect(restored.finish()).toEqual({ execution: 'reused', delivery: 'delivered' });
  expect(new ScheduledDeliveryLifecycle(null).finish()).toEqual({ execution: 'skipped', delivery: 'none' });
});

async function fixture() {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const jobs = await import('../src/memory/jobs.js');
  const editions = await import('../src/scheduler/routine-editions.js');
  const { runScheduledTask } = await import('../src/gateway/gateway-scheduled-dispatch.js');
  const session = db.getOrCreateSession('session-a', null, 'web', 'hy');
  const id = jobs.createJob({ kind: 'scheduled_task', sessionId: session.id, channelId: 'web', cronExpr: '0 8 * * *', tz: 'UTC', prompt: 'Prepare a report', managedKey: 'report', managedScope: 'scope-a' });
  const task = jobs.getJob(id, { kind: 'scheduled_task' })!;
  const run = editions.claimRoutineEdition(task, Date.now())!;
  const request = { source: 'scheduled-task' as const, taskId: id, taskRunId: run, sessionId: session.id, channelId: 'web', prompt: task.prompt, actionKind: 'agent_turn' as const, delivery: { kind: 'channel' as const, channelId: 'web' }, routine: { key: 'report', scope: 'scope-a' } };
  const dependencies = { deliverProactiveMessage: vi.fn(), deliverWebhookMessage: vi.fn(), resolveLastUsedDeliverableChannelId: () => null };
  return { db, jobs, editions, runScheduledTask, task, run, request, dependencies };
}

test('a settled edition cannot execute or deliver again after reopening the database', async () => {
  const f = await fixture();
  f.editions.saveEdition(f.run, { text: 'Saved report' });
  f.editions.deliveredEdition(f.run);
  f.db.closeDatabase();
  f.db.initDatabase({ quiet: true });
  await f.runScheduledTask(f.request, f.dependencies);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.deliver).not.toHaveBeenCalled();
  expect(() => f.editions.saveEdition(f.run, { text: 'Late replacement' })).toThrow();
});

test('preparing again preserves the first output and claiming twice cannot create a second edition', async () => {
  const f = await fixture();
  const first = { text: 'First report' };
  f.editions.saveEdition(f.run, first);
  expect(f.editions.saveEdition(f.run, { text: 'Replacement' })).toEqual(first);
  expect(f.editions.claimRoutineEdition(f.task, Date.now())).toBeNull();
  mocks.deliver.mockReturnValue({ status: 'delivered' });
  await f.runScheduledTask(f.request, f.dependencies);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.deliver.mock.calls[0][1]).toBe('First report');
});

test('stopping a routine before its result is delivered prevents transport and saving the new result', async () => {
  const f = await fixture();
  mocks.run.mockImplementation(async (_s, _c, _p, _t, onResult) => {
    f.jobs.setJobEnabled(f.task.id, false);
    await onResult({ text: 'Finished late' });
  });
  await expect(f.runScheduledTask(f.request, f.dependencies)).rejects.toThrow('stopped');
  expect(mocks.deliver).not.toHaveBeenCalled();
  expect(f.editions.readRoutineEdition(f.run)).toEqual({ kind: 'settled' });
});

test('a transport error reported through the runner never sends a second failure notification', async () => {
  const f = await fixture();
  mocks.run.mockImplementation(async (_s, _c, _p, _t, onResult, onError) => {
    try { await onResult({ text: 'Prepared report' }); } catch (error) { onError(error); }
  });
  mocks.deliver.mockImplementation(() => { throw new Error('Transport unavailable'); });
  await expect(f.runScheduledTask(f.request, f.dependencies)).rejects.toThrow('Transport unavailable');
  expect(mocks.deliver).toHaveBeenCalledTimes(1);
  expect(f.editions.readRoutineEdition(f.run)).toMatchObject({ kind: 'delivery_pending', result: { text: 'Prepared report' } });
});
