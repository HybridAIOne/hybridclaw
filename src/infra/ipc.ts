/**
 * File-based IPC between the gateway and the agent process: one input and one
 * output file per request in the session's `ipc/` dir; auth material from the
 * first stdin request is never written to disk.
 *
 * `readOutput` always settles, with the agent's output, a timeout, or an
 * interrupt. An interrupted read keeps only the tool history the agent flushed
 * while shutting down; anything else it wrote late is ignored. Starting and
 * stopping the agent belongs to host-runner / container-runner, not here.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveAgentWorkspaceId } from '../agents/agent-registry.js';
import { CONTAINER_MAX_OUTPUT_SIZE, DATA_DIR } from '../config/config.js';
import { logger } from '../logger.js';
import type { ContainerInput, ContainerOutput } from '../types/container.js';
import { TASK_MODEL_KEYS } from '../types/models.js';

/**
 * Get session directory, creating it if needed.
 */
function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(DATA_DIR, 'sessions', safe);
  return dir;
}

function ipcDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'ipc');
}

function ipcFilePath(sessionId: string, filename: string): string {
  return path.join(ipcDir(sessionId), filename);
}

function agentDir(agentId: string): string {
  const workspaceId = resolveAgentWorkspaceId(agentId);
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, 'agents', safe);
}

function redactTaskModelSecrets(
  taskModels: ContainerInput['taskModels'],
): ContainerInput['taskModels'] | undefined {
  const redacted: NonNullable<ContainerInput['taskModels']> = {};
  for (const key of TASK_MODEL_KEYS) {
    const taskModel = taskModels?.[key];
    if (!taskModel) continue;
    redacted[key] = {
      ...taskModel,
      apiKey: '',
      requestHeaders: {},
    };
  }
  return Object.keys(redacted).length > 0 ? redacted : undefined;
}

function redactWebSearchSecrets(
  webSearch: ContainerInput['webSearch'],
): ContainerInput['webSearch'] | undefined {
  if (!webSearch) return undefined;
  return {
    ...webSearch,
    braveApiKey: undefined,
    perplexityApiKey: undefined,
    tavilyApiKey: undefined,
  };
}

function buildRedactedInput(input: ContainerInput): ContainerInput {
  return {
    ...input,
    apiKey: '',
    requestHeaders: {},
    taskModels: redactTaskModelSecrets(input.taskModels),
    webSearch: redactWebSearchSecrets(input.webSearch),
    providerCredentials: undefined,
  };
}

export function agentWorkspaceDir(agentId: string): string {
  return path.join(agentDir(agentId), 'workspace');
}

/**
 * Ensure session directories exist (IPC only).
 */
export function ensureSessionDirs(sessionId: string): void {
  fs.mkdirSync(ipcDir(sessionId), { recursive: true });
}

/**
 * Ensure agent workspace directory exists.
 */
export function ensureAgentDirs(agentId: string): void {
  fs.mkdirSync(agentWorkspaceDir(agentId), { recursive: true });
}

/**
 * Write input for the container agent.
 * When omitApiKey is set, auth material is excluded from the file on disk
 * (the agent already has it in memory from the initial stdin payload). Runtime
 * env is preserved so short-lived host-minted tokens can refresh per request.
 */
export function writeInput(
  sessionId: string,
  input: ContainerInput,
  opts?: { omitApiKey?: boolean },
): string {
  const inputPath = ipcFilePath(sessionId, 'input.json');
  const toWrite = opts?.omitApiKey ? buildRedactedInput(input) : input;
  fs.writeFileSync(inputPath, JSON.stringify(toWrite, null, 2), {
    mode: 0o600,
  });
  logger.debug({ sessionId, path: inputPath }, 'Wrote IPC input');
  return inputPath;
}

export function writeHealthInput(
  sessionId: string,
  input: ContainerInput,
): string {
  const inputPath = ipcFilePath(sessionId, 'health-input.json');
  const toWrite = buildRedactedInput(input);
  fs.writeFileSync(inputPath, JSON.stringify(toWrite, null, 2), {
    mode: 0o600,
  });
  logger.debug({ sessionId, path: inputPath }, 'Wrote IPC health input');
  return inputPath;
}

/**
 * Read output from the container agent. Polls until file appears, the idle
 * timeout expires, or a hard wall-clock deadline is reached.
 */
