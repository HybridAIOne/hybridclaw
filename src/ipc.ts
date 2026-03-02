import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { ChildProcess } from 'child_process';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { ContainerOutput, ToolProgressEvent } from './types.js';

/**
 * Get session directory.
 */
function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, 'sessions', safe);
}

function agentDir(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, 'agents', safe);
}

export function agentWorkspaceDir(agentId: string): string {
  return path.join(agentDir(agentId), 'workspace');
}

/**
 * Ensure session workspace directory exists.
 */
export function ensureSessionDirs(sessionId: string): void {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true });
}

/**
 * Ensure agent workspace directory exists.
 */
export function ensureAgentDirs(agentId: string): void {
  fs.mkdirSync(agentWorkspaceDir(agentId), { recursive: true });
}

/**
 * Get host paths for container mounting.
 */
export function getSessionPaths(sessionId: string, agentId: string): {
  workspacePath: string;
} {
  return {
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
