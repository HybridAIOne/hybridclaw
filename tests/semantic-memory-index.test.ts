import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  closeDatabase,
  initDatabase,
  withMemoryDatabase,
} from '../src/memory/database.js';
import { storeMessage } from '../src/memory/messages.js';
import { runMigrations } from '../src/memory/schema/migrations.js';
import {
  forgetSemanticMemory,
  recallSemanticMemories,
  storeSemanticMemory,
} from '../src/memory/semantic-memory.js';
import * as semanticIndex from '../src/memory/semantic-memory-index.js';
import {
  rankSemanticMemoryIds,
  semanticMemoryIndexTable,
} from '../src/memory/semantic-memory-index.js';
import {
  buildMemoryFtsMatchQuery,
  getMemoryFtsTokenizerSpec,
  MEMORY_RECALL_TOKENIZERS,
  type MemoryRecallTokenizer,
} from '../src/memory/semantic-recall.js';
import {
  clearSessionHistory,
  deleteSessionData,
  getOrCreateSession,
  resetSessionState,
} from '../src/memory/sessions.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('semantic-index-');
useCleanMocks({ restoreAllMocks: true, cleanup: closeDatabase });
let dbPath: string;
beforeEach(() => {
  dbPath = path.join(makeTempDir(), 'memory.db');
  initDatabase({ quiet: true, dbPath });
  getOrCreateSession('session_a', null, 'channel_a');
  getOrCreateSession('session_b', null, 'channel_b');
});

const tokenizers = MEMORY_RECALL_TOKENIZERS;
function remember(
  content: string,
  extra: Partial<Parameters<typeof storeSemanticMemory>[0]> = {},
): number {
  return storeSemanticMemory({
    sessionId: 'session_a',
    role: 'user',
    content,
    accessedAt: '2026-01-01T00:00:00Z',
    ...extra,
  });
}
function search(
  query: string,
  tokenizer: MemoryRecallTokenizer,
  extra: Partial<Parameters<typeof recallSemanticMemories>[0]> = {},
) {
  return recallSemanticMemories({
    sessionId: 'session_a',
    query,
    backend: 'full-text',
    tokenizer,
    touch: false,
    limit: 50,
    ...extra,
  });
}

// The removed temporary-index implementation is the ranking oracle, not a second
// production path. Candidate order controls exact BM25 ties in the legacy index.
function legacyScores(
  ids: number[],
  query: string,
  tokenizer: MemoryRecallTokenizer,
): Array<{ id: number; score: number }> {
  const reference = new Database(':memory:');
  try {
    reference.exec(
      `CREATE VIRTUAL TABLE recall USING fts5(memory_id UNINDEXED, content, tokenize='${getMemoryFtsTokenizerSpec(tokenizer)}')`,
    );
    const insert = reference.prepare(
      'INSERT INTO recall(memory_id, content) VALUES (?, ?)',
    );
    withMemoryDatabase((db) => {
      const get = db.prepare<[number], { content: string }>(
        'SELECT content FROM semantic_memories WHERE id = ?',
      );
      reference.transaction(() => {
        for (const id of ids) insert.run(id, get.get(id)?.content);
      })();
    });
    const match = buildMemoryFtsMatchQuery(query, 12, tokenizer);
    if (!match) return [];
    return reference
      .prepare<[string], { id: number; score: number }>(
        'SELECT memory_id AS id, bm25(recall) AS score FROM recall WHERE recall MATCH ? ORDER BY bm25(recall)',
      )
      .all(match);
  } finally {
    reference.close();
  }
}

function legacyRank(
  ids: number[],
  query: string,
  tokenizer: MemoryRecallTokenizer,
): number[] {
  return legacyScores(ids, query, tokenizer).map((row) => row.id);
}

function expectEquivalentRanking(
  actual: number[],
  ids: number[],
  query: string,
  tokenizer: MemoryRecallTokenizer,
): void {
  const expected = legacyScores(ids, query, tokenizer);
  expect([...actual].sort((a, b) => a - b)).toEqual(
    expected.map((row) => row.id).sort((a, b) => a - b),
  );
  const scores = new Map(expected.map((row) => [row.id, row.score]));
  for (let index = 1; index < actual.length; index += 1) {
    const previous = scores.get(actual[index - 1]) || 0;
    const current = scores.get(actual[index]) || 0;
    // Native C and JS can differ by one ulp for mathematically tied sums.
    const tolerance =
      Number.EPSILON * Math.max(Math.abs(previous), Math.abs(current)) * 8;
    expect(previous - current, query).toBeLessThanOrEqual(tolerance);
  }
}

