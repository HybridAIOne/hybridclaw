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
