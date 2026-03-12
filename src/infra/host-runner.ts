import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutorRequest } from '../agent/executor-types.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  CONTAINER_TIMEOUT,
  GATEWAY_API_TOKEN,
  GATEWAY_BASE_URL,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_MAX_TOKENS,
  HYBRIDAI_MODEL,
  MAX_CONCURRENT_CONTAINERS,
  MCP_SERVERS,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_RALPH_MAX_ITERATIONS,
  WEB_SEARCH_CACHE_TTL_MINUTES,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_FALLBACK_PROVIDERS,
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_SEARXNG_BASE_URL,
  WEB_SEARCH_TAVILY_SEARCH_DEPTH,
} from '../config/config.js';
import { logger } from '../logger.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import { redactSecrets } from '../security/redact.js';
import type {
  ContainerInput,
  ContainerOutput,
  ToolProgressEvent,
} from '../types.js';
import {
  collectConfiguredDiscordChannelIds,
  remapOutputArtifacts,
  resolveDiscordMediaCacheHostDir,
} from './container-runner.js';
import {
  agentWorkspaceDir,
  cleanupIpc,
  createActivityTracker,
  ensureAgentDirs,
  ensureSessionDirs,
  getSessionPaths,
  readOutput,
  writeInput,
} from './ipc.js';
import {
  consumeCollapsedStreamDebugLine,
  createStreamDebugState,
  decodeStreamDelta,
  flushCollapsedStreamDebugSummary,
  type StreamDebugState,
} from './stream-debug.js';
import { computeWorkerSignature } from './worker-signature.js';

const IDLE_TIMEOUT_MS = 300_000;
const TOOL_RESULT_RE =
  /^\[tool\]\s+([a-zA-Z0-9_.-]+)\s+result\s+\((\d+)ms\):\s*(.*)$/;
const TOOL_START_RE = /^\[tool\]\s+([a-zA-Z0-9_.-]+):\s*(.*)$/;

interface PoolEntry {
  process: ChildProcess;
  sessionId: string;
  startedAt: number;
  stderrBuffer: string;
  streamDebug: StreamDebugState;
  workerSignature: string;
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  /** Activity tracker that resets the IPC read timeout on agent progress. */
  activity?: import('./ipc.js').ActivityTracker;
}

const pool = new Map<string, PoolEntry>();

export function getActiveHostSessionIds(): string[] {
  return Array.from(pool.keys()).sort((left, right) =>
    left.localeCompare(right),
  );
}

function emitTextDelta(entry: PoolEntry, line: string): void {
  const callback = entry.onTextDelta;
  if (!callback) return;
  const delta = decodeStreamDelta(line);
  if (delta == null) return;

  try {
    if (delta) callback(redactSecrets(delta));
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Text delta callback failed',
    );
  }
}

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
        preview: redactSecrets(resultMatch[3]),
      });
    } catch (err) {
      logger.debug(
        { sessionId: entry.sessionId, err },
        'Tool progress callback failed',
      );
    }
    return;
  }

  const startMatch = line.match(TOOL_START_RE);
  if (!startMatch) return;
  try {
    callback({
      sessionId: entry.sessionId,
      toolName: startMatch[1],
      phase: 'start',
      preview: redactSecrets(startMatch[2]),
    });
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Tool progress callback failed',
    );
  }
}

