/**
 * Container Runner — manages a pool of persistent containers.
 * Containers stay alive between requests and exit after an idle timeout.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  ADDITIONAL_MOUNTS,
  CONTAINER_BINDS,
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_MEMORY_SWAP,
  CONTAINER_NETWORK,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  DISCORD_FREE_RESPONSE_CHANNELS,
  DISCORD_GUILDS,
  DISCORD_SEND_ALLOWED_CHANNEL_IDS,
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
import { resolveConfiguredAdditionalMounts } from '../security/mount-config.js';
import { validateAdditionalMounts } from '../security/mount-security.js';
import type {
  AdditionalMount,
  ArtifactMetadata,
  ChatMessage,
  ContainerInput,
  ContainerOutput,
  MediaContextItem,
  ScheduledTask,
  ToolProgressEvent,
} from '../types.js';
import {
  agentWorkspaceDir,
  cleanupIpc,
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

const IDLE_TIMEOUT_MS = 300_000; // 5 minutes — matches container-side default

interface PoolEntry {
  process: ChildProcess;
  containerName: string;
  sessionId: string;
  startedAt: number;
  stderrBuffer: string;
  streamDebug: StreamDebugState;
  authSignature: string;
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
}

interface ContainerPathAliasMount {
  hostPaths: string[];
  containerPath: string;
  readonly: boolean;
}

const pool = new Map<string, PoolEntry>();
const TOOL_RESULT_RE =
  /^\[tool\]\s+([a-zA-Z0-9_.-]+)\s+result\s+\((\d+)ms\):\s*(.*)$/;
const TOOL_START_RE = /^\[tool\]\s+([a-zA-Z0-9_.-]+):\s*(.*)$/;
const CONTAINER_WORKSPACE_ROOT = '/workspace';
const CONTAINER_DISCORD_MEDIA_CACHE_ROOT = '/discord-media-cache';

function computeAuthSignature(
  apiKey: string,
  requestHeaders: Record<string, string> | undefined,
): string {
  const normalizedHeaders = Object.entries(requestHeaders || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);
  return JSON.stringify({ apiKey, requestHeaders: normalizedHeaders });
}

export function collectConfiguredDiscordChannelIds(
  currentChannelId: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string | undefined | null) => {
    const id = String(value || '').trim();
    if (!/^\d{16,22}$/.test(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  add(currentChannelId);
  for (const id of DISCORD_SEND_ALLOWED_CHANNEL_IDS) add(id);
  for (const id of DISCORD_FREE_RESPONSE_CHANNELS) add(id);
  for (const guildConfig of Object.values(DISCORD_GUILDS)) {
    for (const channelId of Object.keys(guildConfig.channels || {}))
      add(channelId);
  }
  return out;
}

export function resolveDiscordMediaCacheHostDir(): string {
  return path.resolve(path.join(DATA_DIR, 'discord-media-cache'));
}

function emitTextDelta(entry: PoolEntry, line: string): void {
  const callback = entry.onTextDelta;
  if (!callback) return;
  const delta = decodeStreamDelta(line);
  if (delta == null) return;

  try {
    if (!delta) return;
    callback(delta);
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
  if (startMatch) {
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
}

export function getActiveContainerCount(): number {
  return pool.size;
}

export function stopSessionContainer(sessionId: string): boolean {
  const entry = pool.get(sessionId);
  if (!entry) return false;
  logger.info(
    { sessionId, containerName: entry.containerName },
    'Stopping session container',
  );
  stopContainer(entry.containerName);
  pool.delete(sessionId);
  return true;
}

function stopContainer(containerName: string): void {
  const proc = spawn('docker', ['stop', containerName], { stdio: 'ignore' });
  proc.on('error', (err) => {
    logger.debug({ containerName, err }, 'Failed to stop container');
  });
}

function resolveArtifactHostPath(
  rawPath: string,
  workspacePath: string,
): string | null {
  const input = String(rawPath || '').trim();
  if (!input) return null;
  const normalized = input.replace(/\\/g, '/');
  const workspaceRoot = path.resolve(workspacePath);

  if (path.posix.isAbsolute(normalized)) {
    const cleanAbs = path.posix.normalize(normalized);
    if (
      cleanAbs !== CONTAINER_WORKSPACE_ROOT &&
      !cleanAbs.startsWith(`${CONTAINER_WORKSPACE_ROOT}/`)
    ) {
      return null;
    }
    const rel = cleanAbs
      .slice(CONTAINER_WORKSPACE_ROOT.length)
      .replace(/^\/+/, '');
    const resolved = path.resolve(workspaceRoot, rel);
    if (
      resolved === workspaceRoot ||
      resolved.startsWith(`${workspaceRoot}${path.sep}`)
    ) {
      return resolved;
    }
    return null;
  }

  const cleanRel = path.posix.normalize(normalized);
  if (cleanRel === '..' || cleanRel.startsWith('../')) return null;
  const resolved = path.resolve(workspaceRoot, cleanRel);
  if (
    resolved === workspaceRoot ||
    resolved.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    return resolved;
  }
  return null;
}

export function remapOutputArtifacts(
  output: ContainerOutput,
  workspacePath: string,
): void {
  if (!Array.isArray(output.artifacts) || output.artifacts.length === 0) return;
  const mapped: ArtifactMetadata[] = [];
  for (const artifact of output.artifacts) {
    const raw = artifact as Partial<ArtifactMetadata>;
    const hostPath = resolveArtifactHostPath(
      String(raw.path || ''),
      workspacePath,
    );
    if (!hostPath) continue;
    const filename =
      String(raw.filename || '').trim() || path.basename(hostPath);
    const mimeType =
      String(raw.mimeType || '').trim() || 'application/octet-stream';
    mapped.push({ path: hostPath, filename, mimeType });
  }
  if (mapped.length === 0) {
    delete output.artifacts;
    return;
  }
  output.artifacts = mapped;
}

function remapHostBaseUrlForContainer(baseUrl: string): string {
  return baseUrl.replace(
    /\/\/(localhost|127\.0\.0\.1)([:/])/,
    '//host.docker.internal$2',
  );
}

/**
 * Get or spawn a persistent container for a session.
 */
