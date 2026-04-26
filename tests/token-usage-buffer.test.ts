import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-usage-buffer-'));
}

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-usage-buf-'));
  return path.join(dir, 'usage.db');
}

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

describe.sequential('token usage buffer', () => {
  beforeEach(async () => {
    // Each test re-imports the buffer to get a clean module state.
  });

  test('enqueueTokenUsage drops events with missing session/agent', async () => {
    const dbPath = createTempDbPath();
    const { initDatabase } = await import('../src/memory/db.ts');
    initDatabase({ quiet: true, dbPath });
    const {
      _resetTokenUsageBufferForTests,
      enqueueTokenUsage,
      getTokenUsageBufferStats,
    } = await import('../src/usage/token-usage-buffer.ts');
    _resetTokenUsageBufferForTests();

    enqueueTokenUsage({
      sessionId: '',
      agentId: 'a',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
    });
    enqueueTokenUsage({
      sessionId: 's',
      agentId: '',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(getTokenUsageBufferStats().queueSize).toBe(0);
    expect(getTokenUsageBufferStats().totalEnqueued).toBe(0);
  });

  test('flushTokenUsageBuffer writes batched events into usage_events and emits batch audit', async () => {
    process.env.HOME = makeTempHome();
    const dbPath = createTempDbPath();
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    initDatabase({ quiet: true, dbPath });
    const {
      _resetTokenUsageBufferForTests,
      enqueueTokenUsage,
      flushTokenUsageBuffer,
      getTokenUsageBufferStats,
    } = await import('../src/usage/token-usage-buffer.ts');
    _resetTokenUsageBufferForTests();

    enqueueTokenUsage({
      sessionId: 'sess-1',
      agentId: 'agent-x',
      model: 'gpt-5-nano',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      toolCalls: 1,
      costUsd: 0.001,
    });
    enqueueTokenUsage({
      sessionId: 'sess-1',
      agentId: 'agent-x',
      model: 'gpt-5-nano',
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      toolCalls: 0,
      costUsd: 0.002,
    });
    enqueueTokenUsage({
      sessionId: 'sess-2',
      agentId: 'agent-y',
      model: 'gpt-5-mini',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      toolCalls: 3,
      costUsd: 0.01,
    });

    expect(getTokenUsageBufferStats().queueSize).toBe(3);
    expect(getTokenUsageBufferStats().totalEnqueued).toBe(3);

    await flushTokenUsageBuffer();

    const stats = getTokenUsageBufferStats();
    expect(stats.queueSize).toBe(0);
    expect(stats.totalFlushed).toBe(3);
    expect(stats.flushCount).toBe(1);
    expect(stats.lastFlushAt).not.toBeNull();
    expect(stats.lastError).toBeNull();

    // Verify rows landed in usage_events.
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe
        .prepare(
          `SELECT session_id, agent_id, model, input_tokens, output_tokens, total_tokens, tool_calls, cost_usd
             FROM usage_events
            ORDER BY input_tokens ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        session_id: 'sess-1',
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        tool_calls: 1,
      });
      expect(rows[2]).toMatchObject({
        session_id: 'sess-2',
        agent_id: 'agent-y',
        input_tokens: 100,
      });
    } finally {
      probe.close();
    }

    // Each session should have received a usage.batch_flushed audit event.
    const sess1Events = getRecentStructuredAuditForSession('sess-1', 20);
    const sess2Events = getRecentStructuredAuditForSession('sess-2', 20);

    const sess1Batch = sess1Events.find(
      (e) => e.event_type === 'usage.batch_flushed',
    );
    const sess2Batch = sess2Events.find(
      (e) => e.event_type === 'usage.batch_flushed',
    );

    expect(sess1Batch).toBeDefined();
    expect(sess2Batch).toBeDefined();

    const sess1Payload = JSON.parse(String(sess1Batch?.payload ?? '{}')) as {
      eventCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      toolCalls: number;
      costUsd: number;
      batchHash: string;
      models: string[];
      agents: string[];
    };
    expect(sess1Payload.eventCount).toBe(2);
    expect(sess1Payload.inputTokens).toBe(30);
    expect(sess1Payload.outputTokens).toBe(15);
    expect(sess1Payload.totalTokens).toBe(45);
    expect(sess1Payload.toolCalls).toBe(1);
    expect(sess1Payload.costUsd).toBeCloseTo(0.003, 6);
    expect(sess1Payload.batchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sess1Payload.models).toEqual(['gpt-5-nano']);
    expect(sess1Payload.agents).toEqual(['agent-x']);

    const sess2Payload = JSON.parse(String(sess2Batch?.payload ?? '{}')) as {
      eventCount: number;
      models: string[];
    };
    expect(sess2Payload.eventCount).toBe(1);
    expect(sess2Payload.models).toEqual(['gpt-5-mini']);
  });

  test('opportunistic flush triggers when batch size threshold is reached', async () => {
    process.env.HOME = makeTempHome();
    const dbPath = createTempDbPath();
    const { initDatabase } = await import('../src/memory/db.ts');
    initDatabase({ quiet: true, dbPath });
    const {
      _resetTokenUsageBufferForTests,
      enqueueTokenUsage,
      getTokenUsageBufferStats,
      startTokenUsageBuffer,
      stopTokenUsageBuffer,
    } = await import('../src/usage/token-usage-buffer.ts');
    _resetTokenUsageBufferForTests();
    // Large interval (don't fire) + small batch size to force opportunistic flush.
    startTokenUsageBuffer({
      flushIntervalMs: 60_000,
      maxBatchSize: 3,
      maxQueueSize: 100,
    });

    for (let i = 0; i < 3; i++) {
      enqueueTokenUsage({
        sessionId: 'sess-burst',
        agentId: 'agent-burst',
        model: 'gpt-5-nano',
        inputTokens: 1,
        outputTokens: 1,
      });
    }

    // Wait for the opportunistic flush microtask.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const stats = getTokenUsageBufferStats();
    expect(stats.totalEnqueued).toBe(3);
    expect(stats.totalFlushed).toBeGreaterThanOrEqual(3);
    expect(stats.queueSize).toBe(0);

    await stopTokenUsageBuffer();
  });

  test('maxQueueSize bound drops events when full', async () => {
    process.env.HOME = makeTempHome();
    const dbPath = createTempDbPath();
    const { initDatabase } = await import('../src/memory/db.ts');
    initDatabase({ quiet: true, dbPath });
    const {
      _resetTokenUsageBufferForTests,
      enqueueTokenUsage,
      getTokenUsageBufferStats,
      startTokenUsageBuffer,
      stopTokenUsageBuffer,
    } = await import('../src/usage/token-usage-buffer.ts');
    _resetTokenUsageBufferForTests();
    startTokenUsageBuffer({
      flushIntervalMs: 60_000,
      maxBatchSize: 100,
      maxQueueSize: 2,
    });

    for (let i = 0; i < 5; i++) {
      enqueueTokenUsage({
        sessionId: 'sess-overflow',
        agentId: 'agent-overflow',
        model: 'gpt-5-nano',
        inputTokens: 1,
        outputTokens: 1,
      });
    }

    const stats = getTokenUsageBufferStats();
    expect(stats.totalEnqueued).toBe(2);
    expect(stats.totalDropped).toBe(3);
    expect(stats.queueSize).toBe(2);

    await stopTokenUsageBuffer();
  });

  test('stopTokenUsageBuffer drains pending events', async () => {
    process.env.HOME = makeTempHome();
    const dbPath = createTempDbPath();
    const { initDatabase } = await import('../src/memory/db.ts');
    initDatabase({ quiet: true, dbPath });
    const {
      _resetTokenUsageBufferForTests,
      enqueueTokenUsage,
      getTokenUsageBufferStats,
      startTokenUsageBuffer,
      stopTokenUsageBuffer,
    } = await import('../src/usage/token-usage-buffer.ts');
    _resetTokenUsageBufferForTests();
    startTokenUsageBuffer({
      flushIntervalMs: 60_000,
      maxBatchSize: 100,
      maxQueueSize: 100,
    });

    enqueueTokenUsage({
      sessionId: 'sess-drain',
      agentId: 'agent-drain',
      model: 'gpt-5-nano',
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(getTokenUsageBufferStats().queueSize).toBe(1);

    await stopTokenUsageBuffer();

    const stats = getTokenUsageBufferStats();
    expect(stats.queueSize).toBe(0);
    expect(stats.totalFlushed).toBe(1);
    expect(stats.started).toBe(false);

    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(dbPath, { readonly: true });
    try {
      const row = probe
        .prepare(`SELECT input_tokens, output_tokens FROM usage_events`)
        .get() as { input_tokens: number; output_tokens: number };
      expect(row).toBeDefined();
      expect(row.input_tokens).toBe(7);
      expect(row.output_tokens).toBe(3);
    } finally {
      probe.close();
    }
  });

  test('startTokenUsageBuffer is idempotent', async () => {
    const dbPath = createTempDbPath();
    const { initDatabase } = await import('../src/memory/db.ts');
    initDatabase({ quiet: true, dbPath });
    const {
      _resetTokenUsageBufferForTests,
      getTokenUsageBufferStats,
      startTokenUsageBuffer,
      stopTokenUsageBuffer,
    } = await import('../src/usage/token-usage-buffer.ts');
    _resetTokenUsageBufferForTests();
    startTokenUsageBuffer({
      flushIntervalMs: 60_000,
      maxBatchSize: 7,
      maxQueueSize: 99,
    });
    // Second start should be a no-op (settings unchanged).
    startTokenUsageBuffer({
      flushIntervalMs: 1_000,
      maxBatchSize: 1,
      maxQueueSize: 1,
    });

    const stats = getTokenUsageBufferStats();
    expect(stats.maxBatchSize).toBe(7);
    expect(stats.maxQueueSize).toBe(99);
    expect(stats.flushIntervalMs).toBe(60_000);

    await stopTokenUsageBuffer();
  });
});