describe.each(tokenizers)('%s durable lexical index', (tokenizer) => {
  test.each([
    [
      'adopted',
      ['Adoption planning', 'adopted adopted', 'adopting systems', 'unrelated'],
    ],
    [
      'service',
      ['microservice rollout', 'service service', 'servers', 'unrelated'],
    ],
    ['cafe naive', ['Café naïve', 'cafe cafe', 'naive naïve', 'unrelated']],
    [
      'foo-bar foo_bar',
      ['foo bar foo bar', 'foo_bar', 'foo-bar', 'bar foo', 'unrelated'],
    ],
    ['aaaa', ['aaaaaa', 'aaaa', 'aaa', 'unrelated']],
    ['aa', ['aa aa', 'aa', 'aaaa', 'unrelated']],
    ['!!!', ['abc', 'def']],
    ['run running runs', ['running running', 'runs', 'run', 'unrelated']],
  ])('matches legacy tokenization and ranking for %s', (query, contents) => {
    const ids = contents.map((content) => remember(content));
    // Extra sessions must not participate in the candidate corpus.
    remember('service cafe adopted foo bar '.repeat(250), {
      sessionId: 'session_b',
    });
    const expected = legacyRank(ids, query, tokenizer);
    expect(
      withMemoryDatabase((db) =>
        rankSemanticMemoryIds(db, ids, query, tokenizer),
      ),
    ).toEqual(expected);
    if (query !== '!!!') {
      expect(
        search(query, tokenizer, { rerank: 'bm25' }).map((row) => row.id),
      ).toEqual(expected);
    }
  });

  test('preserves candidate corpus statistics, ties, and nonmatching vector tails', () => {
    const ids: number[] = [];
    for (let index = 0; index < 170; index += 1) {
      const words = ['alpha', 'beta', 'gamma', 'delta', 'adopted', 'adoption'];
      const content = Array.from(
        { length: (index % 19) + 1 },
        (_, offset) => words[(index * 13 + offset * 7) % words.length],
      ).join(' ');
      ids.push(remember(content, { embedding: [1, 0] }));
    }
    ids.push(remember('', { embedding: [1, 0] }));
    const corpus = ids.filter((_, index) => index % 3 !== 0).reverse();
    for (const query of [
      'alpha beta',
      'adopted gamma',
      'alpha alpha beta',
      'alpha-beta',
    ]) {
      expectEquivalentRanking(
        withMemoryDatabase((db) =>
          rankSemanticMemoryIds(db, corpus, query, tokenizer),
        ),
        corpus,
        query,
        tokenizer,
      );
    }
    const candidates = recallSemanticMemories({
      sessionId: 'session_a',
      query: 'alpha beta',
      queryEmbedding: [1, 0],
      limit: 100,
      limitHardCap: null,
      touch: false,
    });
    const candidateIds = candidates.map((row) => row.id);
    const matched = legacyRank(candidateIds, 'alpha beta', tokenizer);
    const expected = [
      ...matched,
      ...candidateIds.filter((id) => !matched.includes(id)),
    ].slice(0, 10);
    expect(
      recallSemanticMemories({
        sessionId: 'session_a',
        query: 'alpha beta',
        queryEmbedding: [1, 0],
        limit: 10,
        rerank: 'bm25',
        tokenizer,
        touch: false,
      }).map((row) => row.id),
    ).toEqual(expected);
  });

  test.each([true, false])(
    'preserves hybrid BM25 candidates with embeddings=%s',
    (withEmbeddings) => {
      for (const content of [
        'alpha alpha',
        'alpha beta',
        'beta gamma',
        'unrelated',
      ]) {
        remember(content, { embedding: withEmbeddings ? [1, 0] : null });
      }
      remember('alpha '.repeat(1000), { sessionId: 'session_b' });
      const rank = vi.spyOn(semanticIndex, 'rankSemanticMemoryIds');
      const result = search('alpha beta', tokenizer, {
        backend: 'hybrid',
        rerank: 'bm25',
        queryEmbedding: withEmbeddings ? [1, 0] : null,
        limit: 4,
      });
      expect(rank).toHaveBeenCalledOnce();
      const ids = rank.mock.calls[0][1];
      const matched = legacyRank(ids, 'alpha beta', tokenizer);
      expect(result.map((row) => row.id)).toEqual(
        [...matched, ...ids.filter((id) => !matched.includes(id))].slice(0, 4),
      );
    },
  );

  test('excludes verbatim history until its source message is removed', () => {
    const messageId = storeMessage(
      'session_a',
      'user_a',
      'user',
      'user',
      'alpha beta',
    );
    const conversation = remember('alpha beta', { sourceMessageId: messageId });
    const summary = remember('alpha beta', {
      source: 'compaction',
      sourceMessageId: messageId,
    });
    expect(
      search('alpha', tokenizer, {
        filter: { excludeVerbatimHistory: true },
      }).map((row) => row.id),
    ).toEqual([summary]);
    withMemoryDatabase((db) =>
      db.prepare('DELETE FROM messages WHERE id = ?').run(messageId),
    );
    expect(
      search('alpha', tokenizer, {
        filter: { excludeVerbatimHistory: true },
      }).map((row) => row.id),
    ).toEqual([conversation, summary]);
  });

  test('removes index entries on session history clearing and deletion', () => {
    remember('alpha');
    remember('alpha', { sessionId: 'session_b' });
    clearSessionHistory('session_a');
    expect(search('alpha', tokenizer)).toEqual([]);
    expect(search('alpha', tokenizer, { sessionId: 'session_b' })).toHaveLength(
      1,
    );
    expect(deleteSessionData('session_b').deletedSemanticMemories).toBe(1);
    expect(
      withMemoryDatabase((db) =>
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${semanticMemoryIndexTable(tokenizer)}_docsize`,
          )
          .get(),
      ),
    ).toEqual({ count: 0 });
  });

  test('indexes writes, updates, soft deletes, restores, hard deletes, and rollback', () => {
    const id = remember('alpha');
    const hidden = remember('alpha', { deleted: true });
    expect(search('alpha', tokenizer).map((row) => row.id)).toEqual([id]);
    withMemoryDatabase((db) =>
      db
        .prepare('UPDATE semantic_memories SET content = ? WHERE id = ?')
        .run('beta', id),
    );
    expect(search('alpha', tokenizer)).toEqual([]);
    expect(search('beta', tokenizer).map((row) => row.id)).toEqual([id]);
    expect(forgetSemanticMemory(id)).toBe(true);
    expect(forgetSemanticMemory(id)).toBe(false);
    expect(search('beta', tokenizer)).toEqual([]);
    withMemoryDatabase((db) => {
      expect(() =>
        db.transaction(() => {
          remember('alpha');
          throw new Error('rollback');
        })(),
      ).toThrow('rollback');
      db.prepare('UPDATE semantic_memories SET deleted = 0 WHERE id = ?').run(
        hidden,
      );
    });
    expect(search('alpha', tokenizer).map((row) => row.id)).toEqual([hidden]);
    withMemoryDatabase((db) =>
      db.prepare('DELETE FROM semantic_memories WHERE id = ?').run(hidden),
    );
    expect(search('alpha', tokenizer)).toEqual([]);
    expect(
      withMemoryDatabase((db) =>
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${semanticMemoryIndexTable(tokenizer)}_docsize`,
          )
          .get(),
      ),
    ).toEqual({ count: 0 });
  });

  test('isolates session, confidence and all eligibility filters before ranking', () => {
    const kept = remember('alpha beta', {
      source: 'compaction',
      scope: 'durable',
      confidence: 0.8,
      createdAt: '2026-01-02',
    });
    remember('alpha alpha', {
      sessionId: 'session_b',
      source: 'compaction',
      scope: 'durable',
    });
    remember('alpha alpha', { confidence: 0.1 });
    remember('alpha alpha', { source: 'excluded' });
    remember('alpha alpha', { role: 'assistant' });
    remember('alpha alpha', { createdAt: '2025-01-01' });
    expect(
      search('alpha beta', tokenizer, {
        rerank: 'bm25',
        filter: {
          role: 'user',
          scope: 'durable',
          source: 'compaction',
          after: '2026-01-01',
          before: '2026-01-03',
          excludeSources: ['excluded'],
        },
      }).map((row) => row.id),
    ).toEqual([kept]);
    const before = search('alpha beta', tokenizer, { rerank: 'bm25' }).map(
      (row) => row.id,
    );
    for (let index = 0; index < 200; index += 1)
      remember('alpha alpha alpha', { sessionId: 'session_b' });
    expect(
      search('alpha beta', tokenizer, { rerank: 'bm25' }).map((row) => row.id),
    ).toEqual(before);
    const next = resetSessionState('session_a');
    expect(search('alpha', tokenizer, { sessionId: next.id })).toEqual([]);
    expect(
      search('alpha', tokenizer, { sessionId: 'session_b' }).length,
    ).toBeGreaterThan(0);
  });
});

