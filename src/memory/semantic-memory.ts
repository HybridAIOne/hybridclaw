import Database from 'better-sqlite3';
import type { SemanticMemoryEntry } from '../types/memory.js';
import type { StoredMessage } from '../types/session.js';
import { withMemoryDatabase } from './database.js';
import {
  buildMemoryFtsDocument,
  buildMemoryFtsMatchQuery,
  getMemoryFtsTokenizerSpec,
  type MemoryRecallBackend,
  type MemoryRecallRerank,
  type MemoryRecallTokenizer,
  normalizeMemoryRecallBackend,
  normalizeMemoryRecallRerank,
  normalizeMemoryRecallTokenizer,
  tokenizeMemoryRecallQuery,
} from './semantic-recall.js';
import { resolveSessionIdCompat } from './sessions.js';
import { queryAll, queryOne } from './sqlite.js';

function getSemanticMemoryDatabase(): Database.Database {
  return withMemoryDatabase((database) => database);
}

function parseTimestamp(raw: string): number {
  const value = raw.trim();
  if (!value) return 0;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseQueryTerms(
  query: string,
  tokenizer: MemoryRecallTokenizer,
): string[] {
  return tokenizeMemoryRecallQuery(query, 8, tokenizer);
}

const MAX_EMBEDDING_DIMENSIONS = 2048;

function normalizeEmbeddingInput(
  embedding: number[] | null | undefined,
): Float32Array | null {
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  if (embedding.length > MAX_EMBEDDING_DIMENSIONS) return null;
  const values: number[] = [];
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    values.push(value);
  }
  if (values.length === 0) return null;
  return new Float32Array(values);
}

function embeddingToBlob(embedding: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i += 1) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

function embeddingFromBlob(raw: unknown): number[] | null {
  if (!raw) return null;
  const bytes = Buffer.isBuffer(raw)
    ? raw
    : raw instanceof Uint8Array
      ? Buffer.from(raw)
      : null;
  if (!bytes || bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const values: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    values.push(bytes.readFloatLE(i));
  }
  return values.length > 0 ? values : null;
}

function cosineSimilarity(a: Float32Array, b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const bv = b[i];
    if (!Number.isFinite(bv)) return -1;
    dot += a[i] * bv;
    normA += a[i] * a[i];
    normB += bv * bv;
  }
  if (normA <= Number.EPSILON || normB <= Number.EPSILON) return -1;
  return dot / Math.sqrt(normA * normB);
}

function scoreSemanticLikeCandidate(
  row: SemanticMemoryEntry,
  normalizedQuery: string,
  queryTerms: string[],
): number {
  const content = row.content.toLowerCase();
  let score = 0;
  if (content.includes(normalizedQuery)) score += 8;
  if (content.startsWith(normalizedQuery)) score += 3;

  let termHits = 0;
  for (const term of queryTerms) {
    if (content.includes(term)) termHits += 1;
  }
  score += termHits * 2;
  score += Math.max(0, Math.min(1, row.confidence)) * 4;

  const hoursSinceAccess = Math.max(
    0,
    (Date.now() - parseTimestamp(row.accessed_at)) / 3_600_000,
  );
  if (hoursSinceAccess < 24) score += 1;
  return score;
}

type RawSemanticMemoryRow = Omit<
  SemanticMemoryEntry,
  'metadata' | 'embedding'
> & {
  metadata: string | null;
  embedding: Buffer | Uint8Array | null;
};

function parseSemanticMetadata(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function serializeSemanticMetadata(metadata: Record<string, unknown>): string {
  try {
    return JSON.stringify(metadata);
  } catch {
    return '{}';
  }
}

function mapSemanticMemoryRow(row: RawSemanticMemoryRow): SemanticMemoryEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    source: (row.source || '').trim() || 'conversation',
    scope: (row.scope || '').trim() || 'episodic',
    metadata: parseSemanticMetadata(row.metadata),
    content: row.content,
    confidence: row.confidence,
    embedding: embeddingFromBlob(row.embedding),
    source_message_id: row.source_message_id,
    created_at: row.created_at,
    accessed_at: row.accessed_at,
    access_count: row.access_count,
  };
}

