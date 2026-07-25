import { withMemoryDatabase } from './database.js';
import { queryOne } from './sqlite.js';

export interface ObservabilityIngestTokenRecord {
  token: string;
  updatedAt: string;
}

export function getObservabilityOffset(streamKey: string): number {
  return withMemoryDatabase((database) => {
    const normalized = streamKey.trim();
    if (!normalized) return 0;
    const row = queryOne<{ last_event_id: number }, [string]>(
      database,
      'SELECT last_event_id FROM observability_offsets WHERE stream_key = ?',
      normalized,
    );
    return row ? Math.max(0, Math.floor(row.last_event_id)) : 0;
  });
}

export function setObservabilityOffset(
  streamKey: string,
  lastEventId: number,
): void {
  withMemoryDatabase((database) => {
    const normalized = streamKey.trim();
    if (!normalized) return;
    const boundedLastEventId = Math.max(0, Math.floor(lastEventId));
    database
      .prepare(`
        INSERT INTO observability_offsets (stream_key, last_event_id, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(stream_key) DO UPDATE SET
          last_event_id = excluded.last_event_id,
          updated_at = excluded.updated_at
      `)
      .run(normalized, boundedLastEventId);
  });
}

export function getObservabilityIngestTokenRecord(
  tokenKey: string,
): ObservabilityIngestTokenRecord | null {
  return withMemoryDatabase((database) => {
    const normalized = tokenKey.trim();
    if (!normalized) return null;
    const row = queryOne<{ token: string; updated_at: string }, [string]>(
      database,
      'SELECT token, updated_at FROM observability_ingest_tokens WHERE token_key = ?',
      normalized,
    );
    if (!row || typeof row.token !== 'string') return null;
    const token = row.token.trim();
    if (!token) return null;
    return {
      token,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
    };
  });
}

export function getObservabilityIngestToken(tokenKey: string): string | null {
  return getObservabilityIngestTokenRecord(tokenKey)?.token ?? null;
}

export function setObservabilityIngestToken(
  tokenKey: string,
  token: string,
): void {
  withMemoryDatabase((database) => {
    const normalizedKey = tokenKey.trim();
    const normalizedToken = token.trim();
    if (!normalizedKey || !normalizedToken) return;
    database
      .prepare(`
        INSERT INTO observability_ingest_tokens (token_key, token, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(token_key) DO UPDATE SET
          token = excluded.token,
          updated_at = excluded.updated_at
      `)
      .run(normalizedKey, normalizedToken);
  });
}

export function deleteObservabilityIngestToken(tokenKey: string): void {
  withMemoryDatabase((database) => {
    const normalized = tokenKey.trim();
    if (!normalized) return;
    database
      .prepare('DELETE FROM observability_ingest_tokens WHERE token_key = ?')
      .run(normalized);
  });
}
