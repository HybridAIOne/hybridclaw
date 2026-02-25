/**
 * Container Runner — manages a pool of persistent containers.
 * Containers stay alive between requests and exit after an idle timeout.
 */
import { ChildProcess, exec, spawn } from 'child_process';

import {
  ADDITIONAL_MOUNTS,
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_TIMEOUT,
  HYBRIDAI_API_KEY,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_MODEL,
  MAX_CONCURRENT_CONTAINERS,
} from './config.js';
import { cleanupIpc, ensureAgentDirs, ensureSessionDirs, getSessionPaths, readOutput, writeInput } from './ipc.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import type { AdditionalMount, ChatMessage, ContainerInput, ContainerOutput, ScheduledTask } from './types.js';

const IDLE_TIMEOUT_MS = 300_000; // 5 minutes — matches container-side default

interface PoolEntry {
  process: ChildProcess;
  containerName: string;
  sessionId: string;
  startedAt: number;
}

const pool = new Map<string, PoolEntry>();

export function getActiveContainerCount(): number {
  return pool.size;
}

/**
 * Get or spawn a persistent container for a session.
 */
function getOrSpawnContainer(sessionId: string, agentId: string): PoolEntry {
  const existing = pool.get(sessionId);
  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    logger.debug({ sessionId, containerName: existing.containerName }, 'Reusing container');
    return existing;
  }

  // Clean up stale entry
  if (existing) {
    pool.delete(sessionId);
  }

  ensureSessionDirs(sessionId);
  ensureAgentDirs(agentId);
  const { ipcPath, workspacePath } = getSessionPaths(sessionId, agentId);
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
    '-v', `${ipcPath}:/ipc:rw`,
    '-e', `HYBRIDAI_BASE_URL=${HYBRIDAI_BASE_URL}`,
    '-e', `HYBRIDAI_MODEL=${HYBRIDAI_MODEL}`,
    '-e', `CONTAINER_IDLE_TIMEOUT=${IDLE_TIMEOUT_MS}`,
  ];

  // Run as host user so bind-mount file ownership matches
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Validate and append additional mounts
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

  proc.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line) logger.debug({ container: containerName }, line);
    }
  });

  proc.on('close', (code) => {
    pool.delete(sessionId);
    logger.info({ sessionId, containerName, code }, 'Container exited');
  });

  proc.on('error', (err) => {
    pool.delete(sessionId);
    logger.error({ sessionId, containerName, error: err }, 'Container error');
  });

  const entry: PoolEntry = {
    process: proc,
    containerName,
    sessionId,
    startedAt: Date.now(),
  };

  pool.set(sessionId, entry);
  return entry;
}

/**
 * Send a request to a persistent container and wait for the response.
 */
export async function runContainer(
  sessionId: string,
  messages: ChatMessage[],
  chatbotId: string,
  enableRag: boolean,
  model: string = HYBRIDAI_MODEL,
  agentId: string = chatbotId,
  channelId: string = '',
  scheduledTasks?: ScheduledTask[],
  allowedTools?: string[],
): Promise<ContainerOutput> {
  // Enforce concurrent container limit
  if (pool.size >= MAX_CONCURRENT_CONTAINERS && !pool.has(sessionId)) {
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: `Too many active containers (${pool.size}/${MAX_CONCURRENT_CONTAINERS}). Try again later.`,
    };
  }

  const startTime = Date.now();

  // Clean any stale output from previous request
  cleanupIpc(sessionId);
  ensureSessionDirs(sessionId);

  const isNewContainer = !pool.has(sessionId) || pool.get(sessionId)!.process.killed || pool.get(sessionId)!.process.exitCode !== null;

  let entry: PoolEntry;
  try {
    entry = getOrSpawnContainer(sessionId, agentId);
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
    apiKey: HYBRIDAI_API_KEY,
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

  if (isNewContainer) {
    // First request: send full input (including apiKey) via stdin — no file on disk.
    // Write JSON on a single line followed by newline as delimiter.
    // Do NOT end stdin — closing stdin can cause docker -i to terminate the container.
    entry.process.stdin?.write(JSON.stringify(input) + '\n');
  } else {
    // Follow-up requests: write to IPC file, omitting apiKey
    writeInput(sessionId, input, { omitApiKey: true });
  }

  // Wait for the container to produce output
  const output = await readOutput(sessionId, CONTAINER_TIMEOUT);
  const duration = Date.now() - startTime;

  logger.info(
    { sessionId, containerName: entry.containerName, duration, status: output.status, toolsUsed: output.toolsUsed },
    'Request completed',
  );

  return output;
}

/**
 * Stop a specific container.
 */
export function stopContainer(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;

  logger.info({ sessionId, containerName: entry.containerName }, 'Stopping container');
  exec(`docker stop ${entry.containerName}`, { timeout: 10000 });
  pool.delete(sessionId);
}

/**
 * Stop all containers (for graceful shutdown).
 */
export function stopAllContainers(): void {
  for (const [sessionId, entry] of pool) {
    logger.info({ sessionId, containerName: entry.containerName }, 'Stopping container (shutdown)');
    exec(`docker stop ${entry.containerName}`, { timeout: 10000 });
  }
  pool.clear();
}