function touchSemanticMemoryRows(entries: SemanticMemoryEntry[]): void {
  if (entries.length === 0) return;
  const touch = getSemanticMemoryDatabase().prepare(
    `UPDATE semantic_memories
     SET access_count = access_count + 1,
         accessed_at = datetime('now')
     WHERE id = ?
       AND deleted = 0`,
  );
  const transaction = getSemanticMemoryDatabase().transaction(
    (rows: SemanticMemoryEntry[]) => {
      for (const row of rows) {
        touch.run(row.id);
      }
    },
  );
  transaction(entries);
}

export function touchSemanticMemories(ids: number[]): void {
  const uniqueIds = [
    ...new Set(ids.map((id) => Math.floor(id)).filter((id) => id > 0)),
  ];
  if (uniqueIds.length === 0) return;
  const touch = getSemanticMemoryDatabase().prepare(
    `UPDATE semantic_memories
     SET access_count = access_count + 1,
         accessed_at = datetime('now')
     WHERE id = ?
       AND deleted = 0`,
  );
  const transaction = getSemanticMemoryDatabase().transaction(
    (rowIds: number[]) => {
      for (const id of rowIds) {
        touch.run(id);
      }
    },
  );
  transaction(uniqueIds);
}

export interface SemanticRecallFilter {
  role?: string;
  source?: string;
  scope?: string;
  after?: string;
  before?: string;
}

function applySemanticRecallFilterClauses(params: {
  whereClauses: string[];
  args: unknown[];
  filter?: SemanticRecallFilter;
}): void {
  if (!params.filter) return;
  const role = params.filter.role?.trim();
  if (role) {
    params.whereClauses.push('role = ?');
    params.args.push(role);
  }
  const source = params.filter.source?.trim();
  if (source) {
    params.whereClauses.push('source = ?');
    params.args.push(source);
  }
  const scope = params.filter.scope?.trim();
  if (scope) {
    params.whereClauses.push('scope = ?');
    params.args.push(scope);
  }
  const after = params.filter.after?.trim();
  if (after) {
    params.whereClauses.push('created_at >= ?');
    params.args.push(after);
  }
  const before = params.filter.before?.trim();
  if (before) {
    params.whereClauses.push('created_at <= ?');
    params.args.push(before);
  }
}

function recallSemanticMemoriesByLike(params: {
  sessionId: string;
  normalizedQuery: string;
  queryTerms: string[];
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
  touch?: boolean;
}): SemanticMemoryEntry[] {
  if (params.queryTerms.length === 0) return [];
  const candidateLimit = Math.max(params.limit * 8, 50);
  const likePatterns = params.queryTerms.map((term) => `%${term}%`);
  const placeholders = likePatterns
    .map(() => 'LOWER(content) LIKE ?')
    .join(' OR ');
  const whereClauses: string[] = [
    'session_id = ?',
    'deleted = 0',
    'confidence >= ?',
    `(${placeholders})`,
  ];
  const args: unknown[] = [
    params.sessionId,
    params.minConfidence,
    ...likePatterns,
  ];
  applySemanticRecallFilterClauses({
    whereClauses,
    args,
    filter: params.filter,
  });
  args.push(candidateLimit);

  const rawRows = queryAll<RawSemanticMemoryRow>(
    getSemanticMemoryDatabase(),
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY confidence DESC, accessed_at DESC
     LIMIT ?`,
    ...args,
  );
  if (rawRows.length === 0) return [];

  const ranked = rawRows
    .map(mapSemanticMemoryRow)
    .map((row) => ({
      row,
      score: scoreSemanticLikeCandidate(
        row,
        params.normalizedQuery,
        params.queryTerms,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.row.confidence !== a.row.confidence) {
        return b.row.confidence - a.row.confidence;
      }
      return (
        parseTimestamp(b.row.accessed_at) - parseTimestamp(a.row.accessed_at)
      );
    })
    .slice(0, params.limit)
    .map((entry) => entry.row);

  if (params.touch !== false) {
    touchSemanticMemoryRows(ranked);
  }
  return ranked;
}

function recallSemanticMemoriesByVector(params: {
  sessionId: string;
  queryEmbedding: Float32Array;
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
  touch?: boolean;
}): SemanticMemoryEntry[] {
  const candidateLimit = Math.max(params.limit * 10, 100);
  const whereClauses: string[] = [
    'session_id = ?',
    'deleted = 0',
    'confidence >= ?',
  ];
  const args: unknown[] = [params.sessionId, params.minConfidence];
  applySemanticRecallFilterClauses({
    whereClauses,
    args,
    filter: params.filter,
  });
  args.push(candidateLimit);
  const rawRows = queryAll<RawSemanticMemoryRow>(
    getSemanticMemoryDatabase(),
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY accessed_at DESC, confidence DESC
     LIMIT ?`,
    ...args,
  );
  if (rawRows.length === 0) return [];

  const rows = rawRows.map(mapSemanticMemoryRow);
  const ranked = rows
    .map((row) => {
      const similarity = row.embedding
        ? cosineSimilarity(params.queryEmbedding, row.embedding)
        : -1;
      return {
        row,
        similarity,
      };
    })
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (b.row.confidence !== a.row.confidence) {
        return b.row.confidence - a.row.confidence;
      }
      return (
        parseTimestamp(b.row.accessed_at) - parseTimestamp(a.row.accessed_at)
      );
    })
    .slice(0, params.limit)
    .map((entry) => entry.row);

  if (params.touch !== false) {
    touchSemanticMemoryRows(ranked);
  }
  return ranked;
}

