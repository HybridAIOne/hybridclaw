/**
 * Worker runner — the one pool, capacity and request lifecycle for agent
 * workers, in both sandbox modes.
 *
 * A session owns at most one live worker and runs one request at a time; spare
 * workers reach a session only through the warm pool, and a stopped worker is
 * never reused. Each request's output is redacted and its paths mapped back
 * into the workspace before it leaves here.
 *
 * NOT the sandbox: how a worker starts, stops, reports memory and sees host
 * paths comes from its `WorkerStrategy` (container-runner, host-runner). This
 * module builds no docker args or child env, and holds only live handles and
 * caches that die with the gateway.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveExecutionDeadline } from '@hybridclaw/shared/execution-deadline';
import type { Executor, ExecutorRequest } from '../agent/executor-types.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  CONTAINER_TIMEOUT,
  CONTAINER_WARM_POOL,
  HYBRIDAI_MODEL,
  MAX_CONCURRENT_CONTAINERS,
  MCP_SERVERS,
  onConfigChange,
} from '../config/config.js';
import { readStoredRuntimeEnv } from '../config/runtime-env.js';
import { logger } from '../logger.js';
import { withAutoHybridAIConnectorsMcpServer } from '../mcp/hybridai-connectors.js';
import { resolveMcpServersForRuntime } from '../mcp/mcp-oauth.js';
import { withSpan } from '../observability/otel.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import { resolveTaskModelPolicies } from '../providers/task-routing.js';
import { redactCredentialSecrets } from '../security/redact.js';
import type { ContainerInput, ContainerOutput } from '../types/container.js';
import { KeyedSerialQueue } from '../utils/keyed-serial-queue.js';
import { beginFileWriteReviewContext } from './file-write-review-context.js';
import {
  agentWorkspaceDir,
  cleanupIpc,
  createActivityTracker,
  ensureAgentDirs,
  ensureSessionDirs,
  getSessionPaths,
  interruptedAgentOutput,
  readOutput,
  writeInput,
} from './ipc.js';
import { flushCollapsedStreamDebugSummary } from './stream-debug.js';
import { WarmProcessPool } from './warm-process-pool.js';
import {
  claimWarmEntry,
  collectIdleSessionEvictions,
  enforceWarmPoolPressure,
  getCachedObservedMemoryBytes,
  getTotalWarmProcessCount,
  isTimedOutAgentOutput,
  type MemorySample,
  maintainWarmPool,
  normalizeWarmProcessPoolRuntimeConfig,
  pingWarmRunnerHealthEntry,
  processLimitForRun,
  removeWarmPoolEntry,
  sendWarmWorkerFrame,
  type WarmRunnerMode,
} from './warm-runner-utils.js';
import { remapOutputArtifacts } from './worker-artifacts.js';
import { buildWorkerEnv } from './worker-env.js';
import { buildWorkerInput, type ModelRuntime } from './worker-input.js';
import {
  capitalize,
  createWorkerEntry,
  isStdinWriteInterrupt,
  type WorkerEntry,
} from './worker-process.js';
import {
  recoverWorkerFailure,
  recoverWorkerOutput,
} from './worker-recovery.js';

const CAPACITY_POLL_MS = 100;
// 15 s for a user turn, 5 min for a background run that nobody watches, so it
// can queue behind user turns. Both modes (decided 2026-11-27, delegated by
// the owner): no caller retries on `busy`, so a short wait that usually ends
// in an idle-worker eviction beats an immediate failure, and one behaviour
// drops the last per-mode flag. Retrying on `busy` is deferred.
const CAPACITY_WAIT_MS = 15_000;
const BACKGROUND_CAPACITY_WAIT_MS = 300_000;

type WorkerSpawnParams = Pick<
  ExecutorRequest,
  | 'sessionId'
  | 'agentId'
  | 'workspacePathOverride'
  | 'workspaceDisplayRootOverride'
  | 'runtimeScope'
  | 'bashProxy'
> & { warm?: boolean };

export interface WorkerSpawnRequest {
  request: WorkerSpawnParams;
  agentId: string;
  ipcPath: string;
  workspacePath: string;
  /** The `buildWorkerEnv` contract, URLs already mapped for this mode. */
  workerEnv: Record<string, string>;
  /** Stored runtime env; set only when `runtimeEnvAtSpawn`. */
  runtimeEnv?: Record<string, string>;
}

