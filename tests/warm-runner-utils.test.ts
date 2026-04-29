import { expect, test, vi } from 'vitest';
import { WarmProcessPool } from '../src/infra/warm-process-pool.js';
import {
  claimWarmEntry,
  createWarmSessionId,
  getCachedObservedMemoryBytes,
  type MemorySample,
  type WarmRunnerEntry,
} from '../src/infra/warm-runner-utils.js';

test('creates warm session IDs with sanitized agents and crypto entropy', () => {
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

  const first = createWarmSessionId('agent/a:b');
  const second = createWarmSessionId('agent/a:b');
  nowSpy.mockRestore();

  expect(first).toMatch(/^warm_agent_a_b_1700000000000_[0-9a-f]{12}$/);
  expect(second).toMatch(/^warm_agent_a_b_1700000000000_[0-9a-f]{12}$/);
  expect(first).not.toBe(second);
});

test('claims an existing warming entry instead of forcing another spawn', () => {
  const active = new Map<string, WarmRunnerEntry>();
  const warmPool = new WarmProcessPool<WarmRunnerEntry>({
    enabled: true,
    coldStartBudgetMs: 200,
    trafficWindowMs: 3_600_000,
    minIdlePerActiveAgent: 1,
    maxIdlePerAgent: 2,
    memoryPressureRssBytes: 0,
  });
  const warming: WarmRunnerEntry = {
    id: 'warm-1',
    sessionId: 'warm-1',
    agentId: 'agent_a',
    lastUsedAt: 100,
    warm: true,
    readyForInputAt: null,
    pendingColdStartProbeStartedAt: null,
    stderrHistory: [],
    isReady: () => false,
    stop: vi.fn(),
  };
  const logClaim = vi.fn();
  warmPool.add(warming);

  const claimed = claimWarmEntry({
    pool: active,
    warmPool,
    sessionId: 'request-1',
    agentId: 'agent_a',
    eligibility: {},
    logClaim,
  });

  expect(claimed).toBe(warming);
  expect(warming.sessionId).toBe('request-1');
  expect(warming.warm).toBe(false);
  expect(active.get('request-1')).toBe(warming);
  expect(warmPool.size).toBe(0);
  expect(logClaim).toHaveBeenCalledWith(warming);
});

test('uses the last known memory sample while refreshing a changed pool sample', async () => {
  let cache: MemorySample | null = {
    at: 1_700_000_000_000,
    key: 'old-pid',
    totalBytes: 512,
  };
  let refreshInFlight = false;
  const entry: WarmRunnerEntry = {
    id: 'warm-1',
    sessionId: 'warm-1',
    agentId: 'agent_a',
    lastUsedAt: 100,
    warm: true,
    readyForInputAt: 1,
    pendingColdStartProbeStartedAt: null,
    stderrHistory: [],
    stop: vi.fn(),
  };
  const refreshTotalBytes = vi.fn(async () => 1024);

  const observed = getCachedObservedMemoryBytes({
    cache,
    setCache: (sample) => {
      cache = sample;
    },
    isRefreshInFlight: () => refreshInFlight,
    setRefreshInFlight: (value) => {
      refreshInFlight = value;
    },
    activeEntries: [],
    warmEntries: [entry],
    memoryPressureEnabled: true,
    keyForEntry: (warmEntry) => warmEntry.id,
    refreshTotalBytes,
  });

  expect(observed).toBe(512);
  expect(refreshTotalBytes).toHaveBeenCalledWith(['warm-1']);
  await new Promise((resolve) => setImmediate(resolve));
  expect(cache).toMatchObject({
    key: 'warm-1',
    totalBytes: 1024,
  });
  expect(refreshInFlight).toBe(false);
});
