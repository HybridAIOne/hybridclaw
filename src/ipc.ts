import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { ChildProcess } from 'child_process';

import { CONTAINER_MAX_OUTPUT_SIZE, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { ContainerInput, ContainerOutput, ToolProgressEvent } from './types.js';

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
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, 'agents', safe);
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
 * When omitApiKey is set, the apiKey field is excluded from the file on disk
 * (the container already has the key in memory from the initial stdin payload).
 */
export function writeInput(sessionId: string, input: ContainerInput, opts?: { omitApiKey?: boolean }): string {
  const dir = ipcDir(sessionId);
  const inputPath = path.join(dir, 'input.json');
  const toWrite = opts?.omitApiKey ? { ...input, apiKey: '' } : input;
  fs.writeFileSync(inputPath, JSON.stringify(toWrite, null, 2));
  logger.debug({ sessionId, path: inputPath }, 'Wrote IPC input');
  return inputPath;
}

/**
 * Read output from the container agent. Polls until file appears or timeout.
 */
function interruptedOutput(): ContainerOutput {
  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: 'Interrupted by user.',
  };
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
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

export async function readOutput(
  sessionId: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<ContainerOutput> {
  const dir = ipcDir(sessionId);
  const outputPath = path.join(dir, 'output.json');
  const signal = opts?.signal;

  const start = Date.now();
  const pollInterval = 250;

  if (signal?.aborted) return interruptedOutput();

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return interruptedOutput();

    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > CONTAINER_MAX_OUTPUT_SIZE) {
        fs.unlinkSync(outputPath);
        logger.warn({ sessionId, size: stat.size, limit: CONTAINER_MAX_OUTPUT_SIZE }, 'Container output exceeded size limit');
        return { status: 'error', result: null, toolsUsed: [], error: `Output too large (${stat.size} bytes, limit ${CONTAINER_MAX_OUTPUT_SIZE})` };
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
    const aborted = await sleepWithAbort(pollInterval, signal);
    if (aborted) return interruptedOutput();
  }

  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: `Timeout waiting for container output after ${timeoutMs}ms`,
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
export function getSessionPaths(sessionId: string, agentId: string): {
  ipcPath: string;
  workspacePath: string;
} {
  return {
    ipcPath: path.resolve(ipcDir(sessionId)),
    workspacePath: path.resolve(agentWorkspaceDir(agentId)),
  };
}

/**
 * Read output from a container process's stdout in stdio IPC mode.
 * Parses NDJSON lines; calls onToolProgress for tool events, resolves on {type:'result'}.
 */
export async function readStdioOutput(
  proc: ChildProcess,
  timeoutMs: number,
  opts?: {
    signal?: AbortSignal;
    onToolProgress?: (event: ToolProgressEvent) => void;
    sessionId?: string;
  },
): Promise<ContainerOutput> {
  const signal = opts?.signal;
  const sessionId = opts?.sessionId || '';

  return new Promise<ContainerOutput>((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ status: 'error', result: null, toolsUsed: [], error: 'Interrupted by user.' });
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve({
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Timeout waiting for container output after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      resolve({ status: 'error', result: null, toolsUsed: [], error: 'Interrupted by user.' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    function cleanup(): void {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      rl.close();
    }

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        logger.debug({ sessionId, line }, 'Unparseable stdout line from container');
        return;
      }

      if (event.type === 'tool_start' || event.type === 'tool_finish') {
        const cb = opts?.onToolProgress;
        if (cb) {
          try {
            cb({
              sessionId,
              toolName: String(event.name || ''),
              phase: event.type === 'tool_start' ? 'start' : 'finish',
              durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
              preview: typeof event.preview === 'string' ? event.preview : undefined,
            });
          } catch (err) {
            logger.debug({ sessionId, err }, 'Tool progress callback failed');
          }
        }
        return;
      }

      if (event.type === 'result') {
        cleanup();
        resolve({
          status: (event.status as ContainerOutput['status']) || 'error',
          result: typeof event.result === 'string' ? event.result : null,
          toolsUsed: Array.isArray(event.toolsUsed) ? (event.toolsUsed as string[]) : [],
          error: typeof event.error === 'string' ? event.error : undefined,
        });
      }
    });

    rl.on('error', (err) => {
      cleanup();
      reject(err);
    });

    rl.on('close', () => {
      cleanup();
      resolve({
        status: 'error',
        result: null,
        toolsUsed: [],
        error: 'Container stdout closed before result',
      });
    });
  });
}
