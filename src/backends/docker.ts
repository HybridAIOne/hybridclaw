/**
 * DockerBackend — LEGACY local-development mode.
 *
 * This backend runs the full agent loop INSIDE a Docker container (agent-in-sandbox pattern).
 * It is kept for local development convenience when sandbox-service is not running.
 *
 * PRODUCTION USE: Set HYBRIDCLAW_BACKEND=sandbox-service instead.
 * The sandbox-service backend uses the "sandbox as tool" pattern where:
 *   - LLM calls happen in the gateway process (API keys never enter the sandbox)
 *   - Only tool execution (bash, file I/O) runs inside the sandboxed container
 *   - Workspaces persist in sandbox-service volumes (not host filesystem)
 *
 * @deprecated Prefer HYBRIDCLAW_BACKEND=sandbox-service for all deployments
 */
import { ChildProcess, spawn } from 'child_process';
import type { Interface as RLInterface } from 'readline';

import {
  ADDITIONAL_MOUNTS,
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_TIMEOUT,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_MODEL,
  MAX_CONCURRENT_CONTAINERS,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  getHybridAIApiKey,
} from '../config.js';
import { trackContainerInstance, untrackContainerInstance } from '../db.js';
import { createContainerReadline, ensureAgentDirs, ensureSessionDirs, getSessionPaths, readStdioOutput } from '../ipc.js';
import { logger } from '../logger.js';
import { validateAdditionalMounts } from '../mount-security.js';
import type { AdditionalMount, ChatMessage, ContainerInput, ContainerOutput, ScheduledTask, ToolProgressEvent } from '../types.js';
import type { ContainerBackend, RunContainerOptions } from './types.js';

interface PoolEntry {
  process: ChildProcess;
  rl: RLInterface;
  containerName: string;
  sessionId: string;
  startedAt: number;
  stderrBuffer: string;
  onToolProgress?: (event: ToolProgressEvent) => void;
}

const TOOL_RESULT_RE = /^\[tool\]\s+([a-zA-Z0-9_.-]+)\s+result\s+\((\d+)ms\):\s*(.*)$/;
const TOOL_START_RE = /^\[tool\]\s+([a-zA-Z0-9_.-]+):\s*(.*)$/;

function emitToolProgress(entry: PoolEntry, line: string): void {
  const callback = entry.onToolProgress;
  if (!callback) return;

  const resultMatch = line.match(TOOL_RESULT_RE);
  if (resultMatch) {
    try {
      callback({
        sessionId: entry.sessionId,
        toolName: resultMatch[1],
        phase: 'finish',
        durationMs: parseInt(resultMatch[2], 10),
        preview: resultMatch[3],
      });
    } catch (err) {
      logger.debug({ sessionId: entry.sessionId, err }, 'Tool progress callback failed');
    }
    return;
  }

  const startMatch = line.match(TOOL_START_RE);
  if (startMatch) {
    try {
      callback({
        sessionId: entry.sessionId,
        toolName: startMatch[1],
        phase: 'start',
        preview: startMatch[2],
      });
    } catch (err) {
      logger.debug({ sessionId: entry.sessionId, err }, 'Tool progress callback failed');
    }
  }
}

export class DockerBackend implements ContainerBackend {
  private pool = new Map<string, PoolEntry>();

  private stopContainer(containerName: string): void {
    const proc = spawn('docker', ['stop', containerName], { stdio: 'ignore' });
    proc.on('error', (err) => {
      logger.debug({ containerName, err }, 'Failed to stop container');
    });
  }

  stop(containerName: string): void {
    this.stopContainer(containerName);
  }

  stopAll(): void {
    for (const [sessionId, entry] of this.pool) {
      logger.info({ sessionId, containerName: entry.containerName }, 'Stopping container (shutdown)');
      this.stopContainer(entry.containerName);
    }
    this.pool.clear();
  }

  getActiveCount(): number {
    return this.pool.size;
  }

  private getOrSpawnContainer(sessionId: string, agentId: string): PoolEntry {
    const existing = this.pool.get(sessionId);
    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      logger.debug({ sessionId, containerName: existing.containerName }, 'Reusing container');
      return existing;
    }

    if (existing) {
      this.pool.delete(sessionId);
    }

