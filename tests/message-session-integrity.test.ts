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

test.each(['user', 'assistant'])(
  'rejects a late %s write after deleting its session',
  async (role) => {
    const db = await setup();
    const session = db.getOrCreateSession('test-session', null, 'web');
    db.storeMessage(session.id, 'user_a', null, 'user', 'Initial message');
    expect(db.deleteSessionData(session.id).deleted).toBe(true);
    expect(() =>
      db.storeMessage(session.id, 'user_a', null, role, 'Late message'),
    ).toThrow();
    expect(
      db.withMemoryDatabase((database) =>
        database.prepare('SELECT count(*) AS n FROM messages').get(),
      ),
    ).toEqual({ n: 0 });
    expect(db.getSessionById(session.id)).toBeUndefined();
  },
);

test('rejects an unknown session without inserting a message', async () => {
  const db = await setup();
  expect(() =>
    db.storeMessage('missing-session', 'user_a', null, 'user', 'Hello'),
  ).toThrow();
  expect(
    db.withMemoryDatabase((database) =>
      database.prepare('SELECT count(*) AS n FROM messages').get(),
    ),
  ).toEqual({ n: 0 });
});

test('stores messages through a canonical session key and its stored ID', async () => {
  const db = await setup();
  const { buildSessionKey } = await import('../src/session/session-key.js');
  const key = buildSessionKey('main', 'web', 'dm', 'test-peer');
  const session = db.getOrCreateSession(key, null, 'web');
  const first = db.storeMessage(key, 'user_a', null, 'user', 'Hello');
  const second = db.storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Reply',
  );
  expect(second).toBeGreaterThan(first);
  expect(db.getSessionById(session.id)?.message_count).toBe(2);
  expect(
    db.withMemoryDatabase((database) =>
      database.prepare('SELECT DISTINCT session_id FROM messages').all(),
    ),
  ).toEqual([{ session_id: session.id }]);
});

test('scheduled execution creates its session before dispatch and cannot recreate it after deletion', async () => {
  const db = await setup();
  vi.doMock('../src/agent/agent.js', () => ({
    runAgent: async (input: { sessionId: string }) => {
      expect(db.getSessionById(input.sessionId)).toBeDefined();
      expect(db.deleteSessionData(input.sessionId).deleted).toBe(true);
      return { status: 'success', result: 'Late result', toolsUsed: [] };
    },
  }));
  try {
    const { runIsolatedScheduledTask } = await import('../src/scheduler/scheduled-task-runner.js');
    const onResult = vi.fn();
    const onError = vi.fn();
    await runIsolatedScheduledTask({ taskId: 42, prompt: 'Prepare a report', channelId: 'tui', chatbotId: 'test-bot', model: 'test-model', agentId: 'main', onResult, onError });
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cannot store a message for a missing session.' }));
    expect(db.withMemoryDatabase(database => database.prepare('SELECT count(*) AS n FROM messages').get())).toEqual({ n: 0 });
  } finally {
    vi.doUnmock('../src/agent/agent.js');
  }
});
