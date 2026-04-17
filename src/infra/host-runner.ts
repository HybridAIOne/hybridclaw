import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutorRequest } from '../agent/executor-types.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  ADDITIONAL_MOUNTS,
  CONTAINER_BINDS,
  CONTAINER_TIMEOUT,
  CONTEXT_GUARD_COMPACTION_RATIO,
  CONTEXT_GUARD_ENABLED,
  CONTEXT_GUARD_MAX_RETRIES,
  CONTEXT_GUARD_OVERFLOW_RATIO,
  CONTEXT_GUARD_PER_RESULT_SHARE,
  GATEWAY_API_TOKEN,
  GATEWAY_BASE_URL,
  HYBRIDAI_BASE_URL,
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
import { resolveUploadedMediaCacheHostDir } from '../media/uploaded-media-cache.js';
import { withSpan } from '../observability/otel.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import { resolveProviderRequestMaxTokens } from '../providers/request-max-tokens.js';
import { resolveTaskModelPolicies } from '../providers/task-routing.js';
import { resolveConfiguredAdditionalMounts } from '../security/mount-config.js';
import { redactSecrets } from '../security/redact.js';
import type { ContainerInput, ContainerOutput } from '../types/container.js';
import type { PendingApproval, ToolProgressEvent } from '../types/execution.js';
import type { ScheduledTaskInput } from '../types/scheduler.js';
import {
  collectConfiguredDiscordChannelIds,
  remapOutputArtifacts,
  resolveBrowserProfileHostDir,
  resolveDiscordMediaCacheHostDir,
} from './container-runner.js';
import { ensureHostRuntimeReady } from './host-runtime-setup.js';
import { resolveInstallRoot } from './install-root.js';
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
  isStreamActivityLine,
  type StreamDebugState,
} from './stream-debug.js';
import { computeWorkerSignature } from './worker-signature.js';

const IDLE_TIMEOUT_MS = 300_000;
const HOST_CAPACITY_WAIT_MS = 15_000;
const HOST_CAPACITY_POLL_MS = 100;
const TOOL_RESULT_RE =
  /^\[tool\]\s+([a-zA-Z0-9_.-]+)\s+result\s+\((\d+)ms\):\s*(.*)$/;
const TOOL_START_RE = /^\[tool\]\s+([a-zA-Z0-9_.-]+):\s*(.*)$/;
const APPROVAL_RE = /^\[approval\]\s+([A-Za-z0-9+/=]+)$/;
const AGENT_OUTPUT_TIMEOUT_PREFIX = 'Timeout waiting for agent output after ';

function resolveExecutorMaxTokens(params: {
  model: string;
  discoveredMaxTokens?: number;
}): number | undefined {
  return resolveProviderRequestMaxTokens({
    model: params.model,
    discoveredMaxTokens: params.discoveredMaxTokens,
  });
}

function buildHostAllowedRoots(extraRoots: string[] = []): string[] {
  const configured = resolveConfiguredAdditionalMounts({
    binds: CONTAINER_BINDS,
    additionalMounts: ADDITIONAL_MOUNTS,
  });
  for (const warning of configured.warnings) {
    logger.warn({ warning }, 'Configured host-mode allowed root ignored');
  }
  return Array.from(
    new Set([
      os.homedir(),
      process.cwd(),
      os.tmpdir(),
      ...extraRoots.map((entry) => path.resolve(entry)),
      ...configured.mounts.map((mount) => path.resolve(mount.hostPath)),
    ]),
  );
}

function getHostWorkspacePath(params: {
  sessionId: string;
  agentId: string;
  workspacePathOverride?: string;
}): string {
  const trimmed = params.workspacePathOverride?.trim();
  if (trimmed) return path.resolve(trimmed);
  const { workspacePath } = getSessionPaths(params.sessionId, params.agentId);
  return workspacePath;
}

