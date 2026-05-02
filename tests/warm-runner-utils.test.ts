import { expect, test, vi } from 'vitest';
import { WarmProcessPool } from '../src/infra/warm-process-pool.js';
import {
  claimWarmEntry,
  createWarmSessionId,
  enforceWarmPoolPressure,
  getCachedObservedMemoryBytes,
  type MemorySample,
  maintainWarmPool,
  observeAgentLifecycleLine,
  type WarmRunnerEntry,
} from '../src/infra/warm-runner-utils.js';

function makeWarmPool(config: {
  enabled?: boolean;
  minIdlePerActiveAgent?: number;
  maxIdlePerAgent?: number;
  memoryPressureRssBytes?: number;
}): WarmProcessPool<WarmRunnerEntry> {
  return new WarmProcessPool<WarmRunnerEntry>({
    enabled: config.enabled ?? true,
    coldStartBudgetMs: 200,
    trafficWindowMs: 3_600_000,
    minIdlePerActiveAgent: config.minIdlePerActiveAgent ?? 1,
    maxIdlePerAgent: config.maxIdlePerAgent ?? 2,
    memoryPressureRssBytes: config.memoryPressureRssBytes ?? 0,
  });
}

function makeEntry(
  id: string,
  agentId = 'agent_a',
  lastUsedAt = 100,
): WarmRunnerEntry {
  return {
    id,
    sessionId: id,
    agentId,
    lastUsedAt,
    warm: true,
    readyForInputAt: null,
    pendingColdStartProbeStartedAt: null,
    stderrHistory: [],
    stop: vi.fn(),
  };
}

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
  const warmPool = makeWarmPool({});
  const warming: WarmRunnerEntry = {
    ...makeEntry('warm-1'),
    isReady: () => false,
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

test('skips warm claim when request eligibility is not pool-safe', () => {
  const active = new Map<string, WarmRunnerEntry>();
  const warmPool = makeWarmPool({});
  const warm = makeEntry('warm-1');
  warmPool.add(warm);

  const claimed = claimWarmEntry({
    pool: active,
    warmPool,
    sessionId: 'request-1',
    agentId: 'agent_a',
    eligibility: { workspacePathOverride: '/custom/workspace' },
    logClaim: vi.fn(),
  });

  expect(claimed).toBeNull();
  expect(active.size).toBe(0);
  expect(warmPool.size).toBe(1);
});

test('observes readiness and records cold-start from agent request start', () => {
  const nowSpy = vi.spyOn(Date, 'now');
  const warmPool = makeWarmPool({});
  const entry = makeEntry('warm-1');
  const notify = vi.fn();
  entry.activity = { notify } as WarmRunnerEntry['activity'];
  entry.pendingColdStartProbeStartedAt = 1_000;

  nowSpy.mockReturnValue(1_050);
  expect(
    observeAgentLifecycleLine(
      entry,
      '[hybridclaw-agent] ready for input',
      warmPool,
    ),
  ).toBe(true);
  expect(entry.readyForInputAt).toBe(1_050);

  nowSpy.mockReturnValue(1_125);
  expect(
    observeAgentLifecycleLine(
      entry,
      '[hybridclaw-agent] agent request start',
      warmPool,
    ),
  ).toBe(true);
  expect(entry.pendingColdStartProbeStartedAt).toBeNull();
  expect(warmPool.coldStartP95Ms()).toBe(125);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(observeAgentLifecycleLine(entry, 'ordinary stderr', warmPool)).toBe(
    false,
  );

  nowSpy.mockRestore();
});

test('enforces memory pressure by stopping selected warm entries', () => {
  const active = new Map<string, WarmRunnerEntry>();
  const warmPool = makeWarmPool({ memoryPressureRssBytes: 1_000 });
  const old = makeEntry('old', 'agent_a', 100);
  const fresh = makeEntry('fresh', 'agent_a', 200);
  warmPool.add(old);
  warmPool.add(fresh);
  const stopEntries = vi.fn();
  const getObservedMemoryBytes = vi.fn(() => 1_500);

  enforceWarmPoolPressure({
    pool: active,
    warmPool,
    maxProcessCount: 10,
    getObservedMemoryBytes,
    stopEntries,
  });

  expect(getObservedMemoryBytes).toHaveBeenCalledOnce();
  expect(stopEntries).toHaveBeenCalledWith([old]);
  expect(warmPool.size).toBe(1);
  expect(warmPool.claim('agent_a')).toBe(fresh);
});

test('enforces process capacity without sampling memory', () => {
  const active = new Map<string, WarmRunnerEntry>([
    ['active-1', makeEntry('active-1', 'agent_a', 300)],
  ]);
  const warmPool = makeWarmPool({ memoryPressureRssBytes: 1_000 });
  const warm = makeEntry('warm-1', 'agent_a', 100);
  warmPool.add(warm);
  const stopEntries = vi.fn();
  const getObservedMemoryBytes = vi.fn(() => 0);

  enforceWarmPoolPressure({
    pool: active,
    warmPool,
    maxProcessCount: 1,
    getObservedMemoryBytes,
    stopEntries,
  });

  expect(getObservedMemoryBytes).not.toHaveBeenCalled();
  expect(stopEntries).toHaveBeenCalledWith([warm]);
});

test('maintains target warm entries for recent agent traffic', () => {
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  const active = new Map<string, WarmRunnerEntry>();
  const warmPool = makeWarmPool({
    minIdlePerActiveAgent: 1,
    maxIdlePerAgent: 2,
  });
  warmPool.recordRequest('agent_a', 30_000, 1_700_000_000_000);
  const spawned: string[] = [];

  maintainWarmPool({
    pool: active,
    warmPool,
    maxProcessCount: 3,
    agentId: 'agent_a',
    eligibility: {},
    stopEntries: vi.fn(),
    spawnWarm: (sessionId, agentId) => {
      spawned.push(`${agentId}:${sessionId}`);
      warmPool.add(makeEntry(sessionId, agentId));
    },
  });

  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatch(/^agent_a:warm_agent_a_/);
  expect(warmPool.idleCountForAgent('agent_a')).toBe(1);

  nowSpy.mockRestore();
});

test('does not maintain warm entries for ineligible requests', () => {
  const active = new Map<string, WarmRunnerEntry>();
  const warmPool = makeWarmPool({});
  warmPool.recordRequest('agent_a', 30_000);
  const spawnWarm = vi.fn();

  maintainWarmPool({
    pool: active,
    warmPool,
    maxProcessCount: 3,
    agentId: 'agent_a',
    eligibility: { bashProxy: { mode: 'docker-exec' } },
    stopEntries: vi.fn(),
    spawnWarm,
  });

  expect(spawnWarm).not.toHaveBeenCalled();
  expect(warmPool.size).toBe(0);
});

test('uses the last known memory sample while refreshing a changed pool sample', async () => {
  let cache: MemorySample | null = {
    at: 1_700_000_000_000,
    key: 'old-pid',
    totalBytes: 512,
  };
  let refreshInFlight = false;
  const entry = makeEntry('warm-1');
  entry.readyForInputAt = 1;
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
