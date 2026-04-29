export interface WarmProcessPoolConfig {
  enabled: boolean;
  coldStartBudgetMs: number;
  trafficWindowMs: number;
  minIdlePerActiveAgent: number;
  maxIdlePerAgent: number;
  memoryPressureRssBytes: number;
}

export type WarmProcessPoolConfigInput = Partial<WarmProcessPoolConfig> & {
  memoryPressureRssMb?: number;
};

export interface WarmProcessPoolEntry {
  id: string;
  agentId: string;
  lastUsedAt: number;
  isReady?: () => boolean;
  stop(): void;
}

interface TrafficSample {
  at: number;
  durationMs: number;
}

const DEFAULT_TRAFFIC_WINDOW_MS = 60 * 60 * 1000;

export function normalizeWarmProcessPoolConfig(
  raw: WarmProcessPoolConfigInput = {},
): WarmProcessPoolConfig {
  const coldStartBudgetMs = normalizeInteger(raw.coldStartBudgetMs, 200, 1);
  const trafficWindowMs = normalizeInteger(
    raw.trafficWindowMs,
    DEFAULT_TRAFFIC_WINDOW_MS,
    60_000,
  );
  const minIdlePerActiveAgent = normalizeInteger(
    raw.minIdlePerActiveAgent,
    1,
    0,
  );
  const maxIdlePerAgent = normalizeInteger(raw.maxIdlePerAgent, 2, 0);
  const memoryPressureRssBytes =
    raw.memoryPressureRssBytes ??
    (raw.memoryPressureRssMb == null
      ? undefined
      : raw.memoryPressureRssMb * 1024 * 1024);
  return {
    enabled: raw.enabled !== false,
    coldStartBudgetMs,
    trafficWindowMs,
    minIdlePerActiveAgent: Math.min(minIdlePerActiveAgent, maxIdlePerAgent),
    maxIdlePerAgent,
    memoryPressureRssBytes: normalizeInteger(memoryPressureRssBytes, 0, 0),
  };
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  min: number,
): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.floor(numeric));
}

export class WarmProcessPool<T extends WarmProcessPoolEntry> {
  private readonly entries = new Map<string, T>();
  private readonly traffic = new Map<string, TrafficSample[]>();
  private readonly coldStartSamples: number[] = [];
  private readonly sortedColdStartSamples: number[] = [];
  private cachedColdStartP95Ms: number | null = null;

  constructor(private config: WarmProcessPoolConfig) {}