test('backfills an existing database once and retains indexes across reopen', () => {
  const kept = remember('adoption microservice');
  remember('adoption microservice', { deleted: true });
  withMemoryDatabase((db) => {
    for (const tokenizer of tokenizers) {
      const table = semanticMemoryIndexTable(tokenizer);
      for (const suffix of ['ai', 'ad', 'au'])
        db.exec(`DROP TRIGGER ${table}_${suffix}`);
      db.exec(`DROP TABLE ${table}`);
    }
    db.pragma('user_version = 68');
    runMigrations(db, { quiet: true });
    const exec = vi.spyOn(db, 'exec');
    runMigrations(db, { quiet: true });
    expect(exec.mock.calls.flat().join('\n')).not.toContain(
      'INSERT INTO semantic_memory_fts',
    );
  });
  for (const tokenizer of tokenizers)
    expect(search('adoption', tokenizer).map((row) => row.id)).toEqual([kept]);
  closeDatabase();
  initDatabase({ quiet: true, dbPath });
  for (const tokenizer of tokenizers)
    expect(search('adoption', tokenizer).map((row) => row.id)).toEqual([kept]);
});

test('rolls back a failed index migration and retries without a partial backfill', () => {
  const id = remember('alpha beta');
  withMemoryDatabase((db) => {
    for (const tokenizer of tokenizers) {
      const table = semanticMemoryIndexTable(tokenizer);
      for (const suffix of ['ai', 'ad', 'au'])
        db.exec(`DROP TRIGGER ${table}_${suffix}`);
      db.exec(`DROP TABLE ${table}`);
    }
    db.pragma('user_version = 68');
    const originalExec = db.exec.bind(db);
    const exec = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql.includes('CREATE VIRTUAL TABLE semantic_memory_fts_porter'))
        throw new Error('migration failure');
      return originalExec(sql);
    });
    expect(() => runMigrations(db, { quiet: true })).toThrow(
      'migration failure',
    );
    expect(db.pragma('user_version', { simple: true })).toBe(68);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'semantic_memory_fts_%'",
        )
        .all(),
    ).toEqual([]);
    exec.mockRestore();
    runMigrations(db, { quiet: true });
  });
  for (const tokenizer of tokenizers)
    expect(search('alpha', tokenizer).map((row) => row.id)).toEqual([id]);
});

