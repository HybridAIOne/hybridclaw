import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-usage-cache-'));
  return path.join(dir, 'usage.db');
}

beforeEach(() => {
  process.env.HOME = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-usage-cache-home-'),
  );
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

test('usage aggregates carry prompt cache read and write tokens', async () => {
  const {
    getSessionUsageTotals,
    getUsageTotals,
    initDatabase,
    listUsageByAgent,
    listUsageByModel,
    listUsageBySession,
    listUsageDailyBreakdown,
    recordUsageEvent,
  } = await import('../src/memory/db.js');
  initDatabase({ quiet: true, dbPath: createTempDbPath() });

  recordUsageEvent({
    sessionId: 'session-a',
    agentId: 'alpha',
    model: 'openrouter/openai/gpt-5',
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 800,
    cacheWriteTokens: 150,
  });
  recordUsageEvent({
    sessionId: 'session-a',
    agentId: 'alpha',
    model: 'openrouter/openai/gpt-5',
    inputTokens: 500,
    outputTokens: 100,
    cacheReadTokens: 400,
  });
  recordUsageEvent({
    sessionId: 'session-b',
    agentId: 'beta',
    model: 'gpt-5-nano',
    inputTokens: 50,
    outputTokens: 10,
  });

  expect(getUsageTotals({ window: 'all' })).toMatchObject({
    total_input_tokens: 1_550,
    total_output_tokens: 310,
    total_cache_read_tokens: 1_200,
    total_cache_write_tokens: 150,
  });

  expect(getSessionUsageTotals('session-a')).toMatchObject({
    total_cache_read_tokens: 1_200,
    total_cache_write_tokens: 150,
  });

  const byModel = new Map(
    listUsageByModel({ window: 'all' }).map((row) => [row.model, row]),
  );
  expect(byModel.get('openrouter/openai/gpt-5')).toMatchObject({
    total_cache_read_tokens: 1_200,
    total_cache_write_tokens: 150,
  });
  expect(byModel.get('gpt-5-nano')).toMatchObject({
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
  });

  const byAgent = new Map(
    listUsageByAgent({ window: 'all' }).map((row) => [row.agent_id, row]),
  );
  expect(byAgent.get('alpha')).toMatchObject({
    total_cache_read_tokens: 1_200,
    total_cache_write_tokens: 150,
  });

  const bySession = new Map(
    listUsageBySession({ window: 'all' }).map((row) => [row.session_id, row]),
  );
  expect(bySession.get('session-b')).toMatchObject({
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
  });

  const daily = listUsageDailyBreakdown({ days: 1 });
  expect(daily).toHaveLength(1);
  expect(daily[0]).toMatchObject({
    total_cache_read_tokens: 1_200,
    total_cache_write_tokens: 150,
  });
});

test('buffered usage flush persists cache tokens and reports them in the batch audit', async () => {
  const dbPath = createTempDbPath();
  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.js'
  );
  initDatabase({ quiet: true, dbPath });
  const {
    _resetTokenUsageBufferForTests,
    enqueueTokenUsage,
    flushTokenUsageBuffer,
    readCacheTokenUsage,
    verifyTokenUsageBatchHash,
  } = await import('../src/usage/token-usage-buffer.js');
  _resetTokenUsageBufferForTests();

  expect(
    readCacheTokenUsage({
      apiCacheUsageAvailable: false,
      apiCacheReadTokens: 0,
      apiCacheWriteTokens: 0,
    }),
  ).toEqual({});
  const cacheFields = readCacheTokenUsage({
    apiCacheUsageAvailable: true,
    apiCacheReadTokens: 900,
    apiCacheWriteTokens: 75,
  });
  expect(cacheFields).toEqual({ cacheReadTokens: 900, cacheWriteTokens: 75 });

  enqueueTokenUsage({
    sessionId: 'sess-cache',
    agentId: 'agent-x',
    model: 'openrouter/openai/gpt-5',
    inputTokens: 1_000,
    outputTokens: 120,
    totalTokens: 1_120,
    ...cacheFields,
  });
  enqueueTokenUsage({
    sessionId: 'sess-cache',
    agentId: 'agent-x',
    model: 'openrouter/openai/gpt-5',
    inputTokens: 400,
    outputTokens: 80,
    totalTokens: 480,
    cacheReadTokens: 300,
  });
  await flushTokenUsageBuffer();

  const probe = new Database(dbPath, { readonly: true });
  try {
    const rows = probe
      .prepare(
        `SELECT input_tokens, cache_read_tokens, cache_write_tokens, batch_id
           FROM usage_events
          ORDER BY input_tokens ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      expect.objectContaining({
        input_tokens: 400,
        cache_read_tokens: 300,
        cache_write_tokens: 0,
      }),
      expect.objectContaining({
        input_tokens: 1_000,
        cache_read_tokens: 900,
        cache_write_tokens: 75,
      }),
    ]);
    expect(verifyTokenUsageBatchHash(String(rows[0]?.batch_id))).toMatchObject({
      ok: true,
      rowCount: 2,
    });
  } finally {
    probe.close();
  }

  const batchEvent = getRecentStructuredAuditForSession('sess-cache', 20).find(
    (entry) => entry.event_type === 'usage.batch_flushed',
  );
  expect(JSON.parse(String(batchEvent?.payload ?? '{}'))).toMatchObject({
    eventCount: 2,
    inputTokens: 1_400,
    cacheReadTokens: 1_200,
    cacheWriteTokens: 75,
  });
});

test('migrating an existing usage_events table adds cache token columns', async () => {
  const dbPath = createTempDbPath();
  const legacy = new Database(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        billable_unit TEXT,
        billable_quantity REAL NOT NULL DEFAULT 0.0,
        batch_id TEXT,
        batch_hash TEXT
      );
      INSERT INTO usage_events
        (id, session_id, agent_id, timestamp, model, input_tokens, output_tokens, total_tokens)
      VALUES ('legacy-1', 'session-legacy', 'alpha', '2026-09-01T00:00:00.000Z', 'gpt-5-mini', 10, 5, 15);
    `);
  } finally {
    legacy.close();
  }

  const { getUsageTotals, initDatabase, recordUsageEvent } = await import(
    '../src/memory/db.js'
  );
  initDatabase({ quiet: true, dbPath });
  recordUsageEvent({
    sessionId: 'session-new',
    agentId: 'alpha',
    model: 'gpt-5-mini',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 60,
    cacheWriteTokens: 5,
  });

  expect(getUsageTotals({ agentId: 'alpha', window: 'all' })).toMatchObject({
    total_input_tokens: 110,
    total_cache_read_tokens: 60,
    total_cache_write_tokens: 5,
  });
});