  get enabled(): boolean {
    return this.config.enabled && this.config.maxIdlePerAgent > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get memoryPressureEnabled(): boolean {
    return this.config.memoryPressureRssBytes > 0;
  }

  values(): T[] {
    return Array.from(this.entries.values());
  }

  reconfigure(config: WarmProcessPoolConfig): T[] {
    this.config = config;
    if (!this.enabled) return this.clear();

    const evicted: T[] = [];
    const agentIds = new Set<string>();
    for (const entry of this.entries.values()) agentIds.add(entry.agentId);
    for (const agentId of agentIds) {
      evicted.push(...this.trimAgent(agentId, this.config.maxIdlePerAgent));
    }
    return evicted;
  }

  add(entry: T): void {
    if (!this.enabled) {
      entry.stop();
      return;
    }
    this.entries.set(entry.id, entry);
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  claim(agentId: string, now = Date.now()): T | null {
    let claimed: T | null = null;
    for (const entry of this.entries.values()) {
      if (entry.agentId !== agentId) continue;
      if (entry.isReady && !entry.isReady()) continue;
      if (!claimed || entry.lastUsedAt > claimed.lastUsedAt) claimed = entry;
    }
    if (!claimed) return null;
    this.entries.delete(claimed.id);
    claimed.lastUsedAt = now;
    return claimed;
  }

  recordRequest(agentId: string, durationMs: number, now = Date.now()): void {
    if (!agentId) return;
    const samples = this.prune(agentId, now);
    samples.push({ at: now, durationMs: Math.max(1, Math.floor(durationMs)) });
    this.traffic.set(agentId, samples);
  }

  recordColdStart(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const sample = Math.floor(durationMs);
    this.coldStartSamples.push(sample);
    insertSorted(this.sortedColdStartSamples, sample);
    if (this.coldStartSamples.length > 500) {
      const dropped = this.coldStartSamples.splice(
        0,
        this.coldStartSamples.length - 500,
      );
      for (const value of dropped)
        removeSortedValue(this.sortedColdStartSamples, value);
    }
    this.cachedColdStartP95Ms = percentileSorted(
      this.sortedColdStartSamples,
      0.95,
    );
  }

  coldStartP95Ms(): number | null {
    return this.cachedColdStartP95Ms;
  }

  isWithinColdStartBudget(): boolean {
    const p95 = this.coldStartP95Ms();
    return p95 === null || p95 <= this.config.coldStartBudgetMs;
  }

  targetIdleForAgent(agentId: string, now = Date.now()): number {
    if (!this.enabled) return 0;
    const samples = this.prune(agentId, now);
    if (samples.length === 0) return 0;

    const requestsPerMinute =
      samples.length / (this.config.trafficWindowMs / 60_000);
    const avgExecutionSeconds =
      samples.reduce((sum, sample) => sum + sample.durationMs, 0) /
      samples.length /
      1000;
    const adaptive = Math.ceil((requestsPerMinute / 60) * avgExecutionSeconds);
    return Math.min(
      this.config.maxIdlePerAgent,
      Math.max(this.config.minIdlePerActiveAgent, adaptive),
    );
  }

  idleCountForAgent(agentId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.agentId === agentId) count += 1;
    }
    return count;
  }

  trimAgent(agentId: string, targetSize: number): T[] {
    const candidates = this.values()
      .filter((entry) => entry.agentId === agentId)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const evicted: T[] = [];
    while (candidates.length > targetSize) {
      const entry = candidates.shift();
      if (!entry) break;
      if (this.entries.delete(entry.id)) evicted.push(entry);
    }
    return evicted;
  }

  evictForPressure(params: {
    totalProcessCount: number;
    maxProcessCount: number;
    rssBytes?: number;
  }): T[] {
    const memoryPressure =
      this.config.memoryPressureRssBytes > 0 &&
      (params.rssBytes || 0) >= this.config.memoryPressureRssBytes;
    const overCapacity = params.totalProcessCount > params.maxProcessCount;
    if (!memoryPressure && !overCapacity) return [];

    const targetEvictions = Math.max(
      params.totalProcessCount - params.maxProcessCount,
      memoryPressure ? 1 : 0,
    );
    const evicted: T[] = [];
    const candidates = this.values().sort(
      (left, right) => left.lastUsedAt - right.lastUsedAt,
    );
    for (const entry of candidates) {
      if (evicted.length >= targetEvictions) break;
      if (!this.entries.delete(entry.id)) continue;
      evicted.push(entry);
    }
    return evicted;
  }

  clear(): T[] {
    const entries = this.values();
    this.entries.clear();
    return entries;
  }

  private prune(agentId: string, now: number): TrafficSample[] {
    const cutoff = now - this.config.trafficWindowMs;
    const samples = (this.traffic.get(agentId) || []).filter(
      (sample) => sample.at >= cutoff,
    );
    if (samples.length > 0) this.traffic.set(agentId, samples);
    else this.traffic.delete(agentId);
    return samples;
  }
}

function insertSorted(values: number[], value: number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((values[mid] ?? 0) <= value) low = mid + 1;
    else high = mid;
  }
  values.splice(low, 0, value);
}

function removeSortedValue(values: number[], value: number): void {
  const index = values.indexOf(value);
  if (index !== -1) values.splice(index, 1);
}

function percentileSorted(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? 0;
}
