import path from 'node:path';
import { expect, it } from 'vitest';
import type { RoutingTrace } from '../src/types/routing-trace.js';
import { useTempDir } from './test-utils.ts';
const temp = useTempDir('routing-history-');
it('persists routing evidence, migrates existing databases, and copies it into branches', async () => {
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(temp(), 'test.db') });
  // Simulate the previous schema without losing an existing message.
  const session = db.getOrCreateSession('routing-history', null, 'web', 'main');
  const id = db.storeMessage(session.id, 'assistant', null, 'assistant', 'Answer');
  db.withMemoryDatabase((database) => {
    database.exec('ALTER TABLE messages DROP COLUMN routing_trace_json');
    database.pragma('user_version = 59');
  });
  const { runMigrations } = await import('../src/memory/schema/migrations.js');
  db.withMemoryDatabase((database) => runMigrations(database, { quiet: true }));
  const trace: RoutingTrace = { version: 1, mode: 'direct', status: 'complete', durationMs: 20, attempts: [] };
  db.setMessageRoutingTrace(id, trace);
  const cutoff = db.storeMessage(session.id, 'user_a', null, 'user', 'Next');
  expect(db.getConversationHistoryPage(session.id).history.find((m) => m.id === id)?.routingTrace).toEqual(trace);
  const fork = db.forkSessionBranch({ sessionId: session.id, beforeMessageId: cutoff });
  expect(db.getConversationHistoryPage(fork.session.id).history.find((m) => m.role === 'assistant')?.routingTrace).toEqual(trace);
  db.withMemoryDatabase((database) => database.prepare('UPDATE messages SET routing_trace_json = ? WHERE id = ?').run('{bad', id));
  expect(db.getConversationHistoryPage(session.id).history.find((m) => m.id === id)?.routingTrace).toBeUndefined();
});