export interface WorkerStrategy {
  mode: WarmRunnerMode;
  /** Log nouns, e.g. `container` / `containers`. */
  noun: { one: string; many: string };
  /** Subject of terminal-error and spawn-failure messages. */
  runtimeLabel: string;
  spawnErrorLabel: string;
  /** Replaces the host-install repair hint for a missing package. */
  repairHint?: string;
  spawn(request: WorkerSpawnRequest): { process: ChildProcess; name?: string };
  /** Ends the worker; called once, after its lifecycle accepted the stop. */
  stop(entry: WorkerEntry): void;
  memoryKey(entry: WorkerEntry): string | null;
  readMemoryBytes(keys: string[]): Promise<number>;
  logFields(entry: WorkerEntry): Record<string, unknown>;
  /**
   * The worker gets the stored runtime env in its process env at spawn, so
   * requests leave it out: re-applying it in the worker would replace the
   * host-built NODE_PATH. It is part of the signature either way.
   */
  runtimeEnvAtSpawn: boolean;
  /** Rewrites a gateway-side URL into one the worker can reach. */
  mapHostUrl(url: string): string;
  /** Root for turn-checkpoint recovery evidence. */
  stateRoot(request: ExecutorRequest, workspacePath: string): string;
  /** Rewrites `input` to go through a gateway-side relay for this turn. */
  startModelRelay?(params: {
    input: ContainerInput;
    modelRuntime: ModelRuntime;
    ipcPath: string;
    model: string;
    task: string;
  }): { stop(): void } | undefined;
}

/** Whether a pooled worker can take its session's next request. */
function isLive(entry: WorkerEntry): boolean {
  return (
    entry.lifecycle.reusable &&
    !entry.process.killed &&
    entry.process.exitCode === null
  );
}

function resolveWorkspacePath(params: {
  sessionId: string;
  agentId: string;
  workspacePathOverride?: string;
}): string {
  const trimmed = params.workspacePathOverride?.trim();
  if (trimmed) return path.resolve(trimmed);
  const { workspacePath } = getSessionPaths(params.sessionId, params.agentId);
  return workspacePath;
}