test('text ranking reads no candidate embedding blobs or index writes during recall', () => {
  const embedding = Array.from({ length: 2048 }, (_, index) => index % 5);
  for (let index = 0; index < 250; index += 1)
    remember(`alpha beta ${index}`, { embedding });
  remember('unrelated', { embedding });
  withMemoryDatabase((db) => {
    const prepare = vi.spyOn(db, 'prepare');
    const exec = vi.spyOn(db, 'exec');
    const before = db.prepare('SELECT total_changes() AS count').get();
    const result = search('alpha beta', 'porter', { limit: 3, rerank: 'bm25' });
    expect(result).toHaveLength(3);
    expect(result[0].embedding).toEqual(embedding);
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect(exec).not.toHaveBeenCalled();
    const statements = prepare.mock.calls.map(([sql]) => String(sql));
    const embeddingReads = statements.filter(
      (sql) =>
        /SELECT.*embedding/.test(sql) && !sql.includes('NULL AS embedding'),
    );
    expect(embeddingReads).toHaveLength(1);
    expect(
      statements.some((sql) => /SELECT \*\s+FROM semantic_memories/.test(sql)),
    ).toBe(false);
    expect(embeddingReads[0]).toContain('json_each');
    const retrievalSql = statements.find((sql) =>
      sql.includes('NULL AS embedding'),
    );
    const retrievalPlan = db
      .prepare(`EXPLAIN QUERY PLAN ${retrievalSql}`)
      .all('session_a', 0.2, '"alpha" OR "beta"', 100) as Array<{
      detail: string;
    }>;
    expect(
      retrievalPlan.some((row) => row.detail.includes('TEMP B-TREE')),
    ).toBe(false);
    const rankSql = statements.find((sql) => sql.includes('bm25('));
    const rankPlan = db
      .prepare(`EXPLAIN QUERY PLAN ${rankSql}`)
      .all('"alpha"', '[1,2,3]') as Array<{ detail: string }>;
    // An equality constraint on the FTS cursor restarts corpus-stat calculation
    // for each selected row. The scorer must scan one shared phrase cursor.
    expect(rankPlan.some((row) => row.detail.includes(':=M'))).toBe(false);

    expect(
      statements.filter((sql) => /CREATE|INSERT|DELETE|UPDATE/.test(sql)),
    ).toEqual([]);
  });
});
