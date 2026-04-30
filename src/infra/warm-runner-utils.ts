import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ExecutorSessionHealthSnapshot } from '../agent/executor-types.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { ContainerInput, ContainerOutput } from '../types/container.js';
import {
  cleanupHealthIpc,
  ensureSessionDirs,
  readHealthOutput,
  writeHealthInput,
} from './ipc.js';
import {
  normalizeWarmProcessPoolConfig,
  type WarmProcessPool,
  type WarmProcessPoolEntry,
} from './warm-process-pool.js';

export const AGENT_OUTPUT_TIMEOUT_PREFIX =
  'Timeout waiting for agent output after ';
export const AGENT_READY_FOR_INPUT_LINE = '[hybridclaw-agent] ready for input';
export const AGENT_REQUEST_START_LINE =
  '[hybridclaw-agent] agent request start';
export const IDLE_TIMEOUT_MS = 300_000;
export const STDERR_HISTORY_LIMIT = 20;
export const MEMORY_SAMPLE_TTL_MS = 5_000;

export interface WarmRunnerEntry extends WarmProcessPoolEntry {
  sessionId: string;
  warm: boolean;
  readyForInputAt: number | null;
  pendingColdStartProbeStartedAt: number | null;
  stderrHistory: string[];
  activity?: import('./ipc.js').ActivityTracker;
}

export type WarmRunnerMode = 'container' | 'host';

export interface WarmRunnerHealthEntry extends WarmRunnerEntry {
  process: Pick<ChildProcess, 'exitCode' | 'killed' | 'pid'>;
  ipcSessionId: string;
  agentId: string;
  startedAt: number;
  lastUsedAt: number;
  terminalError: string | null;
  healthProbe?: Promise<ExecutorSessionHealthSnapshot>;
}

export interface WarmPoolEligibilityParams {
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  bashProxy?: unknown;
}

export interface MemorySample {
  at: number;
  key: string;
  totalBytes: number;
}

export function normalizeWarmProcessPoolRuntimeConfig(
  config: RuntimeConfig['container']['warmPool'],
): ReturnType<typeof normalizeWarmProcessPoolConfig> {
  return normalizeWarmProcessPoolConfig(config);
}

export function rememberStderrLine(entry: WarmRunnerEntry, line: string): void {
  entry.stderrHistory.push(line);
  if (entry.stderrHistory.length > STDERR_HISTORY_LIMIT) {
    entry.stderrHistory.splice(
      0,
      entry.stderrHistory.length - STDERR_HISTORY_LIMIT,
    );
  }
}

export function summarizeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (typeof code === 'number') return `exit code ${code}`;
  if (signal) return `signal ${signal}`;
  return 'unknown exit status';
}

export function formatWarmRunnerTerminalError(
  entry: Pick<WarmRunnerHealthEntry, 'process' | 'stderrHistory'>,
  runtimeLabel: string,
  params?: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
  },
): string {
  const stderrText = entry.stderrHistory.join('\n');
  const missingPackageMatch = stderrText.match(
    /Cannot find package '([^']+)' imported from /,
  );
  const status = summarizeExit(
    params?.code ?? entry.process.exitCode,
    params?.signal ?? null,
  );

  if (missingPackageMatch) {
    return [
      `${runtimeLabel} exited before producing output (${status}).`,
      `Missing runtime dependency: ${missingPackageMatch[1]}.`,
      'Reinstall HybridClaw. If you are running from a source checkout, run `npm run setup` first.',
    ].join('\n');
  }

  const detail = entry.stderrHistory
    .slice(-4)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return detail
    ? `${runtimeLabel} exited before producing output (${status}). ${detail}`
    : `${runtimeLabel} exited before producing output (${status}). Check the gateway log for stderr details.`;
}

function buildRunnerHealthSnapshot(
  mode: WarmRunnerMode,
  entry: WarmRunnerHealthEntry,
  params?: {
    responsive?: boolean;
    healthError?: string | null;
  },
): ExecutorSessionHealthSnapshot {
  const processAlive = !entry.process.killed && entry.process.exitCode === null;
  return {
    mode,
    sessionId: entry.sessionId,
    agentId: entry.agentId,
    pid: typeof entry.process.pid === 'number' ? entry.process.pid : null,
    responsive:
      params?.responsive ??
      (processAlive && !entry.terminalError && Boolean(entry.activity)),
    startedAt: entry.startedAt,
    lastUsedAt: entry.lastUsedAt,
    readyForInputAt: entry.readyForInputAt,
    busy: Boolean(entry.activity),
    terminalError: entry.terminalError,
    healthError: params?.healthError ?? null,
  };
}