function resolveHostAgentBrowserBinary(): string | undefined {
  const configured = String(process.env.AGENT_BROWSER_BIN || '').trim();
  if (configured) return configured;

  const installRoot = resolveInstallRoot();
  const binName =
    process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser';
  const candidates = [
    path.join(installRoot, 'container', 'node_modules', '.bin', binName),
    path.join(installRoot, 'node_modules', '.bin', binName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface PoolEntry {
  process: ChildProcess;
  sessionId: string;
  startedAt: number;
  stderrBuffer: string;
  stderrHistory: string[];
  streamDebug: StreamDebugState;
  workerSignature: string;
  terminalError: string | null;
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  /** Activity tracker that resets the IPC read timeout on agent progress. */
  activity?: import('./ipc.js').ActivityTracker;
}

const pool = new Map<string, PoolEntry>();
const STDERR_HISTORY_LIMIT = 20;

function rememberStderrLine(entry: PoolEntry, line: string): void {
  entry.stderrHistory.push(line);
  if (entry.stderrHistory.length > STDERR_HISTORY_LIMIT) {
    entry.stderrHistory.splice(
      0,
      entry.stderrHistory.length - STDERR_HISTORY_LIMIT,
    );
  }
}

function summarizeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (typeof code === 'number') return `exit code ${code}`;
  if (signal) return `signal ${signal}`;
  return 'unknown exit status';
}

function formatHostAgentTerminalError(
  entry: PoolEntry,
  params?: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
  },
): string {
  const stderrText = entry.stderrHistory.join('\n');
  const missingPackageMatch = stderrText.match(
    /Cannot find package '([^']+)' imported from /,
  );
  const status = summarizeExit(
    params?.code ?? entry.process.exitCode,
    params?.signal ?? null,
  );

  if (missingPackageMatch) {
    return [
      `Host agent process exited before producing output (${status}).`,
      `Missing runtime dependency: ${missingPackageMatch[1]}.`,
      'Reinstall HybridClaw. If you are running from a source checkout, run `npm run setup` first.',
    ].join('\n');
  }

  const detail = entry.stderrHistory
    .slice(-4)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return detail
    ? `Host agent process exited before producing output (${status}). ${detail}`
    : `Host agent process exited before producing output (${status}). Check the gateway log for stderr details.`;
}

function interruptedHostOutput(): ContainerOutput {
  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: 'Interrupted by user.',
  };
}

async function waitForHostCapacity(
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<'available' | 'aborted' | 'timed_out'> {
  const deadline = Date.now() + HOST_CAPACITY_WAIT_MS;
  while (pool.size >= MAX_CONCURRENT_CONTAINERS && !pool.has(sessionId)) {
    if (abortSignal?.aborted) return 'aborted';
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return 'timed_out';
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(HOST_CAPACITY_POLL_MS, remainingMs)),
    );
  }
  return abortSignal?.aborted ? 'aborted' : 'available';
}

function isStdinWriteInterrupt(
  error: unknown,
  proc: Pick<ChildProcess, 'killed' | 'exitCode'>,
  abortSignal?: AbortSignal,
): boolean {
  if (abortSignal?.aborted) return true;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  return (
    (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') &&
    (proc.killed || proc.exitCode !== null)
  );
}

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

function parseApprovalProgress(line: string): PendingApproval | null {
  const match = line.match(APPROVAL_RE);
  if (!match) return null;
  try {
    const raw = Buffer.from(match[1], 'base64').toString('utf-8');
    const parsed = JSON.parse(raw) as PendingApproval;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.approvalId !== 'string' ||
      typeof parsed.prompt !== 'string' ||
      typeof parsed.intent !== 'string' ||
      typeof parsed.reason !== 'string'
    ) {
      return null;
    }
    return {
      approvalId: parsed.approvalId,
      prompt: redactSecrets(parsed.prompt),
      intent: redactSecrets(parsed.intent),
      reason: redactSecrets(parsed.reason),
      allowSession: parsed.allowSession === true,
      allowAgent: parsed.allowAgent === true,
      allowAll: parsed.allowAll === true,
      expiresAt:
        typeof parsed.expiresAt === 'number' &&
        Number.isFinite(parsed.expiresAt)
          ? parsed.expiresAt
          : null,
    };
  } catch {
    return null;
  }
}

function emitApprovalProgress(entry: PoolEntry, line: string): boolean {
  const approval = parseApprovalProgress(line);
  if (!approval) return false;
  if (!entry.onApprovalProgress) return true;
  try {
    entry.onApprovalProgress(approval);
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Approval progress callback failed',
    );
  }
  return true;
}

