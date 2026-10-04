import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('hy-work-evidence-');
useCleanMocks({ resetModules: true, unmock: ['../src/config/config.js'] });
async function setup() {
  vi.resetModules();
  const directory = temp();
  vi.doMock('../src/config/config.js', async original => ({
    ...await original<typeof import('../src/config/config.js')>(), DATA_DIR: directory,
  }));
  const db = await import('../src/memory/db.js');
  const store = await import('../src/work/work-store.js');
  const tool = await import('../src/work/work-tool.js');
  const delivery = await import('../src/work/work-delivery.js');
  const notifications = await import('../src/gateway/web-notification-store.js');
  const turn = await import('../src/session/turn-user.js');
  const dbPath = path.join(directory, 'db.sqlite');
  db.initDatabase({ quiet: true, dbPath });
  db.getOrCreateSession('chat', null, 'web', 'main');
  notifications.bindWebNotificationSession('chat', 'operator-a');
  const begin = (id = 'run-1') => store.startWork({ id, agentId: 'main', owner: 'alice', sessionId: 'chat', runSessionId: 'cron', taskId: 1 });
  begin();
  return { db, dbPath, store, tool, delivery, notifications, turn, begin };
}

test('rationale is immutable, persists across database reopen and is scoped to the verified user', async () => {
  const { db, dbPath, store, tool, turn } = await setup();
  const endUser = turn.beginTurnUser('cron', 'alice');
  const endWork = tool.beginWork('cron', 'run-1');
  const body = { sessionId: 'cron', action: 'record', rationale: 'The meeting needs a decision on the launch.', evidence: [
    { reference: 'calendar:event-42', summary: 'The invitation asks for the launch decision.' },
  ] };
  expect(tool.runWorkTool(body)).toMatchObject({ ok: true });
  expect(tool.runWorkTool({ ...body, rationale: 'rewritten' }).ok).toBe(false);
  endWork(); endUser();
  expect(tool.runWorkTool(body).ok).toBe(false);
  const endBob = turn.beginTurnUser('chat', 'bob');
  expect(tool.runWorkTool({ sessionId: 'chat', action: 'get', id: 'run-1' }).ok).toBe(false);
  expect(JSON.parse(tool.runWorkTool({ sessionId: 'chat', action: 'list' }).result!)).toEqual([]);
  endBob();
  const endAlice = turn.beginTurnUser('chat', 'alice');
  db.closeDatabase(); db.initDatabase({ quiet: true, dbPath });
  const saved = JSON.parse(tool.runWorkTool({ sessionId: 'chat', action: 'get', id: 'run-1' }).result!);
  expect(saved).toMatchObject({ rationale: body.rationale, evidence: body.evidence });
  expect(store.readWork('run-1')?.completedAt).toBeNull();
  endAlice();
});

test('completion, chat storage, push attempts and viewing remain independent', async () => {
  const { store, delivery, notifications } = await setup();
  store.updateWork('run-1', work => { work.completedAt = '2026-10-04T12:00:00Z'; });
  delivery.markWorkSeen('run-1', 'operator-a');
  expect(store.readWork('run-1')?.seenAt).toBeNull();
  store.updateWork('run-1', work => { work.savedAt = '2026-10-04T12:01:00Z'; work.messageId = 42; });
  await expect(delivery.recordWorkPush('run-1', async () => { throw new Error('private network details'); })).rejects.toThrow();
  expect(store.readWork('run-1')).toMatchObject({ completedAt: expect.any(String), savedAt: expect.any(String), seenAt: null,
    attempts: [{ accepted: 0, error: 'relay_unavailable' }] });
  await delivery.recordWorkPush('run-1', async () => 'sent');
  expect(store.readWork('run-1')?.attempts).toHaveLength(2);
  expect(store.readWork('run-1')?.seenAt).toBeNull();
  notifications.acknowledgeWebNotifications('operator-a', ['chat:reminder:42']);
  expect(store.readWork('run-1')?.seenAt).toBeNull();
  delivery.markWorkSeen('run-1', 'operator-b');
  expect(store.readWork('run-1')?.seenAt).toBeNull();
  delivery.markWorkSeen('run-1', 'operator-a');
  const seen = store.readWork('run-1')?.seenAt;
  delivery.markWorkSeen('run-1', 'operator-a');
  expect(store.readWork('run-1')?.seenAt).toBe(seen);
  expect(store.workForMessage('chat', 42)?.id).toBe('run-1');
});

test('an in-flight notification stays unknown until its response arrives', async () => {
  const { store, delivery } = await setup();
  let finish!: (value: string) => void;
  const pending = delivery.recordWorkPush('run-1', () => new Promise<string>(resolve => { finish = resolve; }));
  expect(store.readWork('run-1')?.attempts[0]).toMatchObject({ finishedAt: null, accepted: 0, error: null });
  finish('sent'); await pending;
  expect(store.readWork('run-1')?.attempts[0]).toMatchObject({ finishedAt: expect.any(String), accepted: 1, error: null });
  expect(store.readWork('run-1')?.seenAt).toBeNull();
});

test('overlapping runs, anonymous turns and oversized evidence cannot alter provenance', async () => {
  const { tool, turn, begin, store } = await setup();
  const endUser = turn.beginTurnUser('cron', 'alice');
  const end = tool.beginWork('cron', 'run-1');
  const body = { sessionId: 'cron', action: 'record', rationale: 'why', evidence: [] };
  expect(tool.runWorkTool({ ...body, evidence: [{ reference: 'x'.repeat(2001), summary: 'fact' }] }).ok).toBe(false);
  const anonymous = turn.beginTurnUser('cron', undefined);
  expect(tool.runWorkTool(body).ok).toBe(false); anonymous();
  begin('run-2'); const second = tool.beginWork('cron', 'run-2');
  expect(tool.runWorkTool(body).ok).toBe(false); second();
  store.updateWork('run-1', work => { work.completedAt = new Date().toISOString(); });
  expect(tool.runWorkTool(body).ok).toBe(false);
  end(); endUser();
});
