import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temp = useTempDir();
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
});
async function setup() {
  vi.stubEnv('HOME', temp());
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('test-session', null, 'web');
  return { db, session };
}
test('a failed counter update rolls back its message', async () => {
  const { db, session } = await setup();
  db.withMemoryDatabase((database) =>
    database.exec(
      "CREATE TRIGGER fail_counter BEFORE UPDATE OF message_count ON sessions BEGIN SELECT RAISE(ABORT, 'Test counter failure'); END;",
    ),
  );
  expect(() =>
    db.storeMessage(session.id, 'user_a', null, 'user', 'Hello'),
  ).toThrow('Test counter failure');
  expect(
    db.withMemoryDatabase((database) =>
      database.prepare('SELECT count(*) AS n FROM messages').get(),
    ),
  ).toEqual({ n: 0 });
  expect(db.getSessionById(session.id)?.message_count).toBe(0);
});
test('a failed assistant insert rolls back user and steering messages in the turn', async () => {
  const { db, session } = await setup();
  const { memoryService } = await import('../src/memory/memory-service.js');
  db.withMemoryDatabase((database) =>
    database.exec(
      "CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'Test assistant failure'); END;",
    ),
  );
  expect(() =>
    memoryService.storeTurn({
      sessionId: session.id,
      user: { userId: 'user_a', username: null, content: 'Hello' },
      steerNotes: ['One more detail'],
      assistant: { content: 'Reply' },
    }),
  ).toThrow('Test assistant failure');
  expect(
    db.withMemoryDatabase((database) =>
      database.prepare('SELECT count(*) AS n FROM messages').get(),
    ),
  ).toEqual({ n: 0 });
  expect(db.getSessionById(session.id)?.message_count).toBe(0);
});
test('successful turns persist their messages and matching counters', async () => {
  const { db, session } = await setup();
  const { memoryService } = await import('../src/memory/memory-service.js');
  const ids = memoryService.storeTurn({
    sessionId: session.id,
    user: { userId: 'user_a', username: null, content: 'Hello' },
    steerNotes: ['One more detail'],
    assistant: { content: 'Reply' },
  });
  expect(ids.assistantMessageId).toBeGreaterThan(ids.userMessageId);
  expect(db.getSessionById(session.id)?.message_count).toBe(3);
});

test('a semantic-memory failure rolls back the complete turn', async () => {
  const { db, session } = await setup();
  const { memoryService } = await import('../src/memory/memory-service.js');
  db.withMemoryDatabase((database) =>
    database.exec(
      "CREATE TRIGGER fail_semantic BEFORE INSERT ON semantic_memories BEGIN SELECT RAISE(ABORT, 'Test semantic failure'); END;",
    ),
  );
  expect(() =>
    memoryService.storeTurn({
      sessionId: session.id,
      user: { userId: 'user_a', username: null, content: 'Hello' },
      assistant: { content: 'Reply' },
    }),
  ).toThrow('Test semantic failure');
  expect(db.getSessionById(session.id)?.message_count).toBe(0);
  expect(
    db.withMemoryDatabase((database) =>
      database.prepare('SELECT count(*) AS n FROM messages').get(),
    ),
  ).toEqual({ n: 0 });
});