function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function resolveHostAgentCommand(): { command: string; args: string[] } {
  const packageRoot = resolvePackageRoot();
  const builtEntrypoint = path.join(
    packageRoot,
    'container',
    'dist',
    'index.js',
  );
  if (fs.existsSync(builtEntrypoint)) {
    return { command: process.execPath, args: [builtEntrypoint] };
  }

  const sourceEntrypoint = path.join(
    packageRoot,
    'container',
    'src',
    'index.ts',
  );
  const tsxBin = path.join(
    packageRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  if (fs.existsSync(sourceEntrypoint) && fs.existsSync(tsxBin)) {
    return { command: tsxBin, args: [sourceEntrypoint] };
  }

  throw new Error(
    'Host sandbox mode requires a local agent runtime. Run `npm --prefix container run build` or use the repo checkout with `tsx` installed.',
  );
}

function ensureWorkspaceNodeModulesLink(workspacePath: string): void {
  const packageRoot = resolvePackageRoot();
  const sourceNodeModules = path.join(packageRoot, 'node_modules');
  if (!fs.existsSync(sourceNodeModules)) return;

  const targetNodeModules = path.join(workspacePath, 'node_modules');

  try {
    const stat = fs.lstatSync(targetNodeModules);
    if (stat.isSymbolicLink()) {
      const existingTarget = fs.readlinkSync(targetNodeModules);
      const resolvedExisting = path.resolve(
        path.dirname(targetNodeModules),
        existingTarget,
      );
      if (resolvedExisting === sourceNodeModules) return;
    }
    fs.rmSync(targetNodeModules, { recursive: true, force: true });
  } catch {
    // Missing target is fine; we'll create it below.
  }

  fs.symlinkSync(sourceNodeModules, targetNodeModules, 'dir');
}

function stopHostProcess(entry: PoolEntry): void {
  try {
    entry.process.kill('SIGTERM');
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Failed to stop host agent',
    );
  }
}

function getOrSpawnHostProcess(sessionId: string, agentId: string): PoolEntry {
  const existing = pool.get(sessionId);
  if (
    existing &&
    !existing.process.killed &&
    existing.process.exitCode === null
  ) {
    logger.debug({ sessionId }, 'Reusing host agent process');
    return existing;
  }

  if (existing) pool.delete(sessionId);

  ensureSessionDirs(sessionId);
  ensureAgentDirs(agentId);
  const { ipcPath, workspacePath } = getSessionPaths(sessionId, agentId);
  ensureWorkspaceNodeModulesLink(workspacePath);
  const mediaCacheHostPath = resolveDiscordMediaCacheHostDir();
  fs.mkdirSync(mediaCacheHostPath, { recursive: true });

  const runtime = resolveHostAgentCommand();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HYBRIDAI_BASE_URL,
    HYBRIDAI_MODEL,
    CONTAINER_IDLE_TIMEOUT: String(IDLE_TIMEOUT_MS),
    HYBRIDCLAW_RETRY_ENABLED: PROACTIVE_AUTO_RETRY_ENABLED ? 'true' : 'false',
    HYBRIDCLAW_RETRY_MAX_ATTEMPTS: String(PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS),
    HYBRIDCLAW_RETRY_BASE_DELAY_MS: String(PROACTIVE_AUTO_RETRY_BASE_DELAY_MS),
    HYBRIDCLAW_RETRY_MAX_DELAY_MS: String(PROACTIVE_AUTO_RETRY_MAX_DELAY_MS),
    HYBRIDCLAW_RALPH_MAX_ITERATIONS: String(PROACTIVE_RALPH_MAX_ITERATIONS),
    HYBRIDCLAW_WEB_SEARCH_PROVIDER: WEB_SEARCH_PROVIDER,
    HYBRIDCLAW_WEB_SEARCH_FALLBACK_PROVIDERS:
      WEB_SEARCH_FALLBACK_PROVIDERS.join(','),
    HYBRIDCLAW_WEB_SEARCH_DEFAULT_COUNT: String(WEB_SEARCH_DEFAULT_COUNT),
    HYBRIDCLAW_WEB_SEARCH_CACHE_TTL_MINUTES: String(
      WEB_SEARCH_CACHE_TTL_MINUTES,
    ),
    HYBRIDCLAW_WEB_SEARCH_TAVILY_SEARCH_DEPTH: WEB_SEARCH_TAVILY_SEARCH_DEPTH,
    SEARXNG_BASE_URL: WEB_SEARCH_SEARXNG_BASE_URL,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspacePath,
    HYBRIDCLAW_AGENT_MEDIA_ROOT: mediaCacheHostPath,
    HYBRIDCLAW_AGENT_IPC_DIR: ipcPath,
  };

  logger.info(
    { sessionId, command: runtime.command, args: runtime.args },
    'Spawning host agent process',
  );

  const proc = spawn(runtime.command, runtime.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workspacePath,
    env,
  });

  const entry: PoolEntry = {
    process: proc,
    sessionId,
    startedAt: Date.now(),
    stderrBuffer: '',
    streamDebug: createStreamDebugState(),
    workerSignature: '',
  };

  proc.stderr.on('data', (data) => {
    entry.stderrBuffer += data.toString('utf-8');
    const lines = entry.stderrBuffer.split('\n');
    entry.stderrBuffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      emitTextDelta(entry, line);
      if (
        consumeCollapsedStreamDebugLine(line, entry.streamDebug, (message) => {
          logger.debug({ sessionId }, message);
        })
      ) {
        // Stream debug lines indicate model activity — reset timeout.
        entry.activity?.notify();
        continue;
      }
      emitToolProgress(entry, line);
      // Any recognised stderr output (tool progress, model output, etc.)
      // counts as activity and should keep the timeout alive.
      entry.activity?.notify();
      logger.debug({ sessionId }, line);
    }
  });

  proc.on('close', (code) => {
    const tail = entry.stderrBuffer.trim();
    if (tail) {
      emitTextDelta(entry, tail);
      if (
        !consumeCollapsedStreamDebugLine(tail, entry.streamDebug, (message) => {
          logger.debug({ sessionId }, message);
        })
      ) {
        emitToolProgress(entry, tail);
        logger.debug({ sessionId }, tail);
      }
      entry.stderrBuffer = '';
    }
    flushCollapsedStreamDebugSummary(entry.streamDebug, (message) => {
      logger.debug({ sessionId }, message);
    });
    pool.delete(sessionId);
    logger.info({ sessionId, code }, 'Host agent process exited');
  });

  proc.on('error', (err) => {
    pool.delete(sessionId);
    logger.error({ sessionId, error: err }, 'Host agent process error');
  });

  pool.set(sessionId, entry);
  return entry;
}

