/**
 * Durable lexical indexes follow semantic row writes atomically, including deletion.
 * Unlike semantic-memory's eligibility filters, these indexes only own tokens;
 * BM25 reranking uses the caller's candidate corpus, never another session's stats.
 */
import type Database from 'better-sqlite3';
import {
  buildMemoryFtsMatchQuery,
  getMemoryFtsTokenizerSpec,
  MEMORY_RECALL_TOKENIZERS,
  type MemoryRecallTokenizer,
} from './semantic-recall.js';
import { queryAll, queryOne } from './sqlite.js';

export function semanticMemoryIndexTable(
  tokenizer: MemoryRecallTokenizer,
): string {
  return `semantic_memory_fts_${tokenizer}`;
}

export function createSemanticMemoryIndexes(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_memories_recall
      ON semantic_memories(session_id, deleted, accessed_at DESC, confidence DESC, id)`);
    for (const tokenizer of MEMORY_RECALL_TOKENIZERS) {
      const table = semanticMemoryIndexTable(tokenizer);
      if (
        queryOne(database, 'SELECT 1 FROM sqlite_master WHERE name = ?', table)
      ) {
        continue;
      }
      database.exec(`
        CREATE VIRTUAL TABLE ${table} USING fts5(
          content, content='', contentless_delete=1,
          tokenize='${getMemoryFtsTokenizerSpec(tokenizer)}'
        );
        CREATE TRIGGER ${table}_ai AFTER INSERT ON semantic_memories
        WHEN new.deleted = 0 BEGIN
          INSERT INTO ${table}(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER ${table}_ad AFTER DELETE ON semantic_memories BEGIN
          DELETE FROM ${table} WHERE rowid = old.id;
        END;
        CREATE TRIGGER ${table}_au AFTER UPDATE OF id, content, deleted ON semantic_memories
        BEGIN
          DELETE FROM ${table} WHERE rowid = old.id;
          INSERT INTO ${table}(rowid, content)
          SELECT new.id, new.content WHERE new.deleted = 0;
        END;
        INSERT INTO ${table}(rowid, content)
        SELECT id, content FROM semantic_memories WHERE deleted = 0;
      `);
    }
  })();
}

// SQLite documents these read-only FTS5 statistics as packed SQLite varints:
// https://www.sqlite.org/fts5.html#averages_record_format
// https://www.sqlite.org/fts5.html#document_sizes_table_docsize_table_
function decodeFtsSizes(bytes: Buffer): number[] {
  const sizes: number[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    let value = 0;
    for (let index = 0; index < 9; index += 1) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error('Invalid FTS5 size record');
      value =
        value * (index === 8 ? 256 : 128) + (index === 8 ? byte : byte & 127);
      if (index === 8 || byte < 128) break;
    }
    if (!Number.isSafeInteger(value))
      throw new Error('Invalid FTS5 size record');
    sizes.push(value);
  }
  return sizes;
}

function inverseDocumentFrequency(documents: number, hits: number): number {
  // These constants and the floor match SQLite's built-in bm25(), not a tuned ranker.
  const idf = Math.log((documents - hits + 0.5) / (hits + 0.5));
  return idf > 0 ? idf : 1e-6;
}

export function rankSemanticMemoryIds(
  database: Database.Database,
  ids: number[],
  query: string,
  tokenizer: MemoryRecallTokenizer,
): number[] {
  const matchQuery = buildMemoryFtsMatchQuery(query, 12, tokenizer);
  if (ids.length === 0 || !matchQuery) return [];
  const table = semanticMemoryIndexTable(tokenizer);
  // JSON keeps large eval candidate sets within SQLite's bound-parameter limit.
  const candidateIds = JSON.stringify(ids);
  const lengths = new Map(
    queryAll<{ id: number; sz: Buffer }>(
      database,
      `SELECT id, sz FROM ${table}_docsize WHERE id IN (SELECT value FROM json_each(?))`,
      candidateIds,
    ).map((row) => [row.id, decodeFtsSizes(row.sz)[0]]),
  );
  const totalLength = ids.reduce((sum, id) => sum + (lengths.get(id) || 0), 0);
  if (totalLength === 0) return [];
  const averageLength = totalLength / ids.length;
  const stats = queryOne<{ block: Buffer }>(
    database,
    `SELECT block FROM ${table}_data WHERE id = 1`,
  );
  if (!stats) throw new Error('Missing semantic FTS5 statistics');
  const [globalCount, globalLength] = decodeFtsSizes(stats.block);
  const globalAverage = globalLength / globalCount;
  const scores = new Map<number, number>();

  for (const phrase of matchQuery.split(' OR ')) {
    const globalHits =
      queryOne<{ count: number }>(
        database,
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ?`,
        phrase,
      )?.count || 0;
    if (globalHits === 0) continue;
    // Unary + keeps SQLite from restarting the FTS cursor for each candidate ID.
    // A restart recomputes native BM25's corpus stats; one cursor shares them.
    const matches = queryAll<{ id: number; score: number }>(
      database,
      `SELECT rowid AS id, bm25(${table}) AS score FROM ${table}
       WHERE ${table} MATCH ? AND +rowid IN (SELECT value FROM json_each(?))`,
      phrase,
      candidateIds,
    );
    const globalIdf = inverseDocumentFrequency(globalCount, globalHits);
    const localIdf = inverseDocumentFrequency(ids.length, matches.length);
    for (const match of matches) {
      const length = lengths.get(match.id) || 0;
      const globalNorm = 1.2 * (0.25 + (0.75 * length) / globalAverage);
      const magnitude = -match.score;
      // Invert the single-phrase native score to recover its integer occurrence
      // count. SQLite retains authority over stemming and overlapping phrases.
      const frequency = Math.round(
        (magnitude * globalNorm) / (2.2 * globalIdf - magnitude),
      );
      const localNorm = 1.2 * (0.25 + (0.75 * length) / averageLength);
      const score = localIdf * ((frequency * 2.2) / (frequency + localNorm));
      scores.set(match.id, (scores.get(match.id) || 0) + score);
    }
  }
  // Stable sort retains source order for ties, as the old insertion-ordered FTS did.
  return ids
    .filter((id) => scores.has(id))
    .sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0));
}
