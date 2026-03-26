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
 * (the agent already has it in memory from the initial stdin payload).
 */
export function writeInput(
  sessionId: string,
  input: ContainerInput,
  opts?: { omitApiKey?: boolean },
): string {
  const dir = ipcDir(sessionId);
  const inputPath = path.join(dir, 'input.json');
  const toWrite = opts?.omitApiKey
    ? {
        ...input,
        apiKey: '',
        requestHeaders: {},
        taskModels: redactTaskModelSecrets(input.taskModels),
      }
    : input;
  fs.writeFileSync(inputPath, JSON.stringify(toWrite, null, 2));
  logger.debug({ sessionId, path: inputPath }, 'Wrote IPC input');
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

export async function readOutput(
  sessionId: string,
  timeoutMs: number,
  opts?: {
    signal?: AbortSignal;
    activity?: ActivityTracker;
    maxWallClockMs?: number;
  },
): Promise<ContainerOutput> {
  const dir = ipcDir(sessionId);
  const outputPath = path.join(dir, 'output.json');
  const signal = opts?.signal;
  const activity = opts?.activity;

  const start = Date.now();
  // Seed the tracker so the initial deadline starts now.
  if (activity) activity.lastActivityMs = start;
  const hardTimeoutMs = Math.max(
    timeoutMs,
    Math.floor(
      opts?.maxWallClockMs ??
        timeoutMs * (activity ? ACTIVITY_HARD_TIMEOUT_MULTIPLIER : 1),
    ),
  );
  const hardDeadline = start + hardTimeoutMs;
  const pollInterval = 250;

  if (signal?.aborted) return interruptedOutput();

  while (true) {
    const now = Date.now();
    const idleDeadline =
      (activity ? activity.lastActivityMs : start) + timeoutMs;
    if (now >= hardDeadline) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Timeout waiting for agent output after ${hardTimeoutMs}ms total (${timeoutMs}ms inactivity window)`,
      };
    }
    if (now >= idleDeadline) break;
    if (signal?.aborted) return interruptedOutput();

    if (fs.existsSync(outputPath)) {
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
      }
    }
    const sleepMs = Math.max(
      1,
      Math.min(pollInterval, idleDeadline - now, hardDeadline - now),
    );
    const aborted = await sleepWithAbort(sleepMs, signal);
    if (aborted) return interruptedOutput();
  }

  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: `Timeout waiting for agent output after ${timeoutMs}ms`,
  };
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
