import fs from 'fs';
import path from 'path';
import readline, { type Interface as RLInterface } from 'readline';

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
 * Create a persistent readline interface for a container's stdout.
 * Must be created once per container and kept alive across requests.
 */
export function createContainerReadline(stdout: NodeJS.ReadableStream): RLInterface {
  return readline.createInterface({ input: stdout, crlfDelay: Infinity });
}

/**
 * Read one result from a persistent container readline interface.
 * Attaches a temporary line listener, removes it on result/timeout/abort.
 */
export async function readStdioOutput(
  rl: RLInterface,
  timeoutMs: number,
  opts?: {
    signal?: AbortSignal;
    onToolProgress?: (event: ToolProgressEvent) => void;
    sessionId?: string;
  },
): Promise<ContainerOutput> {
  const signal = opts?.signal;
  const sessionId = opts?.sessionId || '';

  return new Promise<ContainerOutput>((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 'error', result: null, toolsUsed: [], error: 'Interrupted by user.' });
      return;
    }

    let resolved = false;

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

    function cleanup(): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
    }

    function onLine(line: string): void {
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
          sideEffects: event.sideEffects != null ? (event.sideEffects as ContainerOutput['sideEffects']) : undefined,
        });
      }
    }

    function onClose(): void {
      cleanup();
      resolve({
        status: 'error',
        result: null,
        toolsUsed: [],
        error: 'Container stdout closed before result',
      });
    }

    rl.on('line', onLine);
    rl.on('close', onClose);
  });
}