export function getActiveHostProcessCount(): number {
  return pool.size;
}

export function stopSessionHostProcess(sessionId: string): boolean {
  const entry = pool.get(sessionId);
  if (!entry) return false;
  stopHostProcess(entry);
  pool.delete(sessionId);
  return true;
}

export async function runHostProcess(
  params: ExecutorRequest,
): Promise<ContainerOutput> {
  const {
    sessionId,
    messages,
    chatbotId,
    enableRag,
    model = HYBRIDAI_MODEL,
    agentId = DEFAULT_AGENT_ID,
    channelId = '',
    ralphMaxIterations,
    fullAutoEnabled,
    fullAutoNeverApproveTools,
    scheduledTasks,
    allowedTools,
    blockedTools,
    onTextDelta,
    onToolProgress,
    abortSignal,
    media,
  } = params;

  const { workspacePath } = getSessionPaths(sessionId, agentId);
  const modelRuntime = await resolveModelRuntimeCredentials({
    model,
    chatbotId,
    enableRag,
    agentId,
  });

  if (pool.size >= MAX_CONCURRENT_CONTAINERS && !pool.has(sessionId)) {
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: `Too many active host agent processes (${pool.size}/${MAX_CONCURRENT_CONTAINERS}). Try again later.`,
    };
  }

  cleanupIpc(sessionId);
  ensureSessionDirs(sessionId);

  const input: ContainerInput = {
    sessionId,
    messages,
    chatbotId: modelRuntime.chatbotId,
    enableRag: modelRuntime.enableRag,
    apiKey: modelRuntime.apiKey,
    baseUrl: modelRuntime.baseUrl,
    provider: modelRuntime.provider,
    requestHeaders: modelRuntime.requestHeaders,
    isLocal: modelRuntime.isLocal,
    contextWindow: modelRuntime.contextWindow,
    thinkingFormat: modelRuntime.thinkingFormat,
    gatewayBaseUrl: GATEWAY_BASE_URL,
    gatewayApiToken: GATEWAY_API_TOKEN || undefined,
    model,
    ralphMaxIterations,
    fullAutoEnabled,
    fullAutoNeverApproveTools,
    maxTokens: HYBRIDAI_MAX_TOKENS,
    channelId,
    configuredDiscordChannels: collectConfiguredDiscordChannelIds(channelId),
    scheduledTasks: scheduledTasks?.map((task) => ({
      id: task.id,
      cronExpr: task.cron_expr,
      runAt: task.run_at,
      everyMs: task.every_ms,
      prompt: task.prompt,
      enabled: task.enabled,
      lastRun: task.last_run,
      createdAt: task.created_at,
    })),
    allowedTools,
    blockedTools,
    media,
    mcpServers: MCP_SERVERS,
    webSearch: {
      provider: WEB_SEARCH_PROVIDER,
      fallbackProviders: [...WEB_SEARCH_FALLBACK_PROVIDERS],
      defaultCount: WEB_SEARCH_DEFAULT_COUNT,
      cacheTtlMinutes: WEB_SEARCH_CACHE_TTL_MINUTES,
      searxngBaseUrl: WEB_SEARCH_SEARXNG_BASE_URL,
      tavilySearchDepth: WEB_SEARCH_TAVILY_SEARCH_DEPTH,
    },
  };
  const workerSignature = computeWorkerSignature({
    agentId,
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    requestHeaders: input.requestHeaders,
  });
  const existingEntry = pool.get(sessionId);
  if (existingEntry && existingEntry.workerSignature !== workerSignature) {
    logger.info(
      { sessionId, agentId, provider: input.provider },
      'Worker routing changed; restarting host agent process',
    );
    stopHostProcess(existingEntry);
    pool.delete(sessionId);
  }

  const isNewProcess =
    !pool.has(sessionId) ||
    pool.get(sessionId)?.process.killed ||
    pool.get(sessionId)?.process.exitCode !== null;

  let entry: PoolEntry;
  try {
    entry = getOrSpawnHostProcess(sessionId, agentId);
  } catch (err) {
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: `Host agent spawn error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  entry.workerSignature = workerSignature;

  const activity = createActivityTracker();
  entry.onTextDelta = onTextDelta;
  entry.onToolProgress = onToolProgress;
  entry.activity = activity;

  const onAbort = () => {
    logger.info(
      { sessionId },
      'Interrupt requested, stopping host agent process',
    );
    stopHostProcess(entry);
  };
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) onAbort();
  }

  try {
    if (isNewProcess) {
      entry.process.stdin?.write(`${JSON.stringify(input)}\n`);
    } else {
      writeInput(sessionId, input, { omitApiKey: true });
    }

    const output = await readOutput(sessionId, CONTAINER_TIMEOUT, {
      signal: abortSignal,
      activity,
    });
    remapOutputArtifacts(output, workspacePath);
    if (typeof output.result === 'string')
      output.result = redactSecrets(output.result);
    if (typeof output.error === 'string')
      output.error = redactSecrets(output.error);
    return output;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    flushCollapsedStreamDebugSummary(entry.streamDebug, (message) => {
      logger.debug({ sessionId }, message);
    });
    if (entry.onTextDelta === onTextDelta) entry.onTextDelta = undefined;
    if (entry.onToolProgress === onToolProgress)
      entry.onToolProgress = undefined;
    entry.activity = undefined;
  }
}

export function stopAllHostProcesses(): void {
  for (const entry of pool.values()) {
    stopHostProcess(entry);
  }
  pool.clear();
}

export class HostExecutor {
  exec(params: ExecutorRequest): Promise<ContainerOutput> {
    return runHostProcess(params);
  }

  getWorkspacePath(agentId: string): string {
    ensureAgentDirs(agentId);
    return path.resolve(agentWorkspaceDir(agentId));
  }

  stopSession(sessionId: string): boolean {
    return stopSessionHostProcess(sessionId);
  }

  stopAll(): void {
    stopAllHostProcesses();
  }

  getActiveSessionCount(): number {
    return getActiveHostProcessCount();
  }

  getActiveSessionIds(): string[] {
    return getActiveHostSessionIds();
  }
}
