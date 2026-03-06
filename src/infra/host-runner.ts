import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTAINER_TIMEOUT,
  GATEWAY_API_TOKEN,
  GATEWAY_BASE_URL,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_MAX_TOKENS,
  HYBRIDAI_MODEL,
  MAX_CONCURRENT_CONTAINERS,
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
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
  MediaContextItem,
  ScheduledTask,
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
  ensureAgentDirs,
  ensureSessionDirs,
  getSessionPaths,
  readOutput,
  writeInput,
} from './ipc.js';

const IDLE_TIMEOUT_MS = 300_000;
const TOOL_RESULT_RE =
  /^\[tool\]\s+([a-zA-Z0-9_.-]+)\s+result\s+\((\d+)ms\):\s*(.*)$/;
const TOOL_START_RE = /^\[tool\]\s+([a-zA-Z0-9_.-]+):\s*(.*)$/;
const STREAM_DELTA_RE = /^\[stream\]\s+([A-Za-z0-9+/=]+)$/;

interface PoolEntry {
  process: ChildProcess;
  sessionId: string;
  startedAt: number;
  stderrBuffer: string;
  authSignature: string;
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
}

const pool = new Map<string, PoolEntry>();

function computeAuthSignature(
  apiKey: string,
  requestHeaders: Record<string, string> | undefined,
): string {
  const normalizedHeaders = Object.entries(requestHeaders || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);
  return JSON.stringify({ apiKey, requestHeaders: normalizedHeaders });
}

function emitTextDelta(entry: PoolEntry, line: string): void {
  const callback = entry.onTextDelta;
  if (!callback) return;
  const match = line.match(STREAM_DELTA_RE);
  if (!match) return;

  try {
    const delta = Buffer.from(match[1], 'base64').toString('utf-8');
    if (delta) callback(delta);
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
        preview: resultMatch[3],
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
      preview: startMatch[2],
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
    authSignature: '',
  };

  proc.stderr.on('data', (data) => {
    entry.stderrBuffer += data.toString('utf-8');
    const lines = entry.stderrBuffer.split('\n');
    entry.stderrBuffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      emitTextDelta(entry, line);
      emitToolProgress(entry, line);
      logger.debug({ sessionId }, line);
    }
  });

  proc.on('close', (code) => {
    const tail = entry.stderrBuffer.trim();
    if (tail) {
      emitTextDelta(entry, tail);
      emitToolProgress(entry, tail);
      logger.debug({ sessionId }, tail);
      entry.stderrBuffer = '';
    }
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

export async function runHostProcess(params: {
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  model?: string;
  agentId?: string;
  channelId?: string;
  scheduledTasks?: ScheduledTask[];
  allowedTools?: string[];
  blockedTools?: string[];
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  abortSignal?: AbortSignal;
  media?: MediaContextItem[];
}): Promise<ContainerOutput> {
  const {
    sessionId,
    messages,
    chatbotId,
    enableRag,
    model = HYBRIDAI_MODEL,
    agentId = chatbotId,
    channelId = '',
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
    gatewayBaseUrl: GATEWAY_BASE_URL,
    gatewayApiToken: GATEWAY_API_TOKEN || undefined,
    model,
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
    webSearch: {
      provider: WEB_SEARCH_PROVIDER,
      fallbackProviders: [...WEB_SEARCH_FALLBACK_PROVIDERS],
      defaultCount: WEB_SEARCH_DEFAULT_COUNT,
      cacheTtlMinutes: WEB_SEARCH_CACHE_TTL_MINUTES,
      searxngBaseUrl: WEB_SEARCH_SEARXNG_BASE_URL,
      tavilySearchDepth: WEB_SEARCH_TAVILY_SEARCH_DEPTH,
    },
  };
  const authSignature = computeAuthSignature(
    input.apiKey,
    input.requestHeaders,
  );
  const existingEntry = pool.get(sessionId);
  if (existingEntry && existingEntry.authSignature !== authSignature) {
    logger.info(
      { sessionId },
      'Model auth changed; restarting host agent process',
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
  entry.authSignature = authSignature;

  entry.onTextDelta = onTextDelta;
  entry.onToolProgress = onToolProgress;

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
    });
    remapOutputArtifacts(output, workspacePath);
    return output;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    if (entry.onTextDelta === onTextDelta) entry.onTextDelta = undefined;
    if (entry.onToolProgress === onToolProgress)
      entry.onToolProgress = undefined;
  }
}

export function stopAllHostProcesses(): void {
  for (const entry of pool.values()) {
    stopHostProcess(entry);
  }
  pool.clear();
}

export class HostExecutor {
  exec(params: {
    sessionId: string;
    messages: ChatMessage[];
    chatbotId: string;
    enableRag: boolean;
    model?: string;
    agentId?: string;
    channelId?: string;
    scheduledTasks?: ScheduledTask[];
    allowedTools?: string[];
    blockedTools?: string[];
    onTextDelta?: (delta: string) => void;
    onToolProgress?: (event: ToolProgressEvent) => void;
    abortSignal?: AbortSignal;
    media?: MediaContextItem[];
  }): Promise<ContainerOutput> {
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
}
