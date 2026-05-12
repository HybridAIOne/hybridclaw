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

test('normalizes runtime memory pressure from MB to bytes', () => {
  expect(
    normalizeWarmProcessPoolConfig({ memoryPressureRssMb: 2 })
      .memoryPressureRssBytes,
  ).toBe(2 * 1024 * 1024);
});

test('normalizes min idle workers to the configured max idle workers', () => {
  expect(
    normalizeWarmProcessPoolConfig({
      minIdlePerActiveAgent: 5,
      maxIdlePerAgent: 2,
    }).minIdlePerActiveAgent,
  ).toBe(2);
});

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

test('evicts the minimum viable warm entries under memory pressure', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({
      maxIdlePerAgent: 3,
      memoryPressureRssMb: 1,
    }),
  );
  const old = makeEntry('old', 'agent_a', 100);
  const middle = makeEntry('middle', 'agent_a', 200);
  const fresh = makeEntry('fresh', 'agent_a', 300);
  pool.add(old);
  pool.add(middle);
  pool.add(fresh);

  const evicted = pool.evictForPressure({
    totalProcessCount: 3,
    maxProcessCount: 10,
    rssBytes: 1024 * 1024,
  });

  expect(evicted).toEqual([old]);
  expect(pool.idleCountForAgent('agent_a')).toBe(2);
});

test('claims the freshest ready warm entry before pressure evicts older entries', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ maxIdlePerAgent: 3 }),
  );
  const old = makeEntry('old', 'agent_a', 100);
  const middle = makeEntry('middle', 'agent_a', 200);
  const fresh = makeEntry('fresh', 'agent_a', 300);
  pool.add(old);
  pool.add(middle);
  pool.add(fresh);

  expect(pool.claim('agent_a', 400)).toBe(fresh);
  expect(fresh.lastUsedAt).toBe(400);

  const evicted = pool.evictForPressure({
    totalProcessCount: 3,
    maxProcessCount: 2,
  });

  expect(evicted).toEqual([old]);
  expect(pool.claim('agent_a')).toBe(middle);
});

test('applies warm pool config changes to existing entries', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ enabled: true, maxIdlePerAgent: 3 }),
  );
  const old = makeEntry('old', 'agent_a', 100);
  const middle = makeEntry('middle', 'agent_a', 200);
  const fresh = makeEntry('fresh', 'agent_a', 300);
  pool.add(old);
  pool.add(middle);
  pool.add(fresh);

  expect(
    pool.reconfigure(
      normalizeWarmProcessPoolConfig({ enabled: true, maxIdlePerAgent: 1 }),
    ),
  ).toEqual([old, middle]);
  expect(pool.idleCountForAgent('agent_a')).toBe(1);

  expect(
    pool.reconfigure(
      normalizeWarmProcessPoolConfig({ enabled: false, maxIdlePerAgent: 1 }),
    ),
  ).toEqual([fresh]);
  expect(pool.size).toBe(0);
});

test('applies cold-start budget config changes without recreating samples', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ coldStartBudgetMs: 200 }),
  );
  pool.recordColdStart(300);

  expect(pool.isWithinColdStartBudget()).toBe(false);

  pool.reconfigure(normalizeWarmProcessPoolConfig({ coldStartBudgetMs: 400 }));

  expect(pool.coldStartP95Ms()).toBe(300);
  expect(pool.isWithinColdStartBudget()).toBe(true);
});

test('prefers ready warm entries but falls back to warming entries', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ maxIdlePerAgent: 2 }),
  );
  const warming = {
    ...makeEntry('warming', 'agent_a', 100),
    isReady: () => false,
  };
  const ready = {
    ...makeEntry('ready', 'agent_a', 90),
    isReady: () => true,
  };

  pool.add(warming);
  pool.add(ready);

  expect(pool.claim('agent_a')).toBe(ready);
  expect(pool.claim('agent_a')).toBe(warming);
});

test('claims warming entries instead of forcing redundant spawns', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ maxIdlePerAgent: 2 }),
  );
  const warming = {
    ...makeEntry('warming', 'agent_a', 100),
    isReady: () => false,
  };

  pool.add(warming);

  expect(pool.claim('agent_a')).toBe(warming);
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

test('keeps cold-start p95 cached while rolling old samples out', () => {
  const pool = new WarmProcessPool(
    normalizeWarmProcessPoolConfig({ coldStartBudgetMs: 200 }),
  );

  pool.recordColdStart(10_000);
  for (let index = 0; index < 500; index += 1) {
    pool.recordColdStart(100);
  }

  expect(pool.coldStartP95Ms()).toBe(100);
  expect(pool.isWithinColdStartBudget()).toBe(true);
});
