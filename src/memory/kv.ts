import type Database from 'better-sqlite3';
import type { StructuredMemoryEntry } from '../types/memory.js';
import { withMemoryDatabase } from './database.js';
import { queryAll, queryOne } from './sqlite.js';

type MemoryKvRow = Omit<StructuredMemoryEntry, 'value'> & {
  value: Buffer | Uint8Array | string;
};

function normalizeMemoryKvKey(key: string): string {
  return key.trim();
}

function serializeMemoryKvValue(value: unknown): Buffer {
  if (typeof value === 'undefined') return Buffer.from('null', 'utf8');
  try {
    const serialized = JSON.stringify(value);
    return Buffer.from(
      typeof serialized === 'string' ? serialized : 'null',
      'utf8',
    );
  } catch {
    return Buffer.from('null', 'utf8');
  }
}

function parseMemoryKvValue(raw: unknown): unknown {
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : raw instanceof Uint8Array
      ? Buffer.from(raw).toString('utf8')
      : typeof raw === 'string'
        ? raw
        : null;
  if (text == null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function getMemoryValue(sessionId: string, key: string): unknown | null {
  return withMemoryDatabase((database) => {
    const normalizedKey = normalizeMemoryKvKey(key);
    if (!normalizedKey) return null;
    const row = queryOne<
      { value: Buffer | Uint8Array | string },
      [string, string]
    >(
      database,
      `SELECT value
       FROM kv_store
       WHERE agent_id = ?
         AND key = ?`,
      sessionId,
      normalizedKey,
    );
    return row ? parseMemoryKvValue(row.value) : null;
  });
}

export function setMemoryValue(
  sessionId: string,
  key: string,
  value: unknown,
): void {
  withMemoryDatabase((database) => {
    const normalizedKey = normalizeMemoryKvKey(key);
    if (!normalizedKey) return;
    const valueBlob = serializeMemoryKvValue(value);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO kv_store (agent_id, key, value, version, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(agent_id, key)
         DO UPDATE SET value = excluded.value, version = version + 1, updated_at = excluded.updated_at`,
      )
      .run(sessionId, normalizedKey, valueBlob, now);
  });
}

export function claimMemoryValue(
  sessionId: string,
  key: string,
  value: unknown,
): boolean {
  return withMemoryDatabase((database) => {
    const normalizedKey = normalizeMemoryKvKey(key);
    if (!normalizedKey) return false;
    const valueBlob = serializeMemoryKvValue(value);
    const now = new Date().toISOString();
    const result = database
      .prepare(
        `INSERT OR IGNORE INTO kv_store (agent_id, key, value, version, updated_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .run(sessionId, normalizedKey, valueBlob, now);
    return result.changes > 0;
  });
}

export function deleteMemoryValue(sessionId: string, key: string): boolean {
  return withMemoryDatabase((database) => {
    const normalizedKey = normalizeMemoryKvKey(key);
    if (!normalizedKey) return false;
    const result = database
      .prepare(
        `DELETE FROM kv_store
         WHERE agent_id = ?
           AND key = ?`,
      )
      .run(sessionId, normalizedKey);
    return result.changes > 0;
  });
}

export function deleteMemoryValuesByKey(key: string): number {
  return withMemoryDatabase((database) => {
    const normalizedKey = normalizeMemoryKvKey(key);
    if (!normalizedKey) return 0;
    return database
      .prepare(
        `DELETE FROM kv_store
         WHERE key = ?`,
      )
      .run(normalizedKey).changes;
  });
}

export function deleteMemoryValuesByKeyPrefix(prefix: string): number {
  return withMemoryDatabase((database) => {
    const normalizedPrefix = normalizeMemoryKvKey(prefix);
    if (!normalizedPrefix) return 0;
    return database
      .prepare(
        `DELETE FROM kv_store
         WHERE substr(key, 1, ?) = ?`,
      )
      .run(normalizedPrefix.length, normalizedPrefix).changes;
  });
}

export function listMemoryValues(
  sessionId: string,
  prefix?: string,
): Array<{
  agent_id: string;
  key: string;
  value: unknown;
  version: number;
  updated_at: string;
}> {
  return withMemoryDatabase((database: Database.Database) => {
    const normalizedPrefix = (prefix || '').trim();
    const rows = normalizedPrefix
      ? queryAll<MemoryKvRow, [string, string]>(
          database,
          `SELECT agent_id, key, value, version, updated_at
           FROM kv_store
           WHERE agent_id = ?
             AND key LIKE ?
           ORDER BY key ASC`,
          sessionId,
          `${normalizedPrefix}%`,
        )
      : queryAll<MemoryKvRow, [string]>(
          database,
          `SELECT agent_id, key, value, version, updated_at
           FROM kv_store
           WHERE agent_id = ?
           ORDER BY key ASC`,
          sessionId,
        );

    return rows.map((row) => ({
      agent_id: row.agent_id,
      key: row.key,
      value: parseMemoryKvValue(row.value),
      version: row.version,
      updated_at: row.updated_at,
    }));
  });
}
