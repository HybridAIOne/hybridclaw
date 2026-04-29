import { expect, test, vi } from 'vitest';
import {
  normalizeWarmProcessPoolConfig,
  WarmProcessPool,
  type WarmProcessPoolEntry,
} from '../src/infra/warm-process-pool.js';

function makeEntry(
  id: string,
  agentId: string,
  lastUsedAt: number,
): WarmProcessPoolEntry {
  return {
    id,
    agentId,
    lastUsedAt,
    stop: vi.fn(),
  };
}

test('sizes per-agent warm pools from recent traffic', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({
      trafficWindowMs: 60 * 60 * 1000,
      minIdlePerActiveAgent: 1,
      maxIdlePerAgent: 5,
    }),
  );
  const now = 10_000_000;

  for (let index = 0; index < 120; index += 1) {
    pool.recordRequest('agent_a', 30_000, now - index * 1_000);
  }

  expect(pool.targetIdleForAgent('agent_a', now)).toBe(1);

  for (let index = 0; index < 600; index += 1) {
    pool.recordRequest('agent_b', 60_000, now - index * 1_000);
  }

  expect(pool.targetIdleForAgent('agent_b', now)).toBe(5);
});

test('evicts least recently used warm entries under capacity pressure', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ maxIdlePerAgent: 3 }),
  );
  const old = makeEntry('old', 'agent_a', 100);
  const fresh = makeEntry('fresh', 'agent_b', 300);
  pool.add(old);
  pool.add(fresh);

  const evicted = pool.evictForPressure({
    totalProcessCount: 3,
    maxProcessCount: 2,
  });

  expect(evicted).toEqual([old]);
  expect(pool.claim('agent_b')).toBe(fresh);
});

test('does not claim a warm entry before the worker is ready', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ maxIdlePerAgent: 2 }),
  );
  let ready = false;
  const entry = {
    ...makeEntry('warming', 'agent_a', 100),
    isReady: () => ready,
  };

  pool.add(entry);

  expect(pool.claim('agent_a')).toBeNull();
  ready = true;
  expect(pool.claim('agent_a')).toBe(entry);
});

test('reports synthetic p95 cold-start budget compliance', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ coldStartBudgetMs: 200 }),
  );
  for (const sample of [75, 90, 100, 120, 150, 180, 190, 195, 198, 200]) {
    pool.recordColdStart(sample);
  }

  expect(pool.coldStartP95Ms()).toBe(200);
  expect(pool.isWithinColdStartBudget()).toBe(true);

  pool.recordColdStart(260);

  expect(pool.isWithinColdStartBudget()).toBe(false);
});