function rankSemanticMemoriesWithFts(params: {
  rows: SemanticMemoryEntry[];
  query: string;
  limit: number;
  tokenizer: MemoryRecallTokenizer;
  rankMode: 'source' | 'bm25';
}): SemanticMemoryEntry[] {
  if (params.rows.length === 0) return [];
  const matchQuery = buildMemoryFtsMatchQuery(
    params.query,
    12,
    params.tokenizer,
  );
  if (!matchQuery) {
    return [];
  }

  const ftsDb = new Database(':memory:');
  try {
    const tokenizerSpec = getMemoryFtsTokenizerSpec(params.tokenizer);
    ftsDb.exec(
      `CREATE VIRTUAL TABLE semantic_recall USING fts5(memory_id UNINDEXED, content, tokenize='${tokenizerSpec}')`,
    );
  } catch (error) {
    ftsDb.close();
    throw new Error(
      `Full-text semantic recall requires SQLite FTS5 support: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const rowsById = new Map<number, SemanticMemoryEntry>();
    const insert = ftsDb.prepare(
      'INSERT INTO semantic_recall (memory_id, content) VALUES (?, ?)',
    );
    const transaction = ftsDb.transaction(() => {
      for (const row of params.rows) {
        rowsById.set(row.id, row);
        insert.run(
          row.id,
          buildMemoryFtsDocument(row.content, params.tokenizer),
        );
      }
    });
    transaction();

    if (params.rankMode === 'source') {
      const matches = ftsDb
        .prepare(
          `SELECT memory_id
           FROM semantic_recall
           WHERE semantic_recall MATCH ?`,
        )
        .all(matchQuery) as Array<{
        memory_id: number;
      }>;
      const matchedIds = new Set<number>(
        matches.map((match) => Number(match.memory_id)),
      );
      const ordered: SemanticMemoryEntry[] = [];
      for (const row of params.rows) {
        if (!matchedIds.has(row.id)) {
          continue;
        }
        ordered.push(row);
        if (ordered.length >= Math.max(1, params.limit)) {
          break;
        }
      }
      return ordered;
    }

    const matches = ftsDb
      .prepare(
        `SELECT memory_id
         FROM semantic_recall
         WHERE semantic_recall MATCH ?
         ORDER BY bm25(semantic_recall)
         LIMIT ?`,
      )
      .all(matchQuery, Math.max(1, params.limit)) as Array<{
      memory_id: number;
    }>;

    const ordered: SemanticMemoryEntry[] = [];
    for (const match of matches) {
      const row = rowsById.get(Number(match.memory_id));
      if (row) {
        ordered.push(row);
      }
    }
    return ordered;
  } finally {
    ftsDb.close();
  }
}

function rerankSemanticMemoriesWithFts(params: {
  rows: SemanticMemoryEntry[];
  query: string;
  tokenizer: MemoryRecallTokenizer;
}): SemanticMemoryEntry[] {
  const reranked = rankSemanticMemoriesWithFts({
    rows: params.rows,
    query: params.query,
    limit: params.rows.length,
    tokenizer: params.tokenizer,
    rankMode: 'bm25',
  });
  if (reranked.length === 0) {
    return params.rows;
  }

  const seen = new Set<number>();
  const ordered: SemanticMemoryEntry[] = [];
  for (const row of reranked) {
    seen.add(row.id);
    ordered.push(row);
  }
  for (const row of params.rows) {
    if (seen.has(row.id)) {
      continue;
    }
    ordered.push(row);
  }
  return ordered;
}

function fuseHybridSemanticMemories(params: {
  cosineRows: SemanticMemoryEntry[];
  fullTextRows: SemanticMemoryEntry[];
}): SemanticMemoryEntry[] {
  if (params.cosineRows.length === 0) {
    return params.fullTextRows;
  }
  if (params.fullTextRows.length === 0) {
    return params.cosineRows;
  }

  const rowsById = new Map<number, SemanticMemoryEntry>();
  const scoreById = new Map<number, number>();
  const cosineRankById = new Map<number, number>();
  const fullTextRankById = new Map<number, number>();

  for (let index = 0; index < params.cosineRows.length; index += 1) {
    const row = params.cosineRows[index];
    rowsById.set(row.id, row);
    cosineRankById.set(row.id, index + 1);
    scoreById.set(row.id, (scoreById.get(row.id) || 0) + 1 / (60 + index + 1));
  }

  for (let index = 0; index < params.fullTextRows.length; index += 1) {
    const row = params.fullTextRows[index];
    rowsById.set(row.id, row);
    fullTextRankById.set(row.id, index + 1);
    scoreById.set(row.id, (scoreById.get(row.id) || 0) + 1 / (60 + index + 1));
  }

  return [...rowsById.values()].sort((left, right) => {
    const leftScore = scoreById.get(left.id) || 0;
    const rightScore = scoreById.get(right.id) || 0;
    if (rightScore !== leftScore) return rightScore - leftScore;

    const leftFullTextRank =
      fullTextRankById.get(left.id) || Number.MAX_SAFE_INTEGER;
    const rightFullTextRank =
      fullTextRankById.get(right.id) || Number.MAX_SAFE_INTEGER;
    if (leftFullTextRank !== rightFullTextRank) {
      return leftFullTextRank - rightFullTextRank;
    }

    const leftCosineRank =
      cosineRankById.get(left.id) || Number.MAX_SAFE_INTEGER;
    const rightCosineRank =
      cosineRankById.get(right.id) || Number.MAX_SAFE_INTEGER;
    if (leftCosineRank !== rightCosineRank) {
      return leftCosineRank - rightCosineRank;
    }

    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return parseTimestamp(right.accessed_at) - parseTimestamp(left.accessed_at);
  });
}

function recallSemanticMemoriesByFts(params: {
  sessionId: string;
  normalizedQuery: string;
  limit: number;
  minConfidence: number;
  tokenizer: MemoryRecallTokenizer;
  rankMode: 'source' | 'bm25';
  filter?: SemanticRecallFilter;
  touch?: boolean;
}): SemanticMemoryEntry[] {
  const whereClauses: string[] = [
    'session_id = ?',
    'deleted = 0',
    'confidence >= ?',
  ];
  const args: unknown[] = [params.sessionId, params.minConfidence];
  applySemanticRecallFilterClauses({
    whereClauses,
    args,
    filter: params.filter,
  });
  const rows = queryAll<RawSemanticMemoryRow>(
    getSemanticMemoryDatabase(),
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY accessed_at DESC, confidence DESC`,
    ...args,
  ).map(mapSemanticMemoryRow);
  if (rows.length === 0) {
    return [];
  }

  const ranked = rankSemanticMemoriesWithFts({
    rows,
    query: params.normalizedQuery,
    limit: params.limit,
    tokenizer: params.tokenizer,
    rankMode: params.rankMode,
  });
  if (params.touch !== false) {
    touchSemanticMemoryRows(ranked);
  }
  return ranked;
}

function recallSemanticMemoriesByRecent(params: {
  sessionId: string;
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
  touch?: boolean;
}): SemanticMemoryEntry[] {
  const whereClauses: string[] = [
    'session_id = ?',
    'deleted = 0',
    'confidence >= ?',
  ];
  const args: unknown[] = [params.sessionId, params.minConfidence];
  applySemanticRecallFilterClauses({
    whereClauses,
    args,
    filter: params.filter,
  });
  args.push(params.limit);
  const rows = queryAll<RawSemanticMemoryRow>(
    getSemanticMemoryDatabase(),
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY accessed_at DESC, confidence DESC
     LIMIT ?`,
    ...args,
  );
  const mapped = rows.map(mapSemanticMemoryRow);
  if (params.touch !== false) {
    touchSemanticMemoryRows(mapped);
  }
  return mapped;
}

export function listSemanticMemoriesForSession(
  sessionId: string,
  limit = 5,
): SemanticMemoryEntry[] {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit || 5), 50));
  const rows = queryAll<RawSemanticMemoryRow>(
    getSemanticMemoryDatabase(),
    `SELECT *
     FROM semantic_memories
     WHERE session_id = ?
       AND deleted = 0
     ORDER BY accessed_at DESC, confidence DESC
     LIMIT ?`,
    resolvedSessionId,
    boundedLimit,
  );
  return rows.map(mapSemanticMemoryRow);
}

export function storeSemanticMemory(params: {
  sessionId: string;
  role: string;
  source?: string | null;
  scope?: string | null;
  metadata?: Record<string, unknown> | string | null;
  content: string;
  confidence?: number;
  embedding?: number[] | null;
  sourceMessageId?: number | null;
  createdAt?: string | null;
  accessedAt?: string | null;
  deleted?: boolean | number | null;
}): number {
  const resolvedSessionId = resolveSessionIdCompat(params.sessionId);
  const normalizedContent = params.content.trim();
  const source = (params.source || '').trim() || 'conversation';
  const scope = (params.scope || '').trim() || 'episodic';
  const metadata =
    typeof params.metadata === 'string'
      ? parseSemanticMetadata(params.metadata)
      : params.metadata && typeof params.metadata === 'object'
        ? params.metadata
        : {};
  const metadataJson = serializeSemanticMetadata(metadata);
  const deleted = params.deleted === true || params.deleted === 1 ? 1 : 0;
  const rawConfidence =
    typeof params.confidence === 'number' && Number.isFinite(params.confidence)
      ? params.confidence
      : 1;
  const boundedConfidence = Math.max(0, Math.min(1, rawConfidence));
  const normalizedEmbedding = normalizeEmbeddingInput(params.embedding);
  const embeddingBlob = normalizedEmbedding
    ? embeddingToBlob(normalizedEmbedding)
    : null;
  const createdAt = params.createdAt?.trim() || null;
  const accessedAt = params.accessedAt?.trim() || createdAt || null;
  const result = getSemanticMemoryDatabase()
    .prepare(
      `INSERT INTO semantic_memories
       (session_id, role, source, scope, metadata, content, confidence, embedding, source_message_id, created_at, accessed_at, access_count, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), 0, ?)`,
    )
    .run(
      resolvedSessionId,
      params.role,
      source,
      scope,
      metadataJson,
      normalizedContent,
      boundedConfidence,
      embeddingBlob,
      params.sourceMessageId ?? null,
      createdAt,
      accessedAt,
      deleted,
    );
  return result.lastInsertRowid as number;
}

export function recallSemanticMemories(params: {
  sessionId: string;
  query: string;
  limit?: number;
  limitHardCap?: number | null;
  minConfidence?: number;
  queryEmbedding?: number[] | null;
  backend?: MemoryRecallBackend;
  rerank?: MemoryRecallRerank;
  tokenizer?: MemoryRecallTokenizer;
  filter?: SemanticRecallFilter;
  touch?: boolean;
}): SemanticMemoryEntry[] {
  const resolvedSessionId = resolveSessionIdCompat(params.sessionId);
  const normalizedQuery = params.query.trim().toLowerCase();
  const tokenizer = normalizeMemoryRecallTokenizer(
    params.tokenizer,
    'unicode61',
  );
  const queryTerms = parseQueryTerms(normalizedQuery, tokenizer);
  const queryEmbedding = normalizeEmbeddingInput(params.queryEmbedding);

  const requestedLimit = Math.max(1, Math.floor(params.limit || 5));
  const limitHardCap =
    typeof params.limitHardCap === 'number' &&
    Number.isFinite(params.limitHardCap)
      ? Math.max(1, Math.floor(params.limitHardCap))
      : params.limitHardCap === null
        ? null
        : 50;
  const limit =
    limitHardCap == null
      ? requestedLimit
      : Math.min(requestedLimit, limitHardCap);
  const rawMinConfidence =
    typeof params.minConfidence === 'number' &&
    Number.isFinite(params.minConfidence)
      ? params.minConfidence
      : 0.2;
  const minConfidence = Math.max(0, Math.min(1, rawMinConfidence));
  const backend = normalizeMemoryRecallBackend(params.backend, 'cosine');
  const rerank = normalizeMemoryRecallRerank(params.rerank, 'none');

  if (!queryEmbedding && queryTerms.length === 0) {
    return recallSemanticMemoriesByRecent({
      sessionId: resolvedSessionId,
      limit,
      minConfidence,
      filter: params.filter,
      touch: params.touch,
    });
  }

  if (backend === 'full-text') {
    const fullTextCandidateLimit =
      rerank === 'bm25' ? Math.max(limit * 10, 100) : limit;
    const fullTextCandidates = recallSemanticMemoriesByFts({
      sessionId: resolvedSessionId,
      normalizedQuery,
      limit: fullTextCandidateLimit,
      minConfidence,
      tokenizer,
      rankMode: 'source',
      filter: params.filter,
      touch: false,
    });
    const selected =
      rerank === 'bm25'
        ? rerankSemanticMemoriesWithFts({
            rows: fullTextCandidates,
            query: normalizedQuery,
            tokenizer,
          }).slice(0, limit)
        : fullTextCandidates;
    if (params.touch !== false) {
      touchSemanticMemoryRows(selected);
    }
    return selected;
  }

  const cosineCandidateLimit = Math.max(limit * 10, 100);
  const cosineCandidates = queryEmbedding
    ? recallSemanticMemoriesByVector({
        sessionId: resolvedSessionId,
        queryEmbedding,
        limit:
          backend === 'hybrid' || rerank === 'bm25'
            ? cosineCandidateLimit
            : limit,
        minConfidence,
        filter: params.filter,
        touch: false,
      })
    : recallSemanticMemoriesByLike({
        sessionId: resolvedSessionId,
        normalizedQuery,
        queryTerms,
        limit:
          backend === 'hybrid' || rerank === 'bm25'
            ? Math.max(limit * 8, 50)
            : limit,
        minConfidence,
        filter: params.filter,
        touch: false,
      });

  if (backend === 'hybrid') {
    const fullTextCandidates = recallSemanticMemoriesByFts({
      sessionId: resolvedSessionId,
      normalizedQuery,
      limit: cosineCandidateLimit,
      minConfidence,
      tokenizer,
      rankMode: 'source',
      filter: params.filter,
      touch: false,
    });
    const fused = fuseHybridSemanticMemories({
      cosineRows: cosineCandidates,
      fullTextRows: fullTextCandidates,
    });
    const selected =
      rerank === 'bm25'
        ? rerankSemanticMemoriesWithFts({
            rows: fused,
            query: normalizedQuery,
            tokenizer,
          }).slice(0, limit)
        : fused.slice(0, limit);
    if (params.touch !== false) {
      touchSemanticMemoryRows(selected);
    }
    return selected;
  }

  if (rerank === 'bm25') {
    const reranked = rerankSemanticMemoriesWithFts({
      rows: cosineCandidates,
      query: normalizedQuery,
      tokenizer,
    }).slice(0, limit);
    if (params.touch !== false) {
      touchSemanticMemoryRows(reranked);
    }
    return reranked;
  }

  if (params.touch !== false) {
    touchSemanticMemoryRows(cosineCandidates);
  }
  return cosineCandidates;
}

export function forgetSemanticMemory(id: number): boolean {
  const normalizedId = Math.floor(id);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) return false;
  const result = getSemanticMemoryDatabase()
    .prepare(
      `UPDATE semantic_memories
       SET deleted = 1
       WHERE id = ?
         AND deleted = 0`,
    )
    .run(normalizedId);
  return result.changes > 0;
}

export function decaySemanticMemories(params?: {
  decayRate?: number;
  staleAfterDays?: number;
  minConfidence?: number;
}): number {
  const rawDecayRate =
    typeof params?.decayRate === 'number' && Number.isFinite(params.decayRate)
      ? params.decayRate
      : 0.1;
  const decayRate = Math.max(0, Math.min(0.95, rawDecayRate));
  const decayFactor = 1 - decayRate;
  const rawStaleAfterDays =
    typeof params?.staleAfterDays === 'number' &&
    Number.isFinite(params.staleAfterDays)
      ? params.staleAfterDays
      : 7;
  const staleAfterDays = Math.max(
    1,
    Math.min(365, Math.floor(rawStaleAfterDays)),
  );
  const rawMinConfidence =
    typeof params?.minConfidence === 'number' &&
    Number.isFinite(params.minConfidence)
      ? params.minConfidence
      : 0.1;
  const minConfidence = Math.max(0, Math.min(0.95, rawMinConfidence));
  const cutoff = `-${staleAfterDays} days`;
  const result = getSemanticMemoryDatabase()
    .prepare(
      `UPDATE semantic_memories
       SET confidence = MAX(?, confidence * ?)
       WHERE deleted = 0
         AND confidence > ?
         AND accessed_at < datetime('now', ?)`,
    )
    .run(minConfidence, decayFactor, minConfidence, cutoff);
  return result.changes;
}

export interface CompactionCandidate {
  cutoffId: number;
  olderMessages: StoredMessage[];
}

export function getCompactionCandidateMessages(
  sessionId: string,
  keepRecent: number,
): CompactionCandidate | null {
  const keep = Math.max(1, Math.floor(keepRecent));
  const cutoffRow = queryOne<{ id: number }, [string, number]>(
    getSemanticMemoryDatabase(),
    'SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
    sessionId,
    keep - 1,
  );
  if (!cutoffRow) return null;

  const older = queryAll<StoredMessage, [string, number]>(
    getSemanticMemoryDatabase(),
    'SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id ASC',
    sessionId,
    cutoffRow.id,
  );
  if (older.length === 0) return null;

  return {
    cutoffId: cutoffRow.id,
    olderMessages: older,
  };
}

export function deleteMessagesBeforeId(
  sessionId: string,
  cutoffId: number,
): number {
  const result = getSemanticMemoryDatabase()
    .prepare('DELETE FROM messages WHERE session_id = ? AND id < ?')
    .run(sessionId, cutoffId);
  getSemanticMemoryDatabase()
    .prepare(
      "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), last_active = datetime('now') WHERE id = ?",
    )
    .run(sessionId, sessionId);
  return result.changes;
}

export function deleteMessagesByIds(
  sessionId: string,
  messageIds: number[],
): number {
  const ids = Array.from(
    new Set(
      messageIds
        .map((value) => Math.floor(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
  if (ids.length === 0) return 0;

  const chunkSize = 900;
  const updateSessionCounts = getSemanticMemoryDatabase().prepare(
    "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), last_active = datetime('now') WHERE id = ?",
  );
  const transaction = getSemanticMemoryDatabase().transaction(
    (rowIds: number[]): number => {
      let deleted = 0;
      for (let index = 0; index < rowIds.length; index += chunkSize) {
        const chunk = rowIds.slice(index, index + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        const result = getSemanticMemoryDatabase()
          .prepare(
            `DELETE FROM messages
           WHERE session_id = ?
             AND id IN (${placeholders})`,
          )
          .run(sessionId, ...chunk);
        deleted += result.changes;
      }

      updateSessionCounts.run(sessionId, sessionId);
      return deleted;
    },
  );

  return transaction(ids);
}

export function updateSessionSummary(sessionId: string, summary: string): void {
  const normalized = summary.trim();
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  getSemanticMemoryDatabase()
    .prepare(
      "UPDATE sessions SET session_summary = ?, summary_updated_at = datetime('now'), compaction_count = compaction_count + 1 WHERE id = ?",
    )
    .run(normalized || null, resolvedSessionId);
}

export function markSessionMemoryFlush(sessionId: string): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  getSemanticMemoryDatabase()
    .prepare(
      "UPDATE sessions SET memory_flush_at = datetime('now') WHERE id = ?",
    )
    .run(resolvedSessionId);
}