function interruptedOutput(): ContainerOutput {
  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: 'Interrupted by user.',
  };
}

async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return false;
  }
  if (signal.aborted) return true;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Shared activity tracker that callers can update to reset the read timeout.
 * Create one via {@link createActivityTracker} and pass it to {@link readOutput}.
 * Call {@link ActivityTracker.notify} whenever the agent shows progress
 * (text deltas, tool progress, etc.) so the idle deadline keeps extending.
 * {@link readOutput} still enforces a hard wall-clock timeout.
 */
export interface ActivityTracker {
  /** Millisecond timestamp of the most recent activity. */
  lastActivityMs: number;
  /** Call this to record activity and reset the timeout deadline. */
  notify(): void;
}

export function createActivityTracker(): ActivityTracker {
  const tracker: ActivityTracker = {
    lastActivityMs: Date.now(),
    notify() {
      tracker.lastActivityMs = Date.now();
    },
  };
  return tracker;
}

const ACTIVITY_HARD_TIMEOUT_MULTIPLIER = 4;
const MIN_OUTPUT_POLL_INTERVAL_MS = 5;
const MAX_OUTPUT_POLL_INTERVAL_MS = 250;
// Keep the backoff formula aligned with container/src/ipc.ts; max differs by side.
const OUTPUT_POLL_BACKOFF_FACTOR = 1.5;
// 2s (agent call, 2026-09-26, pending owner review): the agent writes its
// SIGTERM output synchronously and `docker stop` signals well within this, so
// the wait only runs out when no output is coming. It caps how long collecting
// tool history can delay an interrupt.
const INTERRUPTED_OUTPUT_GRACE_MS = 2_000;

function normalizePositiveTimeoutMs(
  value: number | null | undefined,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

export async function readOutput(
  sessionId: string,
  timeoutMs: number | null | undefined,
  opts?: {
    signal?: AbortSignal;
    activity?: ActivityTracker;
    maxWallClockMs?: number | null;
    terminalError?: () => string | null;
  },
): Promise<ContainerOutput> {
  return readOutputFile(sessionId, 'output.json', timeoutMs, opts);
}

async function readOutputFile(
  sessionId: string,
  filename: string,
  timeoutMs: number | null | undefined,
  opts?: {
    signal?: AbortSignal;
    activity?: ActivityTracker;
    maxWallClockMs?: number | null;
    terminalError?: () => string | null;
  },
): Promise<ContainerOutput> {
  const outputPath = ipcFilePath(sessionId, filename);
  const signal = opts?.signal;
  const activity = opts?.activity;

  const start = Date.now();
  // Seed the tracker so the initial deadline starts now.
  if (activity) activity.lastActivityMs = start;
  const idleTimeoutMs = normalizePositiveTimeoutMs(timeoutMs);
  const requestedWallClockMs = normalizePositiveTimeoutMs(opts?.maxWallClockMs);
  const derivedWallClockMs =
    idleTimeoutMs === null
      ? null
      : idleTimeoutMs * (activity ? ACTIVITY_HARD_TIMEOUT_MULTIPLIER : 1);
  const hardTimeoutMs =
    requestedWallClockMs === null
      ? derivedWallClockMs
      : idleTimeoutMs === null
        ? requestedWallClockMs
        : Math.max(idleTimeoutMs, requestedWallClockMs);
  const hardDeadline =
    hardTimeoutMs === null ? Number.POSITIVE_INFINITY : start + hardTimeoutMs;
  let pollInterval = MIN_OUTPUT_POLL_INTERVAL_MS;

  if (signal?.aborted) return interruptedOutput();

  while (true) {
    const now = Date.now();
    const idleDeadline =
      idleTimeoutMs === null
        ? Number.POSITIVE_INFINITY
        : (activity ? activity.lastActivityMs : start) + idleTimeoutMs;
    if (now >= hardDeadline) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error:
          idleTimeoutMs === null
            ? `Timeout waiting for agent output after ${hardTimeoutMs}ms total`
            : `Timeout waiting for agent output after ${hardTimeoutMs}ms total (${idleTimeoutMs}ms inactivity window)`,
      };
    }
    if (now >= idleDeadline) break;
    if (signal?.aborted) {
      return collectInterruptedOutput(
        sessionId,
        outputPath,
        opts?.terminalError,
      );
    }

    const output = pollOutputFile(sessionId, outputPath);
    if (output) return output;
    const terminalError = opts?.terminalError?.();
    if (terminalError) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: terminalError,
      };
    }
    const sleepMs = Math.max(
      1,
      Math.min(pollInterval, idleDeadline - now, hardDeadline - now),
    );
    const aborted = await sleepWithAbort(sleepMs, signal);
    if (aborted) {
      return collectInterruptedOutput(
        sessionId,
        outputPath,
        opts?.terminalError,
      );
    }
    pollInterval = Math.min(
      Math.ceil(pollInterval * OUTPUT_POLL_BACKOFF_FACTOR),
      MAX_OUTPUT_POLL_INTERVAL_MS,
    );
  }

  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: `Timeout waiting for agent output after ${idleTimeoutMs}ms`,
  };
}

