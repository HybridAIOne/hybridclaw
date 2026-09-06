import type Database from 'better-sqlite3';
import { withMemoryDatabase } from './database.js';
import { queryAll, queryOne } from './sqlite.js';

export interface QueuedProactiveMessage {
  id: number;
  channel_id: string;
  text: string;
  source: string;
  queued_at: string;
  failed_at: string | null;
  failure_reason: string | null;
}

// 7 days (owner call, 2026-09-06): long enough for an operator to notice a
// failed delivery in the scheduler view after a weekend; rows are pruned on
// the next flush so the table cannot grow without bound.
export const FAILED_PROACTIVE_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ProactiveQueueStore {
  enqueue(
    channelId: string,
    text: string,
    source: string,
    maxQueueSize: number,
  ): { queued: number; dropped: number };
  list(limit?: number): QueuedProactiveMessage[];
  listFailed(limit?: number): QueuedProactiveMessage[];
  claim(channelId: string, limit?: number): QueuedProactiveMessage[];
  delete(id: number): void;
  markFailed(id: number, reason: string): void;
  pruneFailed(olderThanMs: number): number;
  count(): number;
  countFailed(): number;
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
        'SELECT COUNT(*) as count FROM proactive_message_queue WHERE failed_at IS NULL',
      ) || { count: 0 };
      const overLimit = Math.max(0, countRow.count - boundedMax);
      if (overLimit > 0) {
        database
          .prepare(`
            DELETE FROM proactive_message_queue
            WHERE id IN (
              SELECT id
              FROM proactive_message_queue
              WHERE failed_at IS NULL
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
        'SELECT * FROM proactive_message_queue WHERE failed_at IS NULL ORDER BY id ASC LIMIT ?',
        boundedLimit,
      );
    },

    listFailed(limit = 100) {
      const boundedLimit = Math.max(1, Math.floor(limit));
      return queryAll<QueuedProactiveMessage, [number]>(
        database,
        'SELECT * FROM proactive_message_queue WHERE failed_at IS NOT NULL ORDER BY id DESC LIMIT ?',
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
            'SELECT * FROM proactive_message_queue WHERE channel_id = ? AND failed_at IS NULL ORDER BY id ASC LIMIT ?',
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

    markFailed(id, reason) {
      database
        .prepare(
          "UPDATE proactive_message_queue SET failed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), failure_reason = ? WHERE id = ?",
        )
        .run(reason.trim().slice(0, 500) || 'Delivery failed', id);
    },

    pruneFailed(olderThanMs) {
      const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
      const result = database
        .prepare(
          'DELETE FROM proactive_message_queue WHERE failed_at IS NOT NULL AND failed_at < ?',
        )
        .run(cutoff.toISOString());
      return Number(result.changes || 0);
    },

    count() {
      const row = queryOne<{ count: number }>(
        database,
        'SELECT COUNT(*) as count FROM proactive_message_queue WHERE failed_at IS NULL',
      ) || { count: 0 };
      return row.count;
    },

    countFailed() {
      const row = queryOne<{ count: number }>(
        database,
        'SELECT COUNT(*) as count FROM proactive_message_queue WHERE failed_at IS NOT NULL',
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

export function listFailedProactiveMessages(
  limit = 100,
): QueuedProactiveMessage[] {
  return withProactiveQueueStore((store) => store.listFailed(limit));
}

export function deleteQueuedProactiveMessage(id: number): void {
  withProactiveQueueStore((store) => store.delete(id));
}

export function markQueuedProactiveMessageFailed(
  id: number,
  reason: string,
): void {
  withProactiveQueueStore((store) => store.markFailed(id, reason));
}

export function pruneFailedProactiveMessages(
  olderThanMs = FAILED_PROACTIVE_MESSAGE_RETENTION_MS,
): number {
  return withProactiveQueueStore((store) => store.pruneFailed(olderThanMs));
}

export function getQueuedProactiveMessageCount(): number {
  return withProactiveQueueStore((store) => store.count());
}

export function getFailedProactiveMessageCount(): number {
  return withProactiveQueueStore((store) => store.countFailed());
}