async function pingIdleRunnerEntry(
  mode: WarmRunnerMode,
  entry: WarmRunnerHealthEntry,
): Promise<ExecutorSessionHealthSnapshot> {
  const nonce = randomUUID();
  const input: ContainerInput = {
    healthCheck: { nonce },
    sessionId: entry.sessionId,
    messages: [],
    chatbotId: '',
    enableRag: false,
    apiKey: '',
    baseUrl: '',
    model: '',
    channelId: '',
  };

  try {
    cleanupHealthIpc(entry.ipcSessionId);
    ensureSessionDirs(entry.ipcSessionId);
    writeHealthInput(entry.ipcSessionId, input);
    const output = await readHealthOutput(entry.ipcSessionId, 1_000, {
      terminalError: () => entry.terminalError,
    });
    const expected = `HEALTH_OK:${nonce}`;
    const responsive =
      output.status === 'success' && output.result === expected;
    return buildRunnerHealthSnapshot(mode, entry, {
      responsive,
      healthError: responsive
        ? null
        : output.error ||
          `unexpected health response: ${output.result || output.status}`,
    });
  } catch (error) {
    return buildRunnerHealthSnapshot(mode, entry, {
      responsive: false,
      healthError: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function pingWarmRunnerHealthEntry(
  mode: WarmRunnerMode,
  entry: WarmRunnerHealthEntry,
): Promise<ExecutorSessionHealthSnapshot> {
  if (entry.healthProbe) return entry.healthProbe;
  if (entry.activity) return buildRunnerHealthSnapshot(mode, entry);
  if (
    entry.process.killed ||
    entry.process.exitCode !== null ||
    entry.terminalError
  ) {
    return buildRunnerHealthSnapshot(mode, entry, { responsive: false });
  }

  const probe = pingIdleRunnerEntry(mode, entry);
  entry.healthProbe = probe;
  try {
    return await probe;
  } finally {
    if (entry.healthProbe === probe) {
      entry.healthProbe = undefined;
    }
  }
}

export function observeAgentLifecycleLine<T extends WarmRunnerEntry>(
  entry: T,
  line: string,
  warmPool: WarmProcessPool<T>,
): boolean {
  if (line === AGENT_READY_FOR_INPUT_LINE) {
    entry.readyForInputAt = Date.now();
    entry.activity?.notify();
    return true;
  }
  if (line === AGENT_REQUEST_START_LINE) {
    const startedAt = entry.pendingColdStartProbeStartedAt;
    if (startedAt != null) {
      warmPool.recordColdStart(Date.now() - startedAt);
      entry.pendingColdStartProbeStartedAt = null;
    }
    entry.activity?.notify();
    return true;
  }
  return false;
}

export function canUseWarmPool(
  warmPool: WarmProcessPool<WarmRunnerEntry>,
  params: WarmPoolEligibilityParams,
): boolean {
  return (
    warmPool.enabled &&
    !params.workspacePathOverride?.trim() &&
    !params.workspaceDisplayRootOverride?.trim() &&
    !params.bashProxy
  );
}

export function createWarmSessionId(agentId: string): string {
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `warm_${safeAgent}_${Date.now()}_${randomBytes(6).toString('hex')}`;
}

export function isTimedOutAgentOutput(output: ContainerOutput): boolean {
  return (
    output.status === 'error' &&
    typeof output.error === 'string' &&
    output.error.startsWith(AGENT_OUTPUT_TIMEOUT_PREFIX)
  );
}

export function getTotalWarmProcessCount<T extends WarmRunnerEntry>(
  pool: Map<string, T>,
  warmPool: WarmProcessPool<T>,
): number {
  return pool.size + warmPool.size;
}

export function removeWarmPoolEntry<T extends WarmRunnerEntry>(
  pool: Map<string, T>,
  warmPool: WarmProcessPool<T>,
  entry: T,
): void {
  warmPool.delete(entry.id);
  for (const [sessionId, active] of pool) {
    if (active === entry) pool.delete(sessionId);
  }
}

export function stopWarmEntries<T extends WarmRunnerEntry>(
  entries: T[],
  params: {
    log: (entry: T) => void;
    stop: (entry: T) => void;
  },
): void {
  for (const entry of entries) {
    params.log(entry);
    params.stop(entry);
  }
}

export function enforceWarmPoolPressure<T extends WarmRunnerEntry>(params: {
  pool: Map<string, T>;
  warmPool: WarmProcessPool<T>;
  maxProcessCount: number;
  getObservedMemoryBytes: () => number;
  stopEntries: (entries: T[]) => void;
}): void {
  if (params.warmPool.size === 0) return;
  const totalProcessCount = getTotalWarmProcessCount(
    params.pool,
    params.warmPool,
  );
  const overCapacity = totalProcessCount > params.maxProcessCount;
  if (!overCapacity && !params.warmPool.memoryPressureEnabled) return;
  params.stopEntries(
    params.warmPool.evictForPressure({
      totalProcessCount,
      maxProcessCount: params.maxProcessCount,
      rssBytes: overCapacity ? undefined : params.getObservedMemoryBytes(),
    }),
  );
}

export function getCachedObservedMemoryBytes<
  T extends WarmRunnerEntry,
>(params: {
  cache: MemorySample | null;
  setCache: (sample: MemorySample) => void;
  isRefreshInFlight: () => boolean;
  setRefreshInFlight: (value: boolean) => void;
  activeEntries: T[];
  warmEntries: T[];
  memoryPressureEnabled: boolean;
  keyForEntry: (entry: T) => string | null;
  refreshTotalBytes: (keys: string[]) => Promise<number>;
}): number {
  if (params.warmEntries.length === 0 || !params.memoryPressureEnabled)
    return 0;
  const keys = [...params.activeEntries, ...params.warmEntries]
    .map((entry) => params.keyForEntry(entry))
    .filter((key): key is string => Boolean(key));
  const sampleKey = Array.from(new Set(keys)).sort().join('\n');
  const now = Date.now();
  const currentCache = params.cache?.key === sampleKey ? params.cache : null;
  if (currentCache && now - currentCache.at < MEMORY_SAMPLE_TTL_MS) {
    return currentCache.totalBytes;
  }

  if (!params.isRefreshInFlight()) {
    params.setRefreshInFlight(true);
    params
      .refreshTotalBytes(keys)
      .then((totalBytes) => {
        params.setCache({ at: Date.now(), key: sampleKey, totalBytes });
      })
      .catch(() => {
        // Sampling is best-effort; over-capacity eviction does not depend on it.
      })
      .finally(() => {
        params.setRefreshInFlight(false);
      });
  }
  return currentCache?.totalBytes ?? params.cache?.totalBytes ?? 0;
}

export function claimWarmEntry<T extends WarmRunnerEntry>(params: {
  pool: Map<string, T>;
  warmPool: WarmProcessPool<T>;
  sessionId: string;
  agentId: string;
  eligibility: WarmPoolEligibilityParams;
  logClaim: (entry: T) => void;
}): T | null {
  if (!canUseWarmPool(params.warmPool, params.eligibility)) return null;
  const entry = params.warmPool.claim(params.agentId);
  if (!entry) return null;
  entry.sessionId = params.sessionId;
  entry.warm = false;
  entry.lastUsedAt = Date.now();
  params.pool.set(params.sessionId, entry);
  params.logClaim(entry);
  return entry;
}

export function maintainWarmPool<T extends WarmRunnerEntry>(params: {
  pool: Map<string, T>;
  warmPool: WarmProcessPool<T>;
  maxProcessCount: number;
  agentId: string;
  eligibility: WarmPoolEligibilityParams;
  stopEntries: (entries: T[]) => void;
  spawnWarm: (sessionId: string, agentId: string) => void;
}): void {
  if (!canUseWarmPool(params.warmPool, params.eligibility)) return;
  const targetSize = params.warmPool.targetIdleForAgent(params.agentId);
  params.stopEntries(params.warmPool.trimAgent(params.agentId, targetSize));
  while (
    params.warmPool.idleCountForAgent(params.agentId) < targetSize &&
    getTotalWarmProcessCount(params.pool, params.warmPool) <
      params.maxProcessCount
  ) {
    params.spawnWarm(createWarmSessionId(params.agentId), params.agentId);
  }
}