    ensureSessionDirs(sessionId);
    ensureAgentDirs(agentId);
    const { workspacePath } = getSessionPaths(sessionId, agentId);
    const containerName = `hybridclaw-${sessionId.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

    const args = [
      'run',
      '--rm',
      '-i',
      '--name', containerName,
      '--memory', CONTAINER_MEMORY,
      `--cpus=${CONTAINER_CPUS}`,
      '--read-only',
      '--tmpfs', '/tmp',
      '-v', `${workspacePath}:/workspace:rw`,
      '-e', `HYBRIDAI_BASE_URL=${HYBRIDAI_BASE_URL}`,
      '-e', `HYBRIDAI_MODEL=${HYBRIDAI_MODEL}`,
      '-e', `CONTAINER_IDLE_TIMEOUT=${300_000}`,
      '-e', `HYBRIDCLAW_RETRY_ENABLED=${PROACTIVE_AUTO_RETRY_ENABLED ? 'true' : 'false'}`,
      '-e', `HYBRIDCLAW_RETRY_MAX_ATTEMPTS=${PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS}`,
      '-e', `HYBRIDCLAW_RETRY_BASE_DELAY_MS=${PROACTIVE_AUTO_RETRY_BASE_DELAY_MS}`,
      '-e', `HYBRIDCLAW_RETRY_MAX_DELAY_MS=${PROACTIVE_AUTO_RETRY_MAX_DELAY_MS}`,
      '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    ];

    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
      args.push('--user', `${hostUid}:${hostGid}`);
      args.push('-e', 'HOME=/workspace/.hybridclaw-runtime/home');
    }

    if (ADDITIONAL_MOUNTS) {
      try {
        const requested = JSON.parse(ADDITIONAL_MOUNTS) as AdditionalMount[];
        const validated = validateAdditionalMounts(requested);
        for (const m of validated) {
          args.push('-v', `${m.hostPath}:${m.containerPath}:${m.readonly ? 'ro' : 'rw'}`);
        }
      } catch (err) {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to parse ADDITIONAL_MOUNTS');
      }
    }

    args.push(CONTAINER_IMAGE);

    logger.info({ sessionId, containerName }, 'Spawning persistent container');

    const proc = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry: PoolEntry = {
      process: proc,
      rl: createContainerReadline(proc.stdout!),
      containerName,
      sessionId,
      startedAt: Date.now(),
      stderrBuffer: '',
    };

    proc.stderr?.on('data', (data) => {
      entry.stderrBuffer += data.toString('utf-8');
      const lines = entry.stderrBuffer.split('\n');
      entry.stderrBuffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        logger.debug({ container: containerName }, line);
        emitToolProgress(entry, line);
      }
    });

    proc.on('close', (code) => {
      const tail = entry.stderrBuffer.trim();
      if (tail) {
        logger.debug({ container: containerName }, tail);
        emitToolProgress(entry, tail);
        entry.stderrBuffer = '';
      }
      entry.rl.close();
      this.pool.delete(sessionId);
      untrackContainerInstance(sessionId);
      logger.info({ sessionId, containerName, code }, 'Container exited');
    });

    proc.on('error', (err) => {
      entry.rl.close();
      this.pool.delete(sessionId);
      logger.error({ sessionId, containerName, error: err }, 'Container error');
    });

    this.pool.set(sessionId, entry);
    trackContainerInstance(sessionId, containerName);
    return entry;
  }

  async run(
    sessionId: string,
    messages: ChatMessage[],
    options: RunContainerOptions,
  ): Promise<ContainerOutput> {
    const {
      chatbotId,
      enableRag,
      model = HYBRIDAI_MODEL,
      agentId = chatbotId,
      channelId = '',
      scheduledTasks,
      allowedTools,
      onToolProgress,
      abortSignal,
    } = options;

    if (this.pool.size >= MAX_CONCURRENT_CONTAINERS && !this.pool.has(sessionId)) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Too many active containers (${this.pool.size}/${MAX_CONCURRENT_CONTAINERS}). Try again later.`,
      };
    }

    const startTime = Date.now();

    ensureSessionDirs(sessionId);

    let entry: PoolEntry;
    try {
      entry = this.getOrSpawnContainer(sessionId, agentId);
    } catch (err) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Container spawn error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const input: ContainerInput = {
      sessionId,
      messages,
      chatbotId,
      enableRag,
      apiKey: getHybridAIApiKey(),
      baseUrl: HYBRIDAI_BASE_URL.replace(/\/\/(localhost|127\.0\.0\.1)([:\/])/, '//host.docker.internal$2'),
      model,
      channelId,
      scheduledTasks: scheduledTasks?.map((t) => ({
        id: t.id,
        cronExpr: t.cron_expr,
        runAt: t.run_at,
        everyMs: t.every_ms,
        prompt: t.prompt,
        enabled: t.enabled,
        lastRun: t.last_run,
        createdAt: t.created_at,
      })),
      allowedTools,
    };

    entry.onToolProgress = onToolProgress;
    const onAbort = () => {
      logger.info({ sessionId, containerName: entry.containerName }, 'Interrupt requested, stopping container');
      this.stopContainer(entry.containerName);
    };
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }

    try {
      // Stdio mode: all requests go as NDJSON lines to stdin; result comes from stdout
      entry.process.stdin?.write(JSON.stringify(input) + '\n');
      const output = await readStdioOutput(entry.rl, CONTAINER_TIMEOUT, {
        signal: abortSignal,
        onToolProgress,
        sessionId,
      });
      const duration = Date.now() - startTime;
      logger.info(
        { sessionId, containerName: entry.containerName, duration, status: output.status, toolsUsed: output.toolsUsed },
        'Request completed',
      );
      return output;
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      if (entry.onToolProgress === onToolProgress) {
        entry.onToolProgress = undefined;
      }
    }
  }
}