test('native Anthropic rows are stored with cache tokens folded into input', async () => {
  const dbPath = createTempDbPath();
  const { getUsageTotals, initDatabase, recordUsageEvent } = await import(
    '../src/memory/db.js'
  );
  initDatabase({ quiet: true, dbPath });
  const {
    _resetTokenUsageBufferForTests,
    enqueueTokenUsage,
    flushTokenUsageBuffer,
  } = await import('../src/usage/token-usage-buffer.js');
  _resetTokenUsageBufferForTests();

  recordUsageEvent({
    sessionId: 'session-anthropic',
    agentId: 'alpha',
    model: 'anthropic/claude-sonnet-5',
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 8_000,
    cacheWriteTokens: 500,
  });
  enqueueTokenUsage({
    sessionId: 'session-openai',
    agentId: 'alpha',
    model: 'openrouter/openai/gpt-5',
    inputTokens: 9_500,
    outputTokens: 100,
    cacheReadTokens: 8_000,
  });
  enqueueTokenUsage({
    sessionId: 'session-anthropic',
    agentId: 'alpha',
    model: 'anthropic/claude-sonnet-5',
    inputTokens: 2_000,
    outputTokens: 100,
    cacheReadTokens: 6_000,
    cacheWriteTokens: 1_000,
  });
  await flushTokenUsageBuffer();

  expect(getUsageTotals({ agentId: 'alpha', window: 'all' })).toMatchObject({
    total_input_tokens: 9_500 + 9_500 + 9_000,
    total_cache_read_tokens: 22_000,
    total_cache_write_tokens: 1_500,
  });
});