function ensureWorkspaceNodeModulesLink(workspacePath: string): void {
  const packageRoot = resolveInstallRoot();
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

function isTimedOutAgentOutput(output: ContainerOutput): boolean {
  return (
    output.status === 'error' &&
    typeof output.error === 'string' &&
    output.error.startsWith(AGENT_OUTPUT_TIMEOUT_PREFIX)
  );
}

function getOrSpawnHostProcess(
  params: Pick<
    ExecutorRequest,
    | 'sessionId'
    | 'agentId'
    | 'workspacePathOverride'
    | 'workspaceDisplayRootOverride'
    | 'bashProxy'
  >,
): PoolEntry {
  const sessionId = params.sessionId;
  const agentId = params.agentId || DEFAULT_AGENT_ID;
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
  const { ipcPath } = getSessionPaths(sessionId, agentId);
  const workspacePath = getHostWorkspacePath({
    sessionId,
    agentId,
    workspacePathOverride: params.workspacePathOverride,
  });
  fs.mkdirSync(workspacePath, { recursive: true });
  ensureWorkspaceNodeModulesLink(workspacePath);
  const mediaCacheHostPath = resolveDiscordMediaCacheHostDir();
  const uploadedMediaCacheHostPath = resolveUploadedMediaCacheHostDir();
  fs.mkdirSync(mediaCacheHostPath, { recursive: true });
  fs.mkdirSync(uploadedMediaCacheHostPath, { recursive: true });

  const runtime = ensureHostRuntimeReady({
    commandName: 'hybridclaw',
    required: true,
  });
  if (!runtime) {
    throw new Error('Host runtime unexpectedly unavailable.');
  }
  const agentBrowserBin = resolveHostAgentBrowserBinary();
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
    HYBRIDCLAW_AGENT_ID: agentId,
    HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspacePath,
    HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT:
      params.workspaceDisplayRootOverride?.trim() || '/workspace',
    HYBRIDCLAW_AGENT_ALLOWED_ROOTS: JSON.stringify(
      buildHostAllowedRoots([workspacePath]),
    ),
    HYBRIDCLAW_AGENT_MEDIA_ROOT: mediaCacheHostPath,
    HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT: uploadedMediaCacheHostPath,
    HYBRIDCLAW_AGENT_IPC_DIR: ipcPath,
    BROWSER_SHARED_PROFILE_DIR: resolveBrowserProfileHostDir(),
    AGENT_BROWSER_BIN: agentBrowserBin,
  };
  if (params.bashProxy?.mode === 'docker-exec') {
    env.HYBRIDCLAW_BASH_DOCKER_CONTAINER = params.bashProxy.containerName;
    env.HYBRIDCLAW_BASH_DOCKER_CWD = params.bashProxy.cwd || '/app';
  }

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
    stderrHistory: [],
    streamDebug: createStreamDebugState(),
    workerSignature: '',
    terminalError: null,
  };

  proc.stderr.on('data', (data) => {
    entry.stderrBuffer += data.toString('utf-8');
    const lines = entry.stderrBuffer.split('\n');
    entry.stderrBuffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      rememberStderrLine(entry, line);
      emitTextDelta(entry, line);
      if (isStreamActivityLine(line)) {
        entry.activity?.notify();
        continue;
      }
      if (
        consumeCollapsedStreamDebugLine(line, entry.streamDebug, (message) => {
          logger.debug({ sessionId }, message);
        })
      ) {
        // Stream debug lines indicate model activity — reset timeout.
        entry.activity?.notify();
        continue;
      }
      if (emitApprovalProgress(entry, line)) {
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

  proc.on('close', (code, signal) => {
    const tail = entry.stderrBuffer.trim();
    if (tail) {
      rememberStderrLine(entry, tail);
      emitTextDelta(entry, tail);
      if (isStreamActivityLine(tail)) {
        entry.activity?.notify();
      } else if (
        !consumeCollapsedStreamDebugLine(tail, entry.streamDebug, (message) => {
          logger.debug({ sessionId }, message);
        })
      ) {
        if (!emitApprovalProgress(entry, tail)) {
          emitToolProgress(entry, tail);
          logger.debug({ sessionId }, tail);
        }
      }
      entry.stderrBuffer = '';
    }
    entry.terminalError = formatHostAgentTerminalError(entry, { code, signal });
    flushCollapsedStreamDebugSummary(entry.streamDebug, (message) => {
      logger.debug({ sessionId }, message);
    });
    pool.delete(sessionId);
    logger.info({ sessionId, code, signal }, 'Host agent process exited');
  });

  proc.on('error', (err) => {
    entry.terminalError = `Host agent process failed before producing output: ${err instanceof Error ? err.message : String(err)}`;
    pool.delete(sessionId);
    logger.error({ sessionId, error: err }, 'Host agent process error');
  });

  proc.stdin?.on('error', (err) => {
    if (isStdinWriteInterrupt(err, proc)) {
      logger.debug(
        { sessionId, error: err },
        'Ignoring host agent stdin error after process shutdown',
      );
      return;
    }
    logger.error({ sessionId, error: err }, 'Host agent stdin error');
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
  return withSpan(
    'hybridclaw.host.execute',
    {
      'hybridclaw.session_id': params.sessionId,
      'hybridclaw.agent_id': params.agentId || '',
      'hybridclaw.model': params.model || '',
    },
    async () => runHostProcessInner(params),
  );
}

async function runHostProcessInner(
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
    skipContainerSystemPrompt,
    scheduledTasks,
    allowedTools,
    blockedTools,
    onTextDelta,
    onToolProgress,
    onApprovalProgress,
    abortSignal,
    media,
    audioTranscriptsPrepended,
    pluginTools,
    maxWallClockMs,
    inactivityTimeoutMs,
  } = params;

  const workspacePath = getHostWorkspacePath({
    sessionId,
    agentId,
    workspacePathOverride: params.workspacePathOverride,
  });
  const modelRuntime = await resolveModelRuntimeCredentials({
    model,
    chatbotId,
    enableRag,
    agentId,
  });
  const taskModels = await resolveTaskModelPolicies({
    agentId,
    chatbotId: modelRuntime.chatbotId,
    sessionModel: model,
  });

  if (pool.size >= MAX_CONCURRENT_CONTAINERS && !pool.has(sessionId)) {
    const capacityState = await waitForHostCapacity(sessionId, abortSignal);
    if (capacityState === 'aborted') {
      return interruptedHostOutput();
    }
    if (capacityState === 'timed_out') {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Too many active host agent processes (${pool.size}/${MAX_CONCURRENT_CONTAINERS}) after waiting ${HOST_CAPACITY_WAIT_MS}ms. Try again later.`,
      };
    }
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
    skipContainerSystemPrompt,
    streamTextDeltas: Boolean(onTextDelta),
    maxTokens: resolveExecutorMaxTokens({
      model,
      discoveredMaxTokens: modelRuntime.maxTokens,
    }),
    channelId,
    configuredDiscordChannels: collectConfiguredDiscordChannelIds(channelId),
    scheduledTasks: scheduledTasks?.map(
      (task): ScheduledTaskInput => ({
        id: task.id,
        channelId: task.channel_id,
        cronExpr: task.cron_expr,
        runAt: task.run_at,
        everyMs: task.every_ms,
        prompt: task.prompt,
        enabled: task.enabled,
        lastRun: task.last_run,
        createdAt: task.created_at,
      }),
    ),
    allowedTools,
    blockedTools,
    media,
    audioTranscriptsPrepended,
    pluginTools,
    mcpServers: MCP_SERVERS,
    taskModels,
    contextGuard: {
      enabled: CONTEXT_GUARD_ENABLED,
      perResultShare: CONTEXT_GUARD_PER_RESULT_SHARE,
      compactionRatio: CONTEXT_GUARD_COMPACTION_RATIO,
      overflowRatio: CONTEXT_GUARD_OVERFLOW_RATIO,
      maxRetries: CONTEXT_GUARD_MAX_RETRIES,
    },
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
    taskModels: input.taskModels,
    workspacePathOverride: params.workspacePathOverride,
    workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
    bashProxy: params.bashProxy,
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
    entry = getOrSpawnHostProcess({
      sessionId,
      agentId,
      workspacePathOverride: params.workspacePathOverride,
      workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
      bashProxy: params.bashProxy,
    });
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
  entry.onApprovalProgress = onApprovalProgress;
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
    if (abortSignal?.aborted) {
      return interruptedHostOutput();
    }
    if (isNewProcess) {
      try {
        entry.process.stdin?.write(`${JSON.stringify(input)}\n`);
      } catch (err) {
        if (isStdinWriteInterrupt(err, entry.process, abortSignal)) {
          logger.info(
            { sessionId, error: err },
            'Host agent input write interrupted by process shutdown',
          );
          return interruptedHostOutput();
        }
        throw err;
      }
    } else {
      writeInput(sessionId, input, { omitApiKey: true });
    }

    const output = await readOutput(
      sessionId,
      inactivityTimeoutMs === undefined
        ? CONTAINER_TIMEOUT
        : inactivityTimeoutMs,
      {
        signal: abortSignal,
        activity,
        maxWallClockMs,
        terminalError: () => entry.terminalError,
      },
    );
    if (isTimedOutAgentOutput(output)) {
      logger.warn(
        { sessionId },
        'Agent output timed out; stopping stuck host agent process',
      );
      stopSessionHostProcess(sessionId);
    }
    remapOutputArtifacts(output, workspacePath);
    if (typeof output.result === 'string')
      output.result = redactSecrets(output.result);
    if (typeof output.error === 'string')
      output.error = redactSecrets(output.error);
    if (output.pendingApproval) {
      output.pendingApproval = {
        ...output.pendingApproval,
        prompt: redactSecrets(output.pendingApproval.prompt),
        intent: redactSecrets(output.pendingApproval.intent),
        reason: redactSecrets(output.pendingApproval.reason),
      };
    }
    return output;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    flushCollapsedStreamDebugSummary(entry.streamDebug, (message) => {
      logger.debug({ sessionId }, message);
    });
    if (entry.onTextDelta === onTextDelta) entry.onTextDelta = undefined;
    if (entry.onToolProgress === onToolProgress)
      entry.onToolProgress = undefined;
    if (entry.onApprovalProgress === onApprovalProgress) {
      entry.onApprovalProgress = undefined;
    }
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
