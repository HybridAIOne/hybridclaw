/**
 * Container Runner — manages a pool of persistent containers.
 * Containers stay alive between requests and exit after an idle timeout.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutorRequest } from '../agent/executor-types.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { resolveGoogleWorkspaceRuntimeEnv } from '../auth/google-auth.js';
import { getBrowserProfileDir } from '../browser/browser-login.js';
import { collectActiveMessageToolChannelKinds } from '../channels/message-tool-advertising.js';
import {
  ADDITIONAL_MOUNTS,
  BRAVE_API_KEY,
  CONTAINER_BINDS,
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_MEMORY_SWAP,
  CONTAINER_NETWORK,
  CONTAINER_PERSIST_BASH_STATE,
  CONTAINER_TIMEOUT,
  CONTAINER_WARM_POOL,
  CONTEXT_GUARD_COMPACTION_RATIO,
  CONTEXT_GUARD_ENABLED,
  CONTEXT_GUARD_MAX_RETRIES,
  CONTEXT_GUARD_OVERFLOW_RATIO,
  CONTEXT_GUARD_PER_RESULT_SHARE,
  DATA_DIR,
  DISCORD_FREE_RESPONSE_CHANNELS,
  DISCORD_GUILDS,
  DISCORD_SEND_ALLOWED_CHANNEL_IDS,
  GATEWAY_API_TOKEN,
  GATEWAY_BASE_URL,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_MODEL,
  MAX_CONCURRENT_CONTAINERS,
  MCP_SERVERS,
  PERPLEXITY_API_KEY,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_RALPH_MAX_ITERATIONS,
  TAVILY_API_KEY,
  WEB_SEARCH_CACHE_TTL_MINUTES,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_FALLBACK_PROVIDERS,
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_SEARXNG_BASE_URL,
  WEB_SEARCH_TAVILY_SEARCH_DEPTH,
} from '../config/config.js';
import { GATEWAY_DEBUG_MODEL_RESPONSES_ENV } from '../gateway/gateway-lifecycle.js';
import { logger } from '../logger.js';
import { resolveUploadedMediaCacheHostDir } from '../media/uploaded-media-cache.js';
import { withSpan } from '../observability/otel.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import { resolveProviderRequestMaxTokens } from '../providers/request-max-tokens.js';
import { resolveTaskModelPolicies } from '../providers/task-routing.js';
import { resolveConfiguredAdditionalMounts } from '../security/mount-config.js';
import { validateAdditionalMounts } from '../security/mount-security.js';
import { redactCredentialSecrets } from '../security/redact.js';
import type { ContainerInput, ContainerOutput } from '../types/container.js';
import {
  type ArtifactMetadata,
  normalizeEscalationTarget,
  type PendingApproval,
  type ToolProgressEvent,
} from '../types/execution.js';
import type { ScheduledTaskInput } from '../types/scheduler.js';
import type { AdditionalMount } from '../types/security.js';
import { ensureWorkspaceNodeModulesLink } from '../workspace.js';
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
import { consumeModelResponseDebugFileLine } from './model-response-debug.js';
import {
  consumeCollapsedStreamDebugLine,
  createStreamDebugState,
  decodeStreamDelta,
  decodeThinkingDelta,
  flushCollapsedStreamDebugSummary,
  isStreamActivityLine,
  isThinkingDeltaLine,
  type StreamDebugState,
} from './stream-debug.js';
import {
  normalizeWarmProcessPoolConfig,
  WarmProcessPool,
  type WarmProcessPoolEntry,
} from './warm-process-pool.js';
import { computeWorkerSignature } from './worker-signature.js';

const IDLE_TIMEOUT_MS = 300_000; // 5 minutes — matches container-side default

function resolveExecutorMaxTokens(params: {
  model: string;
  discoveredMaxTokens?: number;
}): number | undefined {
  return resolveProviderRequestMaxTokens({
    model: params.model,
    discoveredMaxTokens: params.discoveredMaxTokens,
  });
}

interface PoolEntry extends WarmProcessPoolEntry {
  process: ChildProcess;
  containerName: string;
  sessionId: string;
  ipcSessionId: string;
  agentId: string;
  startedAt: number;
  lastUsedAt: number;
  warm: boolean;
  readyForInputAt: number | null;
  pendingColdStartProbeStartedAt: number | null;
  stderrBuffer: string;
  stderrHistory: string[];
  streamDebug: StreamDebugState;
  workerSignature: string;
  terminalError: string | null;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  activity?: import('./ipc.js').ActivityTracker;
}

interface ContainerPathAliasMount {
  hostPaths: string[];
  containerPath: string;
  readonly: boolean;
}

const pool = new Map<string, PoolEntry>();
const warmPool = new WarmProcessPool<PoolEntry>(
  normalizeWarmProcessPoolConfig({
    ...CONTAINER_WARM_POOL,
    memoryPressureRssBytes:
      CONTAINER_WARM_POOL.memoryPressureRssMb * 1024 * 1024,
  }),
);
const TOOL_RESULT_RE =
  /^\[tool\]\s+([a-zA-Z0-9_.-]+)\s+result\s+\((\d+)ms\):\s*(.*)$/;
const TOOL_START_RE = /^\[tool\]\s+([a-zA-Z0-9_.-]+):\s*(.*)$/;
const APPROVAL_RE = /^\[approval\]\s+([A-Za-z0-9+/=]+)$/;
const CONTAINER_WORKSPACE_ROOT = '/workspace';
const CONTAINER_APP_NODE_MODULES = '/app/node_modules';
const CONTAINER_DISCORD_MEDIA_CACHE_ROOT = '/discord-media-cache';
const CONTAINER_UPLOADED_MEDIA_CACHE_ROOT = '/uploaded-media-cache';
const AGENT_OUTPUT_TIMEOUT_PREFIX = 'Timeout waiting for agent output after ';
const AGENT_READY_FOR_INPUT_LINE = '[hybridclaw-agent] ready for input';
const AGENT_REQUEST_START_LINE = '[hybridclaw-agent] agent request start';

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

const CONTAINER_BROWSER_PROFILE_PATH = '/browser-profiles';
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

function formatContainerTerminalError(
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
      `Container runtime exited before producing output (${status}).`,
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
    ? `Container runtime exited before producing output (${status}). ${detail}`
    : `Container runtime exited before producing output (${status}). Check the gateway log for stderr details.`;
}

export function resolveBrowserProfileHostDir(): string {
  return path.resolve(getBrowserProfileDir(DATA_DIR));
}

function emitTextDelta(entry: PoolEntry, line: string): void {
  const callback = entry.onTextDelta;
  if (!callback) return;
  const delta = decodeStreamDelta(line);
  if (delta == null) return;

  try {
    if (!delta) return;
    callback(redactCredentialSecrets(delta));
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Text delta callback failed',
    );
  }
}

function emitThinkingDelta(entry: PoolEntry, line: string): void {
  const callback = entry.onThinkingDelta;
  if (!callback) return;
  const delta = decodeThinkingDelta(line);
  if (delta == null) return;

  try {
    if (!delta) return;
    callback(redactCredentialSecrets(delta));
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Thinking delta callback failed',
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
        preview: redactCredentialSecrets(resultMatch[3]),
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
        preview: redactCredentialSecrets(startMatch[2]),
      });
    } catch (err) {
      logger.debug(
        { sessionId: entry.sessionId, err },
        'Tool progress callback failed',
      );
    }
  }
}

function parseApprovalProgress(line: string): PendingApproval | null {
  const match = line.match(APPROVAL_RE);
  if (!match) return null;
  try {
    const raw = Buffer.from(match[1], 'base64').toString('utf-8');
    const parsed = JSON.parse(raw) as Partial<PendingApproval> & {
      escalationTarget?: unknown;
    };
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
    const escalationTarget = normalizeEscalationTarget(parsed.escalationTarget);
    return {
      approvalId: parsed.approvalId,
      prompt: redactCredentialSecrets(parsed.prompt),
      intent: redactCredentialSecrets(parsed.intent),
      reason: redactCredentialSecrets(parsed.reason),
      allowSession: parsed.allowSession === true,
      allowAgent: parsed.allowAgent === true,
      allowAll: parsed.allowAll === true,
      expiresAt:
        typeof parsed.expiresAt === 'number' &&
        Number.isFinite(parsed.expiresAt)
          ? parsed.expiresAt
          : null,
      ...(escalationTarget ? { escalationTarget } : {}),
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

export function getActiveContainerCount(): number {
  return pool.size;
}

export function getActiveContainerSessionIds(): string[] {
  return Array.from(pool.keys()).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function getWarmContainerColdStartP95Ms(): number | null {
  return warmPool.coldStartP95Ms();
}

export function isWarmContainerColdStartWithinBudget(): boolean {
  return warmPool.isWithinColdStartBudget();
}

function getTotalContainerProcessCount(): number {
  return pool.size + warmPool.size;
}

function removePoolEntry(entry: PoolEntry): void {
  warmPool.delete(entry.id);
  for (const [sessionId, active] of pool) {
    if (active === entry) pool.delete(sessionId);
  }
}

export function stopSessionContainer(sessionId: string): boolean {
  const entry = pool.get(sessionId);
  if (!entry) return false;
  logger.info(
    { sessionId, containerName: entry.containerName },
    'Stopping session container',
  );
  stopContainer(entry.containerName);
  removePoolEntry(entry);
  return true;
}

function stopContainer(containerName: string): void {
  const proc = spawn('docker', ['stop', containerName], { stdio: 'ignore' });
  proc.on('error', (err) => {
    logger.debug({ containerName, err }, 'Failed to stop container');
  });
}

function stopPoolEntry(entry: PoolEntry): void {
  stopContainer(entry.containerName);
}

function stopWarmEntries(entries: PoolEntry[]): void {
  for (const entry of entries) {
    logger.info(
      { agentId: entry.agentId, containerName: entry.containerName },
      'Evicting warm container',
    );
    stopPoolEntry(entry);
  }
}

function parseMemoryBytes(raw: string): number | null {
  const match = raw.trim().match(/^([\d.]+)\s*([kmgt]?i?b)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier =
    unit === 'kb' || unit === 'kib'
      ? 1024
      : unit === 'mb' || unit === 'mib'
        ? 1024 ** 2
        : unit === 'gb' || unit === 'gib'
          ? 1024 ** 3
          : unit === 'tb' || unit === 'tib'
            ? 1024 ** 4
            : 1;
  return Math.floor(value * multiplier);
}

function readContainerMemoryBytes(containerName: string): number {
  const result = spawnSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.MemUsage}}', containerName],
    { encoding: 'utf-8', timeout: 2_000 },
  );
  if (result.status !== 0) return 0;
  const usage = String(result.stdout || '').split('/')[0] || '';
  return parseMemoryBytes(usage) || 0;
}

function getObservedContainerMemoryBytes(): number {
  let total = 0;
  for (const entry of pool.values()) {
    total += readContainerMemoryBytes(entry.containerName);
  }
  for (const entry of warmPool.values()) {
    total += readContainerMemoryBytes(entry.containerName);
  }
  return total;
}

function enforceWarmContainerPressure(): void {
  stopWarmEntries(
    warmPool.evictForPressure({
      totalProcessCount: getTotalContainerProcessCount(),
      maxProcessCount: MAX_CONCURRENT_CONTAINERS,
      rssBytes: getObservedContainerMemoryBytes(),
    }),
  );
}

function markWorkerReadyForInput(entry: PoolEntry): void {
  entry.readyForInputAt = Date.now();
}

function markAgentRequestStart(entry: PoolEntry): void {
  const startedAt = entry.pendingColdStartProbeStartedAt;
  if (startedAt == null) return;
  warmPool.recordColdStart(Date.now() - startedAt);
  entry.pendingColdStartProbeStartedAt = null;
}

function observeAgentLifecycleLine(entry: PoolEntry, line: string): boolean {
  if (line === AGENT_READY_FOR_INPUT_LINE) {
    markWorkerReadyForInput(entry);
    entry.activity?.notify();
    return true;
  }
  if (line === AGENT_REQUEST_START_LINE) {
    markAgentRequestStart(entry);
    entry.activity?.notify();
    return true;
  }
  return false;
}

function canUseWarmContainerPool(params: {
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  bashProxy?: ExecutorRequest['bashProxy'];
}): boolean {
  return (
    warmPool.enabled &&
    !params.workspacePathOverride?.trim() &&
    !params.workspaceDisplayRootOverride?.trim() &&
    !params.bashProxy
  );
}

function createWarmSessionId(agentId: string): string {
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `warm_${safeAgent}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function claimWarmContainer(params: {
  sessionId: string;
  agentId: string;
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  bashProxy?: ExecutorRequest['bashProxy'];
}): PoolEntry | null {
  if (!canUseWarmContainerPool(params)) return null;
  enforceWarmContainerPressure();
  const entry = warmPool.claim(params.agentId);
  if (!entry) return null;
  entry.sessionId = params.sessionId;
  entry.warm = false;
  entry.lastUsedAt = Date.now();
  pool.set(params.sessionId, entry);
  logger.info(
    {
      sessionId: params.sessionId,
      ipcSessionId: entry.ipcSessionId,
      agentId: params.agentId,
      containerName: entry.containerName,
    },
    'Claimed warm container',
  );
  return entry;
}

function maintainWarmContainerPool(params: {
  agentId: string;
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  bashProxy?: ExecutorRequest['bashProxy'];
}): void {
  if (!canUseWarmContainerPool(params)) return;
  enforceWarmContainerPressure();
  const targetSize = warmPool.targetIdleForAgent(params.agentId);
  stopWarmEntries(warmPool.trimAgent(params.agentId, targetSize));
  while (
    warmPool.idleCountForAgent(params.agentId) < targetSize &&
    getTotalContainerProcessCount() < MAX_CONCURRENT_CONTAINERS
  ) {
    getOrSpawnContainer({
      sessionId: createWarmSessionId(params.agentId),
      agentId: params.agentId,
      warm: true,
    });
  }
}

function isTimedOutAgentOutput(output: ContainerOutput): boolean {
  return (
    output.status === 'error' &&
    typeof output.error === 'string' &&
    output.error.startsWith(AGENT_OUTPUT_TIMEOUT_PREFIX)
  );
}

function isWithinResolvedRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveArtifactHostPath(
  rawPath: string,
  workspacePath: string,
  workspaceDisplayRoot = CONTAINER_WORKSPACE_ROOT,
): string | null {
  const input = String(rawPath || '').trim();
  if (!input) return null;
  const normalized = input.replace(/\\/g, '/');
  const workspaceRoot = path.resolve(workspacePath);
  const displayRoot = path.posix.normalize(
    String(workspaceDisplayRoot || '').trim() || CONTAINER_WORKSPACE_ROOT,
  );

  if (path.posix.isAbsolute(normalized)) {
    const resolvedActual = path.resolve(normalized);
    if (isWithinResolvedRoot(resolvedActual, workspaceRoot)) {
      return resolvedActual;
    }

    const cleanAbs = path.posix.normalize(normalized);
    const allowedRoots =
      displayRoot === CONTAINER_WORKSPACE_ROOT
        ? [CONTAINER_WORKSPACE_ROOT]
        : [CONTAINER_WORKSPACE_ROOT, displayRoot].sort(
            (left, right) => right.length - left.length,
          );
    const matchedRoot =
      allowedRoots.find(
        (root) => cleanAbs === root || cleanAbs.startsWith(`${root}/`),
      ) ?? null;
    if (!matchedRoot) {
      return null;
    }
    const rel = cleanAbs.slice(matchedRoot.length).replace(/^\/+/, '');
    const resolved = path.resolve(workspaceRoot, rel);
    if (isWithinResolvedRoot(resolved, workspaceRoot)) {
      return resolved;
    }
    return null;
  }

  const cleanRel = path.posix.normalize(normalized);
  if (cleanRel === '..' || cleanRel.startsWith('../')) return null;
  const resolved = path.resolve(workspaceRoot, cleanRel);
  if (isWithinResolvedRoot(resolved, workspaceRoot)) {
    return resolved;
  }
  return null;
}

export function remapOutputArtifacts(
  output: ContainerOutput,
  workspacePath: string,
  workspaceDisplayRoot?: string,
): void {
  if (!Array.isArray(output.artifacts) || output.artifacts.length === 0) return;
  const mapped: ArtifactMetadata[] = [];
  for (const artifact of output.artifacts) {
    const raw = artifact as Partial<ArtifactMetadata>;
    const hostPath = resolveArtifactHostPath(
      String(raw.path || ''),
      workspacePath,
      workspaceDisplayRoot,
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

function getContainerWorkspacePath(params: {
  sessionId: string;
  agentId: string;
  workspacePathOverride?: string;
}): string {
  const trimmed = params.workspacePathOverride?.trim();
  if (trimmed) return path.resolve(trimmed);
  const { workspacePath } = getSessionPaths(params.sessionId, params.agentId);
  return workspacePath;
}

/**
 * Get or spawn a persistent container for a session.
 */
