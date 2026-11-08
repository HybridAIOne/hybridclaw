/**
 * The durable proactive queue retains pull deliveries until acknowledged.
 * A timed claim excludes competing pulls; stale claims can be redelivered.
 * Channel sending and display acknowledgement are separate boundaries.
 */
import { randomUUID } from 'node:crypto';
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
  claim_token: string | null;
  claim_expires_at: string | null;
}

// 60s (engineering choice, 2026-11-08): allow a client to render and acknowledge;
// a disconnected client releases delivery after this bounded wait.
export const PROACTIVE_PULL_LEASE_MS = 60_000;

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
  acknowledge(channelId: string, token: string, ids: number[]): number;
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
          const rows = queryAll<
            QueuedProactiveMessage,
            [string, string, number]
          >(
            database,
            'SELECT * FROM proactive_message_queue WHERE channel_id = ? AND failed_at IS NULL AND (claim_expires_at IS NULL OR claim_expires_at <= ?) ORDER BY id ASC LIMIT ?',
            targetChannelId,
            new Date().toISOString(),
            maxRows,
          );
          if (rows.length === 0) return rows;

          const token = randomUUID();
          const expires = new Date(
            Date.now() + PROACTIVE_PULL_LEASE_MS,
          ).toISOString();
          const claimRow = database.prepare(
            'UPDATE proactive_message_queue SET claim_token = ?, claim_expires_at = ? WHERE id = ?',
          );
          for (const row of rows) {
            claimRow.run(token, expires, row.id);
            row.claim_token = token;
            row.claim_expires_at = expires;
          }
          return rows;
        },
      );

      return runClaim.immediate(normalizedChannelId, boundedLimit);
    },

    acknowledge(channelId, token, ids) {
      const remove = database.prepare(
        'DELETE FROM proactive_message_queue WHERE id = ? AND channel_id = ? AND claim_token = ? AND failed_at IS NULL',
      );
      return database.transaction(() =>
        ids.reduce(
          (count, id) => count + remove.run(id, channelId, token).changes,
          0,
        ),
      )();
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

/** A stale client cannot acknowledge a message reclaimed by another client. */
export function acknowledgeProactiveMessages(
  channelId: string,
  token: string,
  ids: number[],
): number {
  return withProactiveQueueStore((store) =>
    store.acknowledge(channelId, token, ids),
  );
}
