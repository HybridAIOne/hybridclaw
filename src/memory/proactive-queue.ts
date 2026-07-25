import type Database from 'better-sqlite3';
import { withMemoryDatabase } from './database.js';
import { queryAll, queryOne } from './sqlite.js';

export interface QueuedProactiveMessage {
  id: number;
  channel_id: string;
  text: string;
  source: string;
  queued_at: string;
}

interface ProactiveQueueStore {
  enqueue(
    channelId: string,
    text: string,
    source: string,
    maxQueueSize: number,
  ): { queued: number; dropped: number };
  list(limit?: number): QueuedProactiveMessage[];
  claim(channelId: string, limit?: number): QueuedProactiveMessage[];
  delete(id: number): void;
  count(): number;
}

function createProactiveQueueStore(
  database: Database.Database,
): ProactiveQueueStore {
  return {
    enqueue(channelId, text, source, maxQueueSize) {
      const boundedMax = Math.max(1, Math.floor(maxQueueSize));
      database
        .prepare(
          "INSERT INTO proactive_message_queue (channel_id, text, source, queued_at) VALUES (?, ?, ?, datetime('now'))",
        )
        .run(channelId, text, source);

      const countRow = queryOne<{ count: number }>(
        database,
        'SELECT COUNT(*) as count FROM proactive_message_queue',
      ) || { count: 0 };
      const overLimit = Math.max(0, countRow.count - boundedMax);
      if (overLimit > 0) {
        database
          .prepare(`
            DELETE FROM proactive_message_queue
            WHERE id IN (
              SELECT id
              FROM proactive_message_queue
              ORDER BY id ASC
              LIMIT ?
            )
          `)
          .run(overLimit);
      }

      return {
        queued: countRow.count - overLimit,
        dropped: overLimit,
      };
    },

    list(limit = 100) {
      const boundedLimit = Math.max(1, Math.floor(limit));
      return queryAll<QueuedProactiveMessage, [number]>(
        database,
        'SELECT * FROM proactive_message_queue ORDER BY id ASC LIMIT ?',
        boundedLimit,
      );
    },

    claim(channelId, limit = 20) {
      const normalizedChannelId = channelId.trim();
      if (!normalizedChannelId) return [];
      const boundedLimit = Math.max(1, Math.floor(limit));
      const runClaim = database.transaction(
        (
          targetChannelId: string,
          maxRows: number,
        ): QueuedProactiveMessage[] => {
          const rows = queryAll<QueuedProactiveMessage, [string, number]>(
            database,
            'SELECT * FROM proactive_message_queue WHERE channel_id = ? ORDER BY id ASC LIMIT ?',
            targetChannelId,
            maxRows,
          );
          if (rows.length === 0) return rows;

          const deleteRow = database.prepare(
            'DELETE FROM proactive_message_queue WHERE id = ?',
          );
          for (const row of rows) {
            deleteRow.run(row.id);
          }
          return rows;
        },
      );

      return runClaim(normalizedChannelId, boundedLimit);
    },

    delete(id) {
      database
        .prepare('DELETE FROM proactive_message_queue WHERE id = ?')
        .run(id);
    },

    count() {
      const row = queryOne<{ count: number }>(
        database,
        'SELECT COUNT(*) as count FROM proactive_message_queue',
      ) || { count: 0 };
      return row.count;
    },
  };
}

const proactiveQueueStores = new WeakMap<
  Database.Database,
  ProactiveQueueStore
>();

function withProactiveQueueStore<T>(
  operation: (store: ProactiveQueueStore) => T,
): T {
  return withMemoryDatabase((database) => {
    let store = proactiveQueueStores.get(database);
    if (!store) {
      store = createProactiveQueueStore(database);
      proactiveQueueStores.set(database, store);
    }
    return operation(store);
  });
}

export function enqueueProactiveMessage(
  channelId: string,
  text: string,
  source: string,
  maxQueueSize: number,
): { queued: number; dropped: number } {
  return withProactiveQueueStore((store) =>
    store.enqueue(channelId, text, source, maxQueueSize),
  );
}

export function listQueuedProactiveMessages(
  limit = 100,
): QueuedProactiveMessage[] {
  return withProactiveQueueStore((store) => store.list(limit));
}

export function claimQueuedProactiveMessages(
  channelId: string,
  limit = 20,
): QueuedProactiveMessage[] {
  return withProactiveQueueStore((store) => store.claim(channelId, limit));
}

export function deleteQueuedProactiveMessage(id: number): void {
  withProactiveQueueStore((store) => store.delete(id));
}

export function getQueuedProactiveMessageCount(): number {
  return withProactiveQueueStore((store) => store.count());
}