export function createWorkerRunner(strategy: WorkerStrategy): Executor {
  const worker = strategy.noun.one;
  const Worker = capitalize(worker);
  const pool = new Map<string, WorkerEntry>();
  const sessionQueue = new KeyedSerialQueue();
  const warmPool = new WarmProcessPool<WorkerEntry>(
    normalizeWarmProcessPoolRuntimeConfig(CONTAINER_WARM_POOL),
    (entries) => stopWarmEntries(entries),
  );
  let memorySample: MemorySample | null = null;
  let memoryRefreshInFlight = false;
  // Runs past their capacity check whose worker is not in the pool yet. They
  // count, or runs that start together all pass the check and overshoot it.
  let startingProcesses = 0;

  const totalProcessCount = () =>
    getTotalWarmProcessCount(pool, warmPool) + startingProcesses;
  const removeEntry = (entry: WorkerEntry) =>
    removeWarmPoolEntry(pool, warmPool, entry);

  function stopEntry(entry: WorkerEntry): void {
    if (entry.lifecycle.stop()) strategy.stop(entry);
  }

  function stopWarmEntries(entries: WorkerEntry[]): void {
    for (const entry of entries) {
      logger.info(
        { agentId: entry.agentId, ...strategy.logFields(entry) },
        `Evicting warm ${worker}`,
      );
      stopEntry(entry);
    }
  }

  onConfigChange((config) => {
    stopWarmEntries(
      warmPool.reconfigure(
        normalizeWarmProcessPoolRuntimeConfig(config.container.warmPool),
      ),
    );
    memorySample = null;
  });

  function observedMemoryBytes(): number {
    return getCachedObservedMemoryBytes({
      cache: memorySample,
      setCache: (sample) => {
        memorySample = sample;
      },
      isRefreshInFlight: () => memoryRefreshInFlight,
      setRefreshInFlight: (value) => {
        memoryRefreshInFlight = value;
      },
      activeEntries: Array.from(pool.values()),
      warmEntries: warmPool.values(),
      memoryPressureEnabled: warmPool.memoryPressureEnabled,
      keyForEntry: strategy.memoryKey,
      refreshTotalBytes: strategy.readMemoryBytes,
    });
  }

  function resolveMcpServers() {
    return resolveMcpServersForRuntime(
      withAutoHybridAIConnectorsMcpServer(MCP_SERVERS, {
        mapUrl: strategy.mapHostUrl,
      }),
    );
  }

  /** One eviction pass; true once a new worker fits under `limit`. */
  function freeCapacity(limit: number): boolean {
    stopWarmEntries(
      warmPool.evictForPressure({
        totalProcessCount: totalProcessCount() + 1,
        maxProcessCount: limit,
      }),
    );
    if (totalProcessCount() < limit) return true;
    for (const entry of collectIdleSessionEvictions({
      pool,
      warmPool,
      maxProcessCount: limit,
    })) {
      logger.info(
        { sessionId: entry.sessionId, agentId: entry.agentId },
        `Evicting idle ${worker} to free capacity`,
      );
      stopEntry(entry);
      removeEntry(entry);
    }
    return totalProcessCount() < limit;
  }

  async function waitForCapacity(
    sessionId: string,
    limit: number,
    waitMs: number,
    abortSignal?: AbortSignal,
  ): Promise<'available' | 'aborted' | 'timed_out'> {
    const deadline = Date.now() + waitMs;
    while (totalProcessCount() >= limit && !pool.has(sessionId)) {
      if (freeCapacity(limit)) break;
      if (abortSignal?.aborted) return 'aborted';
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return 'timed_out';
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(CAPACITY_POLL_MS, remainingMs)),
      );
    }
    return abortSignal?.aborted ? 'aborted' : 'available';
  }

  function spawnEnv(params: WorkerSpawnParams, agentId: string) {
    return {
      workerEnv: buildWorkerEnv({
        agentId,
        runtimeScope: params.runtimeScope,
        displayRoot: params.workspaceDisplayRootOverride,
        mode: strategy.mode,
        mapHostUrl: strategy.mapHostUrl,
      }),
      ...(strategy.runtimeEnvAtSpawn
        ? { runtimeEnv: readStoredRuntimeEnv() }
        : {}),
    };
  }

  function getOrSpawn(params: WorkerSpawnParams): WorkerEntry {
    const sessionId = params.sessionId;
    const agentId = params.agentId || DEFAULT_AGENT_ID;
    const existing = params.warm ? null : pool.get(sessionId);
    if (existing && isLive(existing)) {
      logger.debug(
        { sessionId, ...strategy.logFields(existing) },
        `Reusing ${worker}`,
      );
      return existing;
    }
    if (existing) pool.delete(sessionId);

    ensureSessionDirs(sessionId);
    ensureAgentDirs(agentId);
    const { ipcPath } = getSessionPaths(sessionId, agentId);
    const workspacePath = resolveWorkspacePath({
      sessionId,
      agentId,
      workspacePathOverride: params.workspacePathOverride,
    });
    fs.mkdirSync(workspacePath, { recursive: true });
    const env = spawnEnv(params, agentId);
    const spawned = strategy.spawn({
      request: params,
      agentId,
      ipcPath,
      workspacePath,
      ...env,
    });
    const entry = createWorkerEntry({
      strategy,
      spawned,
      sessionId,
      agentId,
      spawnEnv: JSON.stringify(env),
      warm: Boolean(params.warm),
      warmPool,
      stop: stopEntry,
      remove: removeEntry,
    });

    if (entry.lifecycle.isSpare) {
      warmPool.add(entry);
      observedMemoryBytes();
    } else {
      pool.set(sessionId, entry);
    }
    return entry;
  }

  function maintainWarm(params: WorkerSpawnParams & { agentId: string }): void {
    maintainWarmPool({
      pool,
      warmPool,
      maxProcessCount: MAX_CONCURRENT_CONTAINERS,
      agentId: params.agentId,
      eligibility: params,
      stopEntries: stopWarmEntries,
      spawnWarm: (sessionId, agentId) => {
        const entry = getOrSpawn({ sessionId, agentId, warm: true });
        void sendWarmWorkerFrame(entry, resolveMcpServers);
      },
    });
  }

  function stopSession(sessionId: string): boolean {
    const entry = pool.get(sessionId);
    if (!entry) return false;
    logger.info(
      { sessionId, ...strategy.logFields(entry) },
      `Stopping session ${worker}`,
    );
    stopEntry(entry);
    removeEntry(entry);
    return true;
  }

  async function runInner(params: ExecutorRequest): Promise<ContainerOutput> {
    const {
      sessionId,
      chatbotId,
      enableRag,
      model = HYBRIDAI_MODEL,
      agentId = DEFAULT_AGENT_ID,
      onTextDelta,
      onThinkingDelta,
      onToolProgress,
      onApprovalProgress,
      abortSignal,
      maxWallClockMs,
      inactivityTimeoutMs,
    } = params;
    const executionDeadlineAtMs = resolveExecutionDeadline(
      maxWallClockMs,
      params.executionDeadlineAtMs,
    );
    const workspacePath = resolveWorkspacePath({
      sessionId,
      agentId,
      workspacePathOverride: params.workspacePathOverride,
    });
    const modelRuntime = await resolveModelRuntimeCredentials({
      model,
      chatbotId,
      enableRag,
      agentId,
    });
    const taskModels = await resolveTaskModelPolicies({
      agentId,
      chatbotId: modelRuntime.chatbotId,
      sessionModel: modelRuntime.model || model,
    });
    const runtimeEnv = readStoredRuntimeEnv();

    enforceWarmPoolPressure({
      pool,
      warmPool,
      maxProcessCount: MAX_CONCURRENT_CONTAINERS,
      getObservedMemoryBytes: observedMemoryBytes,
      stopEntries: stopWarmEntries,
    });
    const processLimit = processLimitForRun(
      MAX_CONCURRENT_CONTAINERS,
      params.background,
    );
    if (totalProcessCount() >= processLimit && !pool.has(sessionId)) {
      const waitMs = params.background
        ? BACKGROUND_CAPACITY_WAIT_MS
        : CAPACITY_WAIT_MS;
      const capacity = await waitForCapacity(
        sessionId,
        processLimit,
        waitMs,
        abortSignal,
      );
      if (capacity === 'aborted') {
        return interruptedAgentOutput(abortSignal?.reason);
      }
      if (capacity === 'timed_out') {
        return {
          status: 'error',
          result: null,
          toolsUsed: [],
          error: `Too many active ${strategy.noun.many} (${totalProcessCount()}/${processLimit}) after waiting ${waitMs}ms. Try again later.`,
          errorCode: 'busy',
        };
      }
    }

    const startTime = Date.now();
    // The worker is spawned without another await after this one.
    const starting = pool.has(sessionId) ? 0 : 1;
    startingProcesses += starting;
    let mcpServers: Awaited<ReturnType<typeof resolveMcpServers>>;
    try {
      mcpServers = await resolveMcpServers();
    } finally {
      startingProcesses -= starting;
    }
    const existingEntry = pool.get(sessionId);
    const requestId = randomUUID();

    const { input, workerSignature } = buildWorkerInput(params, {
      requestId,
      executionDeadlineAtMs,
      modelRuntime,
      taskModels,
      mcpServers,
      runtimeEnv,
      runtimeEnvAtSpawn: strategy.runtimeEnvAtSpawn,
      mapHostUrl: strategy.mapHostUrl,
    });

    const spawnParams = {
      sessionId,
      agentId,
      workspacePathOverride: params.workspacePathOverride,
      workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
      bashProxy: params.bashProxy,
      runtimeScope: params.runtimeScope,
    };
    // Compared in memory only, never logged: it holds the runtime token.
    const currentEnv = JSON.stringify(spawnEnv(spawnParams, agentId));
    if (
      existingEntry &&
      (existingEntry.workerSignature !== workerSignature ||
        existingEntry.spawnEnv !== currentEnv)
    ) {
      logger.info(
        {
          sessionId,
          ...strategy.logFields(existingEntry),
          agentId,
          provider: input.provider,
        },
        `Worker routing or env changed; restarting ${worker}`,
      );
      stopEntry(existingEntry);
      removeEntry(existingEntry);
    }

    const current = pool.get(sessionId);
    const isNewWorker = !current || !isLive(current);

    let entry: WorkerEntry;
    try {
      entry =
        (isNewWorker
          ? claimWarmEntry({
              pool,
              warmPool,
              sessionId,
              agentId,
              eligibility: spawnParams,
              isCurrent: (spare) => spare.spawnEnv === currentEnv,
              discard: (spare) => {
                logger.info(
                  { agentId, ...strategy.logFields(spare) },
                  `Discarding warm ${worker} spawned with an outdated env`,
                );
                stopEntry(spare);
              },
              logClaim: (claimed) =>
                logger.info(
                  {
                    sessionId,
                    ipcSessionId: claimed.ipcSessionId,
                    agentId,
                    ...strategy.logFields(claimed),
                  },
                  `Claimed warm ${worker}`,
                ),
            })
          : null) || getOrSpawn(spawnParams);
    } catch (err) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `${strategy.spawnErrorLabel}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const ipcPath = getSessionPaths(entry.ipcSessionId, agentId).ipcPath;
    cleanupIpc(entry.ipcSessionId);
    ensureSessionDirs(entry.ipcSessionId);
    params.steerInbox?.open({
      ipcDir: ipcPath,
      requestId,
      authSecret: entry.ipcAuthSecret,
    });
    const relay = strategy.startModelRelay?.({
      input,
      modelRuntime,
      ipcPath,
      model: modelRuntime.model || model,
      task: `${agentId}:${sessionId}`,
    });
    const activity = createActivityTracker();
    entry.workerSignature = workerSignature;
    entry.onTextDelta = onTextDelta;
    entry.onThinkingDelta = onThinkingDelta;
    entry.onToolProgress = onToolProgress;
    entry.pendingBrowserFrame = undefined;
    entry.browserFrameWorkspace = {
      path: workspacePath,
      displayRoot: params.workspaceDisplayRootOverride,
    };
    entry.onApprovalProgress = onApprovalProgress;
    entry.lifecycle.begin(requestId, activity);
    const onAbort = () => {
      logger.info(
        { sessionId, ...strategy.logFields(entry) },
        `Interrupt requested, stopping ${worker}`,
      );
      stopEntry(entry);
      removeEntry(entry);
    };
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }

    const reviewContext = beginFileWriteReviewContext(
      input,
      entry.ipcAuthSecret,
    );
    try {
      if (abortSignal?.aborted)
        return interruptedAgentOutput(abortSignal.reason);
      if (isNewWorker) {
        entry.pendingColdStartProbeStartedAt = Date.now();
        // First request: full input (apiKey, per-worker IPC auth secret) on
        // one stdin line, never on disk. Stdin stays open: closing it can end
        // the worker (`docker run -i` exits).
        try {
          entry.process.stdin?.write(
            `${JSON.stringify({ ...input, ipcAuthSecret: entry.ipcAuthSecret })}\n`,
          );
        } catch (err) {
          if (isStdinWriteInterrupt(err, entry.process, abortSignal)) {
            logger.info(
              { sessionId, error: err },
              `${Worker} input write interrupted by process shutdown`,
            );
            return interruptedAgentOutput(abortSignal?.reason);
          }
          throw err;
        }
      } else {
        // Follow-ups go through the IPC file without credentials,
        // authenticated with the secret the worker got on stdin.
        writeInput(entry.ipcSessionId, input, {
          authSecret: entry.ipcAuthSecret,
        });
      }

      let output = await readOutput(
        entry.ipcSessionId,
        requestId,
        inactivityTimeoutMs === undefined
          ? CONTAINER_TIMEOUT
          : inactivityTimeoutMs,
        {
          signal: abortSignal,
          activity,
          maxWallClockMs,
          executionDeadlineAtMs,
          terminalError: () => entry.lifecycle.terminalError,
        },
      );
      // Before anything else can run: a note from here on is refused.
      params.steerInbox?.close();
      const timedOut = isTimedOutAgentOutput(output);
      if (timedOut) {
        logger.warn(
          { sessionId, ...strategy.logFields(entry) },
          `Agent output timed out; stopping stuck ${worker}`,
        );
        stopSession(sessionId);
      }
      output = recoverWorkerOutput(
        output,
        strategy.stateRoot(params, workspacePath),
        sessionId,
        input.runId || input.requestId,
        Boolean(
          timedOut || abortSignal?.aborted || entry.lifecycle.terminalError,
        ),
      );
      output = reviewContext.finish(output);
      remapOutputArtifacts(
        output,
        workspacePath,
        params.workspaceDisplayRootOverride,
      );
      if (typeof output.result === 'string') {
        output.result = redactCredentialSecrets(output.result);
      }
      if (typeof output.error === 'string') {
        output.error = redactCredentialSecrets(output.error);
      }
      if (output.pendingApproval) {
        output.pendingApproval = {
          ...output.pendingApproval,
          prompt: redactCredentialSecrets(output.pendingApproval.prompt),
          intent: redactCredentialSecrets(output.pendingApproval.intent),
          reason: redactCredentialSecrets(output.pendingApproval.reason),
        };
      }
      const duration = Date.now() - startTime;
      if (!timedOut) {
        entry.lastUsedAt = Date.now();
        warmPool.recordRequest(agentId, duration);
        if (params.client === 'mobile') warmPool.recordPhoneUser(agentId);
        // Best-effort: a failed refill must not discard the finished turn.
        try {
          maintainWarm(spawnParams);
        } catch (err) {
          logger.warn({ agentId, err }, `Warm ${worker} refill failed`);
        }
      }

      logger.info(
        {
          sessionId,
          ...strategy.logFields(entry),
          duration,
          status: output.status,
          toolsUsed: output.toolsUsed,
        },
        'Request completed',
      );
      return output;
    } catch (error) {
      stopSession(sessionId);
      return recoverWorkerFailure(
        error,
        strategy.stateRoot(params, workspacePath),
        sessionId,
        input.runId || input.requestId,
      );
    } finally {
      reviewContext.close();
      params.steerInbox?.close();
      relay?.stop();
      abortSignal?.removeEventListener('abort', onAbort);
      flushCollapsedStreamDebugSummary(entry.streamDebug, (message) =>
        logger.debug(
          { sessionId: entry.ipcSessionId, ...strategy.logFields(entry) },
          message,
        ),
      );
      if (entry.onTextDelta === onTextDelta) entry.onTextDelta = undefined;
      if (entry.onThinkingDelta === onThinkingDelta)
        entry.onThinkingDelta = undefined;
      if (entry.onToolProgress === onToolProgress)
        entry.onToolProgress = undefined;
      if (entry.onApprovalProgress === onApprovalProgress)
        entry.onApprovalProgress = undefined;
      entry.lifecycle.finish(requestId);
    }
  }

  return {
    exec: (params) =>
      sessionQueue.run(params.sessionId, () =>
        withSpan(
          `hybridclaw.${strategy.mode}.execute`,
          {
            'hybridclaw.session_id': params.sessionId,
            'hybridclaw.agent_id': params.agentId || '',
            'hybridclaw.model': params.model || '',
          },
          async () => runInner(params),
        ),
      ),
    getWorkspacePath(agentId) {
      ensureAgentDirs(agentId);
      return path.resolve(agentWorkspaceDir(agentId));
    },
    stopSession,
    stopAll() {
      for (const [sessionId, entry] of pool) {
        logger.info(
          { sessionId, ...strategy.logFields(entry) },
          `Stopping ${worker} (shutdown)`,
        );
        stopEntry(entry);
      }
      pool.clear();
      for (const entry of warmPool.clear()) {
        logger.info(
          { agentId: entry.agentId, ...strategy.logFields(entry) },
          `Stopping warm ${worker} (shutdown)`,
        );
        stopEntry(entry);
      }
    },
    getActiveSessionCount: () => pool.size,
    getInFlightSessionCount: () =>
      Array.from(pool.values()).filter((entry) => entry.lifecycle.activity)
        .length,
    getActiveSessionIds: () =>
      Array.from(pool.keys()).sort((left, right) => left.localeCompare(right)),
    getInFlightSessionIds: () =>
      Array.from(pool.entries())
        .filter(([, entry]) => Boolean(entry.lifecycle.activity))
        .map(([sessionId]) => sessionId)
        .sort((left, right) => left.localeCompare(right)),
    async getSessionHealthSnapshots() {
      const snapshots = await Promise.all(
        Array.from(pool.values()).map((entry) =>
          pingWarmRunnerHealthEntry(strategy.mode, entry),
        ),
      );
      return snapshots.sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId),
      );
    },
  };
}