function getOrSpawnContainer(sessionId: string, agentId: string): PoolEntry {
  const existing = pool.get(sessionId);
  if (
    existing &&
    !existing.process.killed &&
    existing.process.exitCode === null
  ) {
    logger.debug(
      { sessionId, containerName: existing.containerName },
      'Reusing container',
    );
    return existing;
  }

  // Clean up stale entry
  if (existing) {
    pool.delete(sessionId);
  }

  ensureSessionDirs(sessionId);
  ensureAgentDirs(agentId);
  const { ipcPath, workspacePath } = getSessionPaths(sessionId, agentId);
  const mediaCacheHostPath = resolveDiscordMediaCacheHostDir();
  fs.mkdirSync(mediaCacheHostPath, { recursive: true });
  const containerName = `hybridclaw-${sessionId.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

  const args = [
    'run',
    '--rm',
    '-i',
    '--name',
    containerName,
    '--memory',
    CONTAINER_MEMORY,
    ...(CONTAINER_MEMORY_SWAP.trim()
      ? ['--memory-swap', CONTAINER_MEMORY_SWAP]
      : []),
    `--cpus=${CONTAINER_CPUS}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    `--network=${CONTAINER_NETWORK || 'bridge'}`,
    '--tmpfs',
    '/tmp:rw,nosuid,size=512m',
    '-v',
    `${workspacePath}:/workspace:rw`,
    '-v',
    `${ipcPath}:/ipc:rw`,
    '-v',
    `${mediaCacheHostPath}:${CONTAINER_DISCORD_MEDIA_CACHE_ROOT}:ro`,
    '-e',
    `HYBRIDAI_BASE_URL=${HYBRIDAI_BASE_URL}`,
    '-e',
    `HYBRIDAI_MODEL=${HYBRIDAI_MODEL}`,
    '-e',
    `CONTAINER_IDLE_TIMEOUT=${IDLE_TIMEOUT_MS}`,
    '-e',
    `HYBRIDCLAW_RETRY_ENABLED=${PROACTIVE_AUTO_RETRY_ENABLED ? 'true' : 'false'}`,
    '-e',
    `HYBRIDCLAW_RETRY_MAX_ATTEMPTS=${PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS}`,
    '-e',
    `HYBRIDCLAW_RETRY_BASE_DELAY_MS=${PROACTIVE_AUTO_RETRY_BASE_DELAY_MS}`,
    '-e',
    `HYBRIDCLAW_RETRY_MAX_DELAY_MS=${PROACTIVE_AUTO_RETRY_MAX_DELAY_MS}`,
    '-e',
    `HYBRIDCLAW_RALPH_MAX_ITERATIONS=${PROACTIVE_RALPH_MAX_ITERATIONS}`,
    '-e',
    `HYBRIDCLAW_WEB_SEARCH_PROVIDER=${WEB_SEARCH_PROVIDER}`,
    '-e',
    `HYBRIDCLAW_WEB_SEARCH_FALLBACK_PROVIDERS=${WEB_SEARCH_FALLBACK_PROVIDERS.join(',')}`,
    '-e',
    `HYBRIDCLAW_WEB_SEARCH_DEFAULT_COUNT=${WEB_SEARCH_DEFAULT_COUNT}`,
    '-e',
    `HYBRIDCLAW_WEB_SEARCH_CACHE_TTL_MINUTES=${WEB_SEARCH_CACHE_TTL_MINUTES}`,
    '-e',
    `HYBRIDCLAW_WEB_SEARCH_TAVILY_SEARCH_DEPTH=${WEB_SEARCH_TAVILY_SEARCH_DEPTH}`,
    '-e',
    `SEARXNG_BASE_URL=${WEB_SEARCH_SEARXNG_BASE_URL}`,
    '-e',
    'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
  ];

  for (const [name, value] of [
    ['BRAVE_API_KEY', process.env.BRAVE_API_KEY || ''],
    ['PERPLEXITY_API_KEY', process.env.PERPLEXITY_API_KEY || ''],
    ['TAVILY_API_KEY', process.env.TAVILY_API_KEY || ''],
  ] as const) {
    if (!value) continue;
    args.push('-e', `${name}=${value}`);
  }

  // Run as host user so bind-mount file ownership matches
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/workspace/.hybridclaw-runtime/home');
  }

  // Validate and append additional mounts
  const configuredMounts = resolveConfiguredAdditionalMounts({
    binds: CONTAINER_BINDS,
    additionalMounts: ADDITIONAL_MOUNTS,
  });
  for (const warning of configuredMounts.warnings) {
    logger.warn({ warning }, 'Configured container bind ignored');
  }
  if (configuredMounts.mounts.length > 0) {
    const validated = validateAdditionalMounts(
      configuredMounts.mounts as AdditionalMount[],
    );
    const mountAliases: ContainerPathAliasMount[] = [];
    for (const m of validated) {
      args.push(
        '-v',
        `${m.hostPath}:${m.containerPath}:${m.readonly ? 'ro' : 'rw'}`,
      );
      mountAliases.push({
        hostPaths: Array.from(new Set([m.expandedHostPath, m.hostPath])),
        containerPath: m.containerPath,
        readonly: m.readonly,
      });
    }
    if (mountAliases.length > 0) {
      args.push(
        '-e',
        `HYBRIDCLAW_AGENT_EXTRA_MOUNTS=${JSON.stringify(mountAliases)}`,
      );
    }
  }

  args.push(CONTAINER_IMAGE);

  logger.info({ sessionId, containerName }, 'Spawning persistent container');

  const proc = spawn('docker', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entry: PoolEntry = {
    process: proc,
    containerName,
    sessionId,
    startedAt: Date.now(),
    stderrBuffer: '',
    streamDebug: createStreamDebugState(),
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
      if (
        consumeCollapsedStreamDebugLine(line, entry.streamDebug, (message) => {
          logger.debug({ container: containerName }, message);
        })
      ) {
        continue;
      }
      logger.debug({ container: containerName }, line);
      emitToolProgress(entry, line);
    }
  });

  proc.on('close', (code) => {
    const tail = entry.stderrBuffer.trim();
    if (tail) {
      emitTextDelta(entry, tail);
      if (
        !consumeCollapsedStreamDebugLine(tail, entry.streamDebug, (message) => {
          logger.debug({ container: containerName }, message);
        })
      ) {
        logger.debug({ container: containerName }, tail);
        emitToolProgress(entry, tail);
      }
      entry.stderrBuffer = '';
    }
    flushCollapsedStreamDebugSummary(entry.streamDebug, (message) => {
      logger.debug({ container: containerName }, message);
    });
    pool.delete(sessionId);
    logger.info({ sessionId, containerName, code }, 'Container exited');
  });

  proc.on('error', (err) => {
    pool.delete(sessionId);
    logger.error({ sessionId, containerName, error: err }, 'Container error');
  });

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
  blockedTools?: string[],
  onTextDelta?: (delta: string) => void,
  onToolProgress?: (event: ToolProgressEvent) => void,
  abortSignal?: AbortSignal,
  media?: MediaContextItem[],
): Promise<ContainerOutput> {
  const { workspacePath } = getSessionPaths(sessionId, agentId);
  const modelRuntime = await resolveModelRuntimeCredentials({
    model,
    chatbotId,
    enableRag,
  });
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

  const input: ContainerInput = {
    sessionId,
    messages,
    chatbotId: modelRuntime.chatbotId,
    enableRag: modelRuntime.enableRag,
    apiKey: modelRuntime.apiKey,
    baseUrl: remapHostBaseUrlForContainer(modelRuntime.baseUrl),
    provider: modelRuntime.provider,
    requestHeaders: modelRuntime.requestHeaders,
    gatewayBaseUrl: remapHostBaseUrlForContainer(GATEWAY_BASE_URL),
    gatewayApiToken: GATEWAY_API_TOKEN || undefined,
    model,
    maxTokens: HYBRIDAI_MAX_TOKENS,
    channelId,
    configuredDiscordChannels: collectConfiguredDiscordChannelIds(channelId),
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
      { sessionId, containerName: existingEntry.containerName },
      'Model auth changed; restarting persistent container',
    );
    stopContainer(existingEntry.containerName);
    pool.delete(sessionId);
  }

  const isNewContainer =
    !pool.has(sessionId) ||
    pool.get(sessionId)?.process.killed ||
    pool.get(sessionId)?.process.exitCode !== null;

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
  entry.authSignature = authSignature;
  entry.onTextDelta = onTextDelta;
  entry.onToolProgress = onToolProgress;
  const onAbort = () => {
    logger.info(
      { sessionId, containerName: entry.containerName },
      'Interrupt requested, stopping container',
    );
    stopContainer(entry.containerName);
  };
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) onAbort();
  }

  try {
    if (isNewContainer) {
      // First request: send full input (including apiKey) via stdin — no file on disk.
      // Write JSON on a single line followed by newline as delimiter.
      // Do NOT end stdin — closing stdin can cause docker -i to terminate the container.
      entry.process.stdin?.write(`${JSON.stringify(input)}\n`);
    } else {
      // Follow-up requests: write to IPC file, omitting apiKey
      writeInput(sessionId, input, { omitApiKey: true });
    }

    // Wait for the container to produce output
    const output = await readOutput(sessionId, CONTAINER_TIMEOUT, {
      signal: abortSignal,
    });
    remapOutputArtifacts(output, workspacePath);
    const duration = Date.now() - startTime;

    logger.info(
      {
        sessionId,
        containerName: entry.containerName,
        duration,
        status: output.status,
        toolsUsed: output.toolsUsed,
      },
      'Request completed',
    );

    return output;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    flushCollapsedStreamDebugSummary(entry.streamDebug, (message) => {
      logger.debug({ container: entry.containerName }, message);
    });
    if (entry.onTextDelta === onTextDelta) {
      entry.onTextDelta = undefined;
    }
    if (entry.onToolProgress === onToolProgress) {
      entry.onToolProgress = undefined;
    }
  }
}

/**
 * Stop all containers (for graceful shutdown).
 */
export function stopAllContainers(): void {
  for (const [sessionId, entry] of pool) {
    logger.info(
      { sessionId, containerName: entry.containerName },
      'Stopping container (shutdown)',
    );
    stopContainer(entry.containerName);
  }
  pool.clear();
}

export class ContainerExecutor {
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
    return runContainer(
      params.sessionId,
      params.messages,
      params.chatbotId,
      params.enableRag,
      params.model,
      params.agentId,
      params.channelId,
      params.scheduledTasks,
      params.allowedTools,
      params.blockedTools,
      params.onTextDelta,
      params.onToolProgress,
      params.abortSignal,
      params.media,
    );
  }

  getWorkspacePath(agentId: string): string {
    ensureAgentDirs(agentId);
    return path.resolve(agentWorkspaceDir(agentId));
  }

  stopSession(sessionId: string): boolean {
    return stopSessionContainer(sessionId);
  }

  stopAll(): void {
    stopAllContainers();
  }

  getActiveSessionCount(): number {
    return getActiveContainerCount();
  }
}