/** One look at the output file: the parsed output, an oversize error, or null. */
function pollOutputFile(
  sessionId: string,
  outputPath: string,
): ContainerOutput | null {
  if (!fs.existsSync(outputPath)) return null;
  const stat = fs.statSync(outputPath);
  if (stat.size > CONTAINER_MAX_OUTPUT_SIZE) {
    fs.unlinkSync(outputPath);
    logger.warn(
      { sessionId, size: stat.size, limit: CONTAINER_MAX_OUTPUT_SIZE },
      'Container output exceeded size limit',
    );
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: `Output too large (${stat.size} bytes, limit ${CONTAINER_MAX_OUTPUT_SIZE})`,
    };
  }
  try {
    const raw = fs.readFileSync(outputPath, 'utf-8');
    const output: ContainerOutput = JSON.parse(raw);
    // Clean up output file after reading
    fs.unlinkSync(outputPath);
    logger.debug({ sessionId }, 'Read IPC output');
    return output;
  } catch (err) {
    // File might be partially written, wait and retry
    logger.debug({ sessionId, err }, 'Output file not ready, retrying');
    return null;
  }
}

/**
 * The stopped agent flushes the tool calls it already ran (see
 * container/src/shutdown-output.ts). Keep only that history: the turn stays
 * interrupted, and its late results and side effects are not honored.
 */
async function collectInterruptedOutput(
  sessionId: string,
  outputPath: string,
  terminalError?: () => string | null,
): Promise<ContainerOutput> {
  const deadline = Date.now() + INTERRUPTED_OUTPUT_GRACE_MS;
  let pollInterval = MIN_OUTPUT_POLL_INTERVAL_MS;
  while (true) {
    const late = pollOutputFile(sessionId, outputPath);
    if (late) {
      return {
        ...interruptedOutput(),
        ...(late.toolHistory?.length ? { toolHistory: late.toolHistory } : {}),
        ...(late.toolHistoryForReplay?.length
          ? { toolHistoryForReplay: late.toolHistoryForReplay }
          : {}),
      };
    }
    const remainingMs = deadline - Date.now();
    // An agent that already exited will not write anything more.
    if (remainingMs <= 0 || terminalError?.()) return interruptedOutput();
    await sleepWithAbort(Math.min(pollInterval, remainingMs));
    pollInterval = Math.min(
      Math.ceil(pollInterval * OUTPUT_POLL_BACKOFF_FACTOR),
      MAX_OUTPUT_POLL_INTERVAL_MS,
    );
  }
}

export function readHealthOutput(
  sessionId: string,
  timeoutMs: number | null | undefined,
  opts?: {
    terminalError?: () => string | null;
  },
): Promise<ContainerOutput> {
  return readOutputFile(sessionId, 'health-output.json', timeoutMs, opts);
}

/**
 * Clean up IPC files for a session.
 */
export function cleanupIpc(sessionId: string): void {
  const dir = ipcDir(sessionId);
  for (const file of ['input.json', 'output.json', 'history.json']) {
    const filePath = path.join(dir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

export function cleanupHealthIpc(sessionId: string): void {
  const dir = ipcDir(sessionId);
  for (const file of ['health-input.json', 'health-output.json']) {
    const filePath = path.join(dir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * Get host paths for container mounting.
 */
export function getSessionPaths(
  sessionId: string,
  agentId: string,
): {
  ipcPath: string;
  workspacePath: string;
} {
  return {
    ipcPath: path.resolve(ipcDir(sessionId)),
    workspacePath: path.resolve(agentWorkspaceDir(agentId)),
  };
}