function getOrSpawnContainer(
  params: Pick<
    ExecutorRequest,
    | 'sessionId'
    | 'agentId'
    | 'workspacePathOverride'
    | 'workspaceDisplayRootOverride'
    | 'bashProxy'
  > & { ipcSessionId?: string; warm?: boolean },
): PoolEntry {
  const sessionId = params.sessionId;
  const ipcSessionId = params.ipcSessionId || sessionId;
  const agentId = params.agentId || DEFAULT_AGENT_ID;
  const existing = params.warm ? null : pool.get(sessionId);
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

  if (existing) {
    pool.delete(sessionId);
  }

  ensureSessionDirs(ipcSessionId);
  ensureAgentDirs(agentId);
  const { ipcPath } = getSessionPaths(ipcSessionId, agentId);
  const workspacePath = getContainerWorkspacePath({
    sessionId,
    agentId,
    workspacePathOverride: params.workspacePathOverride,
  });
  fs.mkdirSync(workspacePath, { recursive: true });
  ensureWorkspaceNodeModulesLink(workspacePath, CONTAINER_APP_NODE_MODULES, {
    allowMissingSource: true,
    replaceExistingSymlink: true,
  });
  const mediaCacheHostPath = resolveDiscordMediaCacheHostDir();
  fs.mkdirSync(mediaCacheHostPath, { recursive: true });
  const uploadedMediaCacheHostPath = resolveUploadedMediaCacheHostDir();
  fs.mkdirSync(uploadedMediaCacheHostPath, { recursive: true });
  const browserProfileHostPath = resolveBrowserProfileHostDir();
  fs.mkdirSync(browserProfileHostPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(browserProfileHostPath, 0o700);
  } catch (err) {
    logger.warn(
      { err, dir: browserProfileHostPath },
      'Failed to set permissions on browser profile directory',
    );
  }
  const containerName = `hybridclaw-${ipcSessionId.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

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
    '-v',
    `${uploadedMediaCacheHostPath}:${CONTAINER_UPLOADED_MEDIA_CACHE_ROOT}:ro`,
    '-v',
    `${browserProfileHostPath}:${CONTAINER_BROWSER_PROFILE_PATH}:rw`,
    '-e',
    `BROWSER_SHARED_PROFILE_DIR=${CONTAINER_BROWSER_PROFILE_PATH}`,
    '-e',
    `HYBRIDCLAW_AGENT_ID=${agentId}`,
    '-e',
    `HYBRIDCLAW_AGENT_WORKSPACE_ROOT=${CONTAINER_WORKSPACE_ROOT}`,
    '-e',
    `HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT=${params.workspaceDisplayRootOverride?.trim() || CONTAINER_WORKSPACE_ROOT}`,
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
    '-e',
    'HYBRIDCLAW_AGENT_SANDBOX_MODE=container',
  ];

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

  logger.info(
    { sessionId, ipcSessionId, agentId, containerName, warm: params.warm },
    'Spawning persistent container',
  );

  const proc = spawn('docker', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entry: PoolEntry = {
    id: ipcSessionId,
    process: proc,
    containerName,
    sessionId,
    ipcSessionId,
    agentId,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    warm: params.warm === true,
    readyForInputAt: null,
    pendingColdStartProbeStartedAt: null,
    stderrBuffer: '',
    stderrHistory: [],
    streamDebug: createStreamDebugState(),
    workerSignature: '',
    terminalError: null,
    isReady() {
      return entry.readyForInputAt != null;
    },
    stop() {
      stopPoolEntry(entry);
    },
  };

  proc.stderr.on('data', (data) => {
    entry.stderrBuffer += data.toString('utf-8');
    const lines = entry.stderrBuffer.split('\n');
    entry.stderrBuffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (observeAgentLifecycleLine(entry, line)) continue;
      if (consumeModelResponseDebugFileLine(line)) {
        entry.activity?.notify();
        continue;
      }
      rememberStderrLine(entry, line);
      emitTextDelta(entry, line);
      emitThinkingDelta(entry, line);
      if (isThinkingDeltaLine(line)) {
        entry.activity?.notify();
        continue;
      }
      if (isStreamActivityLine(line)) {
        entry.activity?.notify();
        continue;
      }
      if (
        consumeCollapsedStreamDebugLine(line, entry.streamDebug, (message) => {
          logger.debug({ container: containerName }, message);
        })
      ) {
        entry.activity?.notify();
        continue;
      }
      if (emitApprovalProgress(entry, line)) {
        entry.activity?.notify();
        continue;
      }
      logger.debug({ container: containerName }, line);
      emitToolProgress(entry, line);
      entry.activity?.notify();
    }
  });

  proc.on('close', (code, signal) => {
    const tail = entry.stderrBuffer.trim();
    if (tail) {
      if (observeAgentLifecycleLine(entry, tail)) {
        entry.stderrBuffer = '';
      } else if (consumeModelResponseDebugFileLine(tail)) {
        entry.activity?.notify();
        entry.stderrBuffer = '';
      } else {
        rememberStderrLine(entry, tail);
        emitTextDelta(entry, tail);
        emitThinkingDelta(entry, tail);
        if (isStreamActivityLine(tail)) {
          entry.activity?.notify();
        } else if (isThinkingDeltaLine(tail)) {
          entry.activity?.notify();
        } else if (
          !consumeCollapsedStreamDebugLine(
            tail,
            entry.streamDebug,
            (message) => {
              logger.debug({ container: containerName }, message);
            },
          )
        ) {
          if (!emitApprovalProgress(entry, tail)) {
            logger.debug({ container: containerName }, tail);
            emitToolProgress(entry, tail);
          }
        }
        entry.stderrBuffer = '';
      }
    }
    entry.terminalError = formatContainerTerminalError(entry, { code, signal });
    flushCollapsedStreamDebugSummary(entry.streamDebug, (message) => {
      logger.debug({ container: containerName }, message);
    });
    removePoolEntry(entry);
    logger.info({ sessionId, containerName, code, signal }, 'Container exited');
  });

  proc.on('error', (err) => {
    entry.terminalError = `Container runtime failed before producing output: ${err instanceof Error ? err.message : String(err)}`;
    removePoolEntry(entry);
    logger.error({ sessionId, containerName, error: err }, 'Container error');
  });

  if (entry.warm) {
    warmPool.add(entry);
  } else {
    pool.set(sessionId, entry);
  }
  return entry;
}

/**
 * Send a request to a persistent container and wait for the response.
 */
export async function runContainer(
  params: ExecutorRequest,
): Promise<ContainerOutput> {
  return withSpan(
    'hybridclaw.container.execute',
    {
      'hybridclaw.session_id': params.sessionId,
      'hybridclaw.agent_id': params.agentId || '',
      'hybridclaw.model': params.model || '',
    },
    async () => runContainerInner(params),
  );
}

async function runContainerInner(
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
    onThinkingDelta,
    onToolProgress,
    onApprovalProgress,
    abortSignal,
    media,
    audioTranscriptsPrepended,
    pluginTools,
    escalationTarget,
    maxWallClockMs,
    inactivityTimeoutMs,
  } = params;
  const workspacePath = getContainerWorkspacePath({
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
  const runtimeEnv = await resolveGoogleWorkspaceRuntimeEnv().catch((error) => {
    logger.warn(
      { error },
      'Failed to resolve Google access token for Workspace CLI runtime environment',
    );
    return {};
  });
  enforceWarmContainerPressure();
  if (
    getTotalContainerProcessCount() >= MAX_CONCURRENT_CONTAINERS &&
    !pool.has(sessionId)
  ) {
    stopWarmEntries(
      warmPool.evictForPressure({
        totalProcessCount: getTotalContainerProcessCount() + 1,
        maxProcessCount: MAX_CONCURRENT_CONTAINERS,
        rssBytes: getObservedContainerMemoryBytes(),
      }),
    );
  }
  if (
    getTotalContainerProcessCount() >= MAX_CONCURRENT_CONTAINERS &&
    !pool.has(sessionId)
  ) {
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: `Too many active containers (${getTotalContainerProcessCount()}/${MAX_CONCURRENT_CONTAINERS}). Try again later.`,
    };
  }

  const startTime = Date.now();

  const input: ContainerInput = {
    sessionId,
    messages,
    chatbotId: modelRuntime.chatbotId,
    enableRag: modelRuntime.enableRag,
    apiKey: modelRuntime.apiKey,
    baseUrl: remapHostBaseUrlForContainer(modelRuntime.baseUrl),
    provider: modelRuntime.provider,
    providerMethod: modelRuntime.providerMethod,
    requestHeaders: modelRuntime.requestHeaders,
    isLocal: modelRuntime.isLocal,
    contextWindow: modelRuntime.contextWindow,
    thinkingFormat: modelRuntime.thinkingFormat,
    gatewayBaseUrl: remapHostBaseUrlForContainer(GATEWAY_BASE_URL),
    gatewayApiToken: GATEWAY_API_TOKEN || undefined,
    model,
    ralphMaxIterations,
    fullAutoEnabled,
    fullAutoNeverApproveTools,
    skipContainerSystemPrompt,
    streamTextDeltas: Boolean(onTextDelta),
    debugModelResponses: process.env[GATEWAY_DEBUG_MODEL_RESPONSES_ENV] === '1',
    maxTokens: resolveExecutorMaxTokens({
      model,
      discoveredMaxTokens: modelRuntime.maxTokens,
    }),
    channelId,
    configuredDiscordChannels: collectConfiguredDiscordChannelIds(channelId),
    activeMessageChannels: collectActiveMessageToolChannelKinds(),
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
    runtimeEnv,
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
      braveApiKey: BRAVE_API_KEY,
      perplexityApiKey: PERPLEXITY_API_KEY,
      tavilyApiKey: TAVILY_API_KEY,
    },
    persistBashState: CONTAINER_PERSIST_BASH_STATE,
    escalationTarget,
  };
  const workerSignature = computeWorkerSignature({
    agentId,
    provider: input.provider,
    providerMethod: input.providerMethod,
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
      {
        sessionId,
        containerName: existingEntry.containerName,
        agentId,
        provider: input.provider,
      },
      'Worker routing changed; restarting persistent container',
    );
    stopContainer(existingEntry.containerName);
    removePoolEntry(existingEntry);
  }

  const isNewContainer =
    !pool.has(sessionId) ||
    pool.get(sessionId)?.process.killed ||
    pool.get(sessionId)?.process.exitCode !== null;

  let entry: PoolEntry;
  try {
    entry =
      (isNewContainer
        ? claimWarmContainer({
            sessionId,
            agentId,
            workspacePathOverride: params.workspacePathOverride,
            workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
            bashProxy: params.bashProxy,
          })
        : null) ||
      getOrSpawnContainer({
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
      error: `Container spawn error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  cleanupIpc(entry.ipcSessionId);
  ensureSessionDirs(entry.ipcSessionId);
  const activity = createActivityTracker();
  entry.workerSignature = workerSignature;
  entry.onTextDelta = onTextDelta;
  entry.onThinkingDelta = onThinkingDelta;
  entry.onToolProgress = onToolProgress;
  entry.onApprovalProgress = onApprovalProgress;
  entry.activity = activity;
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
      entry.pendingColdStartProbeStartedAt = Date.now();
      // First request: send full input (including apiKey) via stdin — no file on disk.
      // Write JSON on a single line followed by newline as delimiter.
      // Do NOT end stdin — closing stdin can cause docker -i to terminate the container.
      entry.process.stdin?.write(`${JSON.stringify(input)}\n`);
    } else {
      // Follow-up requests: write to IPC file, omitting apiKey
      writeInput(entry.ipcSessionId, input, { omitApiKey: true });
    }

    const output = await readOutput(
      entry.ipcSessionId,
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
    const timedOut = isTimedOutAgentOutput(output);
    if (timedOut) {
      logger.warn(
        { sessionId, containerName: entry.containerName },
        'Agent output timed out; stopping stuck container',
      );
      stopSessionContainer(sessionId);
    }
    remapOutputArtifacts(
      output,
      workspacePath,
      params.workspaceDisplayRootOverride,
    );
    if (typeof output.result === 'string') {
      output.result = redactCredentialSecrets(output.result);
    }
    if (typeof output.error === 'string') {
      output.error = redactCredentialSecrets(output.error);
    }
    if (output.pendingApproval) {
      output.pendingApproval = {
        ...output.pendingApproval,
        prompt: redactCredentialSecrets(output.pendingApproval.prompt),
        intent: redactCredentialSecrets(output.pendingApproval.intent),
        reason: redactCredentialSecrets(output.pendingApproval.reason),
      };
    }
    const duration = Date.now() - startTime;
    if (!timedOut) {
      entry.lastUsedAt = Date.now();
      warmPool.recordRequest(agentId, duration);
      maintainWarmContainerPool({
        agentId,
        workspacePathOverride: params.workspacePathOverride,
        workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
        bashProxy: params.bashProxy,
      });
    }

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
    if (entry.onThinkingDelta === onThinkingDelta) {
      entry.onThinkingDelta = undefined;
    }
    if (entry.onToolProgress === onToolProgress) {
      entry.onToolProgress = undefined;
    }
    if (entry.onApprovalProgress === onApprovalProgress) {
      entry.onApprovalProgress = undefined;
    }
    entry.activity = undefined;
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
  for (const entry of warmPool.clear()) {
    logger.info(
      { agentId: entry.agentId, containerName: entry.containerName },
      'Stopping warm container (shutdown)',
    );
    stopContainer(entry.containerName);
  }
}

export class ContainerExecutor {
  exec(params: ExecutorRequest): Promise<ContainerOutput> {
    return runContainer(params);
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

  getActiveSessionIds(): string[] {
    return getActiveContainerSessionIds();
  }
}
