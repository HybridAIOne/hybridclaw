import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import {
  delegationQueueStatus,
  enqueueDelegation,
} from '../agent/delegation-manager.js';
import {
  getSandboxDiagnostics,
  stopSessionExecution,
} from '../agent/executor.js';
import { processSideEffects } from '../agent/side-effects.js';
import { isSilentReply } from '../agent/silent-reply.js';
import { buildToolsSummary } from '../agent/tool-summary.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { getObservabilityIngestState } from '../audit/observability-ingest.js';
import { getCodexAuthStatus } from '../auth/codex-auth.js';
import {
  APP_VERSION,
  CONFIGURED_MODELS,
  DATA_DIR,
  DISCORD_COMMANDS_ONLY,
  DISCORD_FREE_RESPONSE_CHANNELS,
  DISCORD_GROUP_POLICY,
  DISCORD_GUILDS,
  DISCORD_RESPOND_TO_ALL_MESSAGES,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
  MissingRequiredEnvVarError,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_DELEGATION_MAX_DEPTH,
  PROACTIVE_DELEGATION_MAX_PER_TURN,
  PROACTIVE_RALPH_MAX_ITERATIONS,
} from '../config/config.js';
import {
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import { NoCompactableMessagesError } from '../memory/compaction.js';
import {
  createTask,
  deleteTask,
  getAllSessions,
  getQueuedProactiveMessageCount,
  getRecentStructuredAuditForSession,
  getSessionCount,
  getTasksForSession,
  getUsageTotals,
  listUsageByAgent,
  listUsageByModel,
  logAudit,
  pauseTask,
  recordUsageEvent,
  resumeTask,
  updateSessionChatbot,
  updateSessionModel,
  updateSessionRag,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import {
  modelRequiresChatbotId,
  resolveAgentIdForModel,
  resolveModelProvider,
} from '../providers/factory.js';
import { fetchHybridAIBots } from '../providers/hybridai-bots.js';
import { resolveModelContextWindowFallback } from '../providers/hybridai-models.js';
import { runIsolatedScheduledTask } from '../scheduler/scheduled-task-runner.js';
import { getSchedulerStatus, rearmScheduler } from '../scheduler/scheduler.js';
import { exportSessionSnapshotJsonl } from '../session/session-export.js';
import { maybeCompactSession } from '../session/session-maintenance.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import { expandSkillInvocation } from '../skills/skills.js';
import type {
  ArtifactMetadata,
  CanonicalSessionContext,
  ChatMessage,
  DelegationSideEffect,
  DelegationTaskSpec,
  McpServerConfig,
  MediaContextItem,
  ScheduledTask,
  StoredMessage,
  StructuredAuditEntry,
  TokenUsageStats,
  ToolProgressEvent,
} from '../types.js';
import { ensureBootstrapFiles } from '../workspace.js';
import {
  type GatewayChatRequestBody,
  type GatewayChatResult,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayStatus,
  renderGatewayCommand,
} from './gateway-types.js';

const BOT_CACHE_TTL = 300_000; // 5 minutes
const MAX_HISTORY_MESSAGES = 40;
const BASE_SUBAGENT_ALLOWED_TOOLS = [
  'read',
  'write',
  'edit',
  'delete',
  'glob',
  'grep',
  'bash',
  'session_search',
  'web_search',
  'web_fetch',
  'message',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_upload',
  'browser_press',
  'browser_scroll',
  'browser_back',
  'browser_screenshot',
  'browser_pdf',
  'browser_vision',
  'vision_analyze',
  'image',
  'browser_get_images',
  'browser_console',
  'browser_network',
  'browser_close',
];
const ORCHESTRATOR_SUBAGENT_ALLOWED_TOOLS = [
  ...BASE_SUBAGENT_ALLOWED_TOOLS,
  'delegate',
];
const MAX_DELEGATION_TASKS = 6;
const MAX_DELEGATION_USER_CHARS = 500;
const MAX_RALPH_ITERATIONS = 64;
const DISCORD_CHANNEL_MODE_VALUES = new Set(['off', 'mention', 'free']);
const DISCORD_GROUP_POLICY_VALUES = new Set(['open', 'allowlist', 'disabled']);
const IMAGE_QUESTION_RE =
  /(what(?:'s| is)? on (?:the )?(?:image|picture|photo|screenshot)|describe (?:this|the) (?:image|picture|photo)|image|picture|photo|screenshot|ocr|diagram|chart|grafik|bild|foto|was steht|was ist auf dem bild)/i;
const BROWSER_TAB_RE =
  /(browser|tab|current tab|web page|website|seite im browser|aktuellen tab)/i;
const TRANSIENT_DELEGATION_ERROR_PATTERNS: RegExp[] = [
  /econnreset/i,
  /etimedout/i,
  /429/i,
  /5\d\d/i,
  /network/i,
  /socket/i,
  /fetch failed/i,
  /temporar/i,
  /rate limit/i,
  /unavailable/i,
];
const PERMANENT_DELEGATION_ERROR_PATTERNS: RegExp[] = [
  /forbidden/i,
  /permission denied/i,
  /unauthorized/i,
  /not found/i,
  /invalid api key/i,
  /blocked by security hook/i,
];
let cachedGitCommitShort: string | null | undefined;

type DelegationMode = 'single' | 'parallel' | 'chain';
type DelegationRunStatus = 'completed' | 'failed' | 'timeout';
type DelegationErrorClass = 'transient' | 'permanent' | 'unknown';

interface NormalizedDelegationTask {
  prompt: string;
  label?: string;
  model: string;
}

interface NormalizedDelegationPlan {
  mode: DelegationMode;
  label?: string;
  tasks: NormalizedDelegationTask[];
}

interface DelegationRunResult {
  status: DelegationRunStatus;
  sessionId: string;
  model: string;
  durationMs: number;
  attempts: number;
  toolsUsed: string[];
  result?: string;
  error?: string;
  artifacts?: ArtifactMetadata[];
}

interface DelegationCompletionEntry {
  title: string;
  run: DelegationRunResult;
}

interface DelegationTaskRunInput {
  parentSessionId: string;
  childDepth: number;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  mode: DelegationMode;
  task: NormalizedDelegationTask;
}

export interface GatewayChatRequest {
  sessionId: GatewayChatRequestBody['sessionId'];
  guildId: GatewayChatRequestBody['guildId'];
  channelId: GatewayChatRequestBody['channelId'];
  userId: GatewayChatRequestBody['userId'];
  username: GatewayChatRequestBody['username'];
  content: GatewayChatRequestBody['content'];
  media?: GatewayChatRequestBody['media'];
  chatbotId?: GatewayChatRequestBody['chatbotId'];
  model?: GatewayChatRequestBody['model'];
  enableRag?: GatewayChatRequestBody['enableRag'];
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

export interface ProactiveMessagePayload {
  text: string;
  artifacts?: ArtifactMetadata[];
}

export type {
  GatewayChatResult,
  GatewayCommandRequest,
  GatewayCommandResult,
  GatewayStatus,
};
export { renderGatewayCommand };

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeMediaContextItems(
  raw: GatewayChatRequestBody['media'],
): MediaContextItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const normalized: MediaContextItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const path =
      typeof item.path === 'string' && item.path.trim()
        ? item.path.trim()
        : null;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const originalUrl =
      typeof item.originalUrl === 'string' ? item.originalUrl.trim() : '';
    const filename =
      typeof item.filename === 'string' ? item.filename.trim() : '';
    if (!url || !originalUrl || !filename) continue;
    const sizeBytes =
      typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes)
        ? Math.max(0, Math.floor(item.sizeBytes))
        : 0;
    const mimeType =
      typeof item.mimeType === 'string' && item.mimeType.trim()
        ? item.mimeType.trim().toLowerCase()
        : null;
    normalized.push({
      path,
      url,
      originalUrl,
      mimeType,
      sizeBytes,
      filename,
    });
  }
  return normalized;
}

function isImageMediaItem(item: MediaContextItem): boolean {
  const mimeType = String(item.mimeType || '')
    .trim()
    .toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)$/i.test(
    item.filename || '',
  );
}

function buildMediaPromptContext(media: MediaContextItem[]): string {
  if (media.length === 0) return '';
  const mediaPaths = media
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));
  const imagePaths = media
    .filter((item) => isImageMediaItem(item) && item.path)
    .map((item) => item.path as string);
  const documentPaths = media
    .filter((item) => !isImageMediaItem(item) && item.path)
    .map((item) => item.path as string);
  const mediaUrls = media.map((item) => item.url);
  const mediaTypes = media.map((item) => item.mimeType || 'unknown');
  const payload = media.map((item, index) => ({
    order: index + 1,
    path: item.path,
    mime: item.mimeType || 'unknown',
    size: item.sizeBytes,
    filename: item.filename,
    original_url: item.originalUrl,
    url: item.url,
  }));
  return [
    '[MediaContext]',
    `MediaPaths: ${JSON.stringify(mediaPaths)}`,
    `ImageMediaPaths: ${JSON.stringify(imagePaths)}`,
    `DocumentMediaPaths: ${JSON.stringify(documentPaths)}`,
    `MediaUrls: ${JSON.stringify(mediaUrls)}`,
    `MediaTypes: ${JSON.stringify(mediaTypes)}`,
    `MediaItems: ${JSON.stringify(payload)}`,
    'Prefer current-turn attachments and file inputs over `message` reads, `glob`, `find`, or workspace-wide discovery.',
    'When the user asks about current-turn image attachments, use `vision_analyze` with local image paths from `ImageMediaPaths` first.',
    'When the user asks about current-turn PDF/document attachments, prefer the injected `<file>` content or the supplied local path before reading chat history.',
    'Use MediaUrls as fallback when a local path is missing or fails to open.',
    'Use `browser_vision` only for questions about the active browser tab/page.',
    '',
    '',
  ].join('\n');
}

function isImageQuestion(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return IMAGE_QUESTION_RE.test(normalized);
}

function isExplicitBrowserTabQuestion(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return BROWSER_TAB_RE.test(normalized);
}

export interface MediaToolPolicy {
  blockedTools?: string[];
  prioritizeVisionTool: boolean;
}

export function resolveMediaToolPolicy(
  content: string,
  media: MediaContextItem[],
): MediaToolPolicy {
  const imageMedia = media.filter((item) => isImageMediaItem(item));
  if (imageMedia.length === 0) {
    return {
      blockedTools: undefined,
      prioritizeVisionTool: false,
    };
  }

  const imageQuestion = isImageQuestion(content);
  const explicitBrowserTab = isExplicitBrowserTabQuestion(content);
  if (imageQuestion && !explicitBrowserTab) {
    return {
      blockedTools: ['browser_vision'],
      prioritizeVisionTool: true,
    };
  }

  return {
    blockedTools: undefined,
    prioritizeVisionTool: false,
  };
}

function resolveGitCommitShort(): string | null {
  if (cachedGitCommitShort !== undefined) return cachedGitCommitShort;
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
      const hash = (result.stdout || '').trim();
      cachedGitCommitShort = hash || null;
      return cachedGitCommitShort;
    }
  } catch {
    // ignore
  }
  cachedGitCommitShort = null;
  return null;
}

function parseTimestamp(raw: string | null | undefined): Date | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRelativeTime(raw: string | null | undefined): string {
  const at = parseTimestamp(raw);
  if (!at) return 'unknown';
  const deltaMs = Date.now() - at.getTime();
  if (deltaMs < 15_000) return 'just now';
  if (deltaMs < 60_000)
    return `${Math.max(1, Math.floor(deltaMs / 1_000))}s ago`;
  if (deltaMs < 3_600_000)
    return `${Math.max(1, Math.floor(deltaMs / 60_000))}m ago`;
  if (deltaMs < 86_400_000)
    return `${Math.max(1, Math.floor(deltaMs / 3_600_000))}h ago`;
  return `${Math.max(1, Math.floor(deltaMs / 86_400_000))}d ago`;
}

function numberFromUnknown(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  )
    return null;
  return value;
}

function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberFromUnknown(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function parseAuditPayload(
  entry: StructuredAuditEntry,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function summarizeAuditPayload(payloadRaw: string): string {
  try {
    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    if (payload.type === 'tool.result') {
      const status = payload.isError ? 'error' : 'ok';
      return `${String(payload.toolName || 'tool')} ${status} ${String(payload.durationMs || 0)}ms`;
    }
    return JSON.stringify(payload).slice(0, 140);
  } catch {
    return payloadRaw.slice(0, 140);
  }
}

function formatHybridAIBotFetchError(error: unknown): string {
  if (error instanceof MissingRequiredEnvVarError) {
    return 'HybridAI bot commands require HybridAI API credentials. Run `hybridclaw hybridai login` and try again.';
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/401\b|unauthorized/i.test(message)) {
    return 'HybridAI bot commands require valid HybridAI API credentials. Run `hybridclaw hybridai login` and try again.';
  }

  return `Failed to fetch bots: ${message}`;
}

function formatCompactNumber(value: number | null): string {
  if (value == null) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const scaled =
      abs >= 10_000_000
        ? (value / 1_000_000).toFixed(0)
        : (value / 1_000_000).toFixed(1);
    return `${scaled.replace(/\.0$/, '')}M`;
  }
  if (abs >= 1_000) {
    const scaled =
      abs >= 10_000 ? (value / 1_000).toFixed(0) : (value / 1_000).toFixed(1);
    return `${scaled.replace(/\.0$/, '')}k`;
  }
  return String(Math.round(value));
}

function formatPercent(value: number | null): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value))
    return 'n/a';
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatArchiveReference(archivePath: string): string {
  const normalized = archivePath.trim();
  if (!normalized) return 'archive.json';

  const relative = path.relative(DATA_DIR, normalized);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }

  return path.basename(normalized) || 'archive.json';
}

function formatUsd(value: number | null): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return 'n/a';
  }
  if (value <= 0) return '$0.0000';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function resolveSessionAgentId(session: {
  chatbot_id: string | null;
}): string | null {
  const sessionAgent = session.chatbot_id?.trim();
  if (sessionAgent) return sessionAgent;
  const defaultAgent = HYBRIDAI_CHATBOT_ID?.trim();
  if (defaultAgent) return defaultAgent;
  return null;
}

function extractUsageCostUsd(tokenUsage?: TokenUsageStats): number {
  if (!tokenUsage) return 0;
  const costCarrier = tokenUsage as unknown as Record<string, unknown>;
  const value = firstNumber([
    costCarrier.costUsd,
    costCarrier.costUSD,
    costCarrier.cost_usd,
    costCarrier.estimatedCostUsd,
    costCarrier.estimated_cost_usd,
  ]);
  if (value == null) return 0;
  return Math.max(0, value);
}

function formatCanonicalContextPrompt(params: {
  summary: string | null;
  recentMessages: Array<{
    role: string;
    content: string;
    session_id: string;
    channel_id: string | null;
  }>;
}): string | null {
  const sections: string[] = [];
  const summary = (params.summary || '').trim();
  if (summary) {
    sections.push(['### Canonical Session Summary', summary].join('\n'));
  }

  if (params.recentMessages.length > 0) {
    const lines = params.recentMessages.slice(-6).map((entry) => {
      const role = (entry.role || 'user').trim().toLowerCase();
      const who = role === 'assistant' ? 'Assistant' : 'User';
      const from = entry.channel_id?.trim()
        ? `${entry.channel_id.trim()} (${entry.session_id})`
        : entry.session_id;
      const compact = entry.content.replace(/\s+/g, ' ').trim();
      const short =
        compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
      return `- ${who} [${from}]: ${short}`;
    });
    sections.push(
      [
        '### Cross-Channel Recall',
        'Recent context from other sessions/channels for this user:',
        ...lines,
      ].join('\n'),
    );
  }

  const merged = sections.join('\n\n').trim();
  return merged || null;
}

function resolveActivationModeLabel(): string {
  if (DISCORD_COMMANDS_ONLY) return 'commands-only';
  if (DISCORD_GROUP_POLICY === 'disabled') return 'disabled';
  if (DISCORD_GROUP_POLICY === 'allowlist') return 'allowlist';
  if (DISCORD_FREE_RESPONSE_CHANNELS.length > 0)
    return `mention + ${DISCORD_FREE_RESPONSE_CHANNELS.length} free channel(s)`;
  if (DISCORD_RESPOND_TO_ALL_MESSAGES) return 'all messages';
  return 'mention';
}

function resolveGuildChannelMode(
  guildId: string | null,
  channelId: string,
): 'off' | 'mention' | 'free' {
  if (!guildId) return 'free';
  if (DISCORD_GROUP_POLICY === 'disabled') return 'off';
  const guild = DISCORD_GUILDS[guildId];
  const explicit = guild?.channels[channelId]?.mode;
  if (DISCORD_GROUP_POLICY === 'allowlist') {
    return explicit ?? 'off';
  }
  if (explicit === 'off' || explicit === 'mention' || explicit === 'free') {
    return explicit;
  }
  if (DISCORD_FREE_RESPONSE_CHANNELS.includes(channelId)) return 'free';
  if (guild) {
    const defaultMode = guild.defaultMode;
    if (
      defaultMode === 'off' ||
      defaultMode === 'mention' ||
      defaultMode === 'free'
    ) {
      return defaultMode;
    }
  }
  if (DISCORD_RESPOND_TO_ALL_MESSAGES) return 'free';
  return 'mention';
}

interface SessionStatusSnapshot {
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHitPercent: number | null;
  contextUsedTokens: number | null;
  contextBudgetTokens: number | null;
  contextUsagePercent: number | null;
}

function readSessionStatusSnapshot(
  sessionId: string,
  options?: { modelContextWindowTokens?: number | null },
): SessionStatusSnapshot {
  const entries = getRecentStructuredAuditForSession(sessionId, 160);
  let usagePayload: Record<string, unknown> | null = null;

  for (const entry of entries) {
    const payload = parseAuditPayload(entry);
    if (!payload) continue;
    const payloadType =
      typeof payload.type === 'string' ? payload.type : entry.event_type;
    if (!usagePayload && payloadType === 'model.usage') {
      usagePayload = payload;
    }
    if (usagePayload) break;
  }

  const promptTokens = firstNumber([
    usagePayload?.promptTokens,
    usagePayload?.apiPromptTokens,
    usagePayload?.estimatedPromptTokens,
  ]);
  const completionTokens = firstNumber([
    usagePayload?.completionTokens,
    usagePayload?.apiCompletionTokens,
    usagePayload?.estimatedCompletionTokens,
  ]);

  const cacheReadTokens = firstNumber([
    usagePayload?.cacheReadTokens,
    usagePayload?.cacheReadInputTokens,
    usagePayload?.apiCacheReadTokens,
    usagePayload?.cacheRead,
    usagePayload?.cache_read,
    usagePayload?.cache_read_tokens,
    usagePayload?.cache_read_input_tokens,
    usagePayload?.cached_tokens,
    (usagePayload?.prompt_tokens_details as Record<string, unknown> | undefined)
      ?.cached_tokens,
  ]);
  const cacheWriteTokens = firstNumber([
    usagePayload?.cacheWriteTokens,
    usagePayload?.cacheWriteInputTokens,
    usagePayload?.apiCacheWriteTokens,
    usagePayload?.cacheWrite,
    usagePayload?.cache_write,
    usagePayload?.cache_write_tokens,
    usagePayload?.cache_write_input_tokens,
    usagePayload?.cache_creation_input_tokens,
  ]);
  const cacheRead = Math.max(0, cacheReadTokens || 0);
  const cacheWrite = Math.max(0, cacheWriteTokens || 0);
  const cacheTotal = cacheRead + cacheWrite;
  const cacheHitPercent =
    cacheTotal > 0 ? (cacheRead / cacheTotal) * 100 : null;

  const contextUsedTokens = firstNumber([
    usagePayload?.contextTokens,
    usagePayload?.context_tokens,
    usagePayload?.tokensInContext,
    usagePayload?.tokens_in_context,
    usagePayload?.promptTokens,
    usagePayload?.apiPromptTokens,
    usagePayload?.estimatedPromptTokens,
  ]);
  const contextBudgetTokens = firstNumber([
    usagePayload?.contextWindowTokens,
    usagePayload?.context_window_tokens,
    usagePayload?.modelContextWindowTokens,
    usagePayload?.model_context_window_tokens,
    usagePayload?.modelContextWindow,
    usagePayload?.model_context_window,
    usagePayload?.maxContextTokens,
    usagePayload?.max_context_tokens,
    usagePayload?.contextWindow,
    usagePayload?.context_window,
    usagePayload?.contextLength,
    usagePayload?.context_length,
    usagePayload?.maxContextSize,
    usagePayload?.max_context_size,
    options?.modelContextWindowTokens,
  ]);
  const contextUsagePercent =
    contextUsedTokens != null &&
    contextBudgetTokens != null &&
    contextBudgetTokens > 0
      ? (contextUsedTokens / contextBudgetTokens) * 100
      : null;

  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitPercent,
    contextUsedTokens,
    contextBudgetTokens,
    contextUsagePercent,
  };
}

function normalizeVersionQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/<@!?\d+>/g, ' ')
    .replace(/[!?.,;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isVersionOnlyQuestion(raw: string): boolean {
  const text = normalizeVersionQuery(raw);
  if (!text) return false;
  if (text.startsWith('!claw ')) return false;
  if (!text.includes('version')) return false;

  const detailedRuntimeTokens = [
    'modell',
    'model',
    'runtime',
    'laufzeit',
    'node',
    'os',
    'plattform',
    'platform',
    'agent id',
    'chatbot id',
    'commit',
    'sha',
    'hash',
    'details',
    'detail',
    'full',
    'voll',
  ];
  if (detailedRuntimeTokens.some((token) => text.includes(token))) return false;

  const words = text.split(' ').filter(Boolean);
  if (
    words.length > 8 &&
    !text.includes('welche version') &&
    !text.includes('what version') &&
    !text.includes('which version')
  ) {
    return false;
  }

  return true;
}

function recordSuccessfulTurn(opts: {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
  runId: string;
  turnIndex: number;
  userId: string;
  username: string | null;
  userContent: string;
  resultText: string;
  toolCallCount: number;
  startedAt: number;
}): void {
  memoryService.storeTurn({
    sessionId: opts.sessionId,
    user: {
      userId: opts.userId,
      username: opts.username,
      content: opts.userContent,
    },
    assistant: {
      userId: 'assistant',
      username: null,
      content: opts.resultText,
    },
  });
  try {
    if (opts.userId.trim()) {
      memoryService.appendCanonicalMessages({
        agentId: opts.agentId,
        userId: opts.userId,
        newMessages: [
          {
            role: 'user',
            content: opts.userContent,
            sessionId: opts.sessionId,
            channelId: opts.channelId,
          },
          {
            role: 'assistant',
            content: opts.resultText,
            sessionId: opts.sessionId,
            channelId: opts.channelId,
          },
        ],
      });
    }
  } catch (err) {
    logger.debug(
      { sessionId: opts.sessionId, userId: opts.userId, err },
      'Failed to append canonical session memory',
    );
  }
  appendSessionTranscript(opts.agentId, {
    sessionId: opts.sessionId,
    channelId: opts.channelId,
    role: 'user',
    userId: opts.userId,
    username: opts.username,
    content: opts.userContent,
  });
  appendSessionTranscript(opts.agentId, {
    sessionId: opts.sessionId,
    channelId: opts.channelId,
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: opts.resultText,
  });

  void maybeCompactSession({
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    chatbotId: opts.chatbotId,
    enableRag: opts.enableRag,
    model: opts.model,
    channelId: opts.channelId,
  }).catch((err) => {
    logger.warn(
      { sessionId: opts.sessionId, err },
      'Background session compaction failed',
    );
  });

  recordAuditEvent({
    sessionId: opts.sessionId,
    runId: opts.runId,
    event: {
      type: 'turn.end',
      turnIndex: opts.turnIndex,
      finishReason: 'completed',
    },
  });
  recordAuditEvent({
    sessionId: opts.sessionId,
    runId: opts.runId,
    event: {
      type: 'session.end',
      reason: 'normal',
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: opts.toolCallCount,
        durationMs: Date.now() - opts.startedAt,
      },
    },
  });
}

function normalizeRalphIterations(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated === -1) return -1;
  if (truncated < 0) return 0;
  return Math.min(MAX_RALPH_ITERATIONS, truncated);
}

function formatRalphIterations(value: number): string {
  if (value === -1) return 'unlimited';
  if (value <= 0) return 'off';
  return `${value} extra iteration${value === 1 ? '' : 's'}`;
}

function badCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function infoCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function plainCommand(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function parseMcpServerName(rawName: string): {
  name?: string;
  error?: string;
} {
  const name = String(rawName || '').trim();
  if (!name) {
    return { error: 'Usage: `mcp add <name> <json>`' };
  }
  if (!MCP_SERVER_NAME_RE.test(name)) {
    return {
      error:
        'MCP server name must use lowercase letters, numbers, `_`, or `-`, and start with a letter or number.',
    };
  }
  return { name };
}

function parseMcpServerConfig(rawJson: string): {
  config?: McpServerConfig;
  error?: string;
} {
  const trimmed = rawJson.trim();
  if (!trimmed) {
    return { error: 'Usage: `mcp add <name> <json>`' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'MCP server config must be a JSON object.' };
  }

  const record = parsed as Record<string, unknown>;
  const rawTransport = String(record.transport ?? record.type ?? '')
    .trim()
    .toLowerCase();
  const transport =
    rawTransport === 'streamable-http' || rawTransport === 'streamable_http'
      ? 'http'
      : rawTransport;

  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return {
      error: 'MCP server transport must be one of `stdio`, `http`, or `sse`.',
    };
  }
  if (
    transport === 'stdio' &&
    (typeof record.command !== 'string' || !record.command.trim())
  ) {
    return { error: 'stdio MCP servers require a non-empty `command`.' };
  }
  if (
    (transport === 'http' || transport === 'sse') &&
    (typeof record.url !== 'string' || !record.url.trim())
  ) {
    return {
      error: `${transport} MCP servers require a non-empty \`url\`.`,
    };
  }

  return { config: parsed as McpServerConfig };
}

function summarizeMcpServer(name: string, config: McpServerConfig): string {
  const enabled = config.enabled === false ? 'disabled' : 'enabled';
  const target =
    config.transport === 'stdio'
      ? [config.command, ...(config.args || [])].filter(Boolean).join(' ')
      : config.url || '(missing url)';
  return `${name} — ${enabled} · ${config.transport} · ${target || '(missing command)'}`;
}

function restartNoteForMcpChange(sessionId: string): string {
  return stopSessionExecution(sessionId)
    ? ' Current session container restarted to apply immediately.'
    : ' Changes apply on the next turn.';
}

function buildTokenUsageAuditPayload(
  messages: ChatMessage[],
  resultText: string | null | undefined,
  tokenUsage?: TokenUsageStats,
): Record<string, number | boolean> {
  const promptChars = messages.reduce((total, message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return total + content.length;
  }, 0);
  const completionChars = (resultText || '').length;

  const fallbackEstimatedPromptTokens =
    estimateTokenCountFromMessages(messages);
  const fallbackEstimatedCompletionTokens = estimateTokenCountFromText(
    resultText || '',
  );
  const estimatedPromptTokens =
    tokenUsage?.estimatedPromptTokens || fallbackEstimatedPromptTokens;
  const estimatedCompletionTokens =
    tokenUsage?.estimatedCompletionTokens || fallbackEstimatedCompletionTokens;
  const estimatedTotalTokens =
    tokenUsage?.estimatedTotalTokens ||
    estimatedPromptTokens + estimatedCompletionTokens;

  const apiUsageAvailable = tokenUsage?.apiUsageAvailable === true;
  const apiPromptTokens = tokenUsage?.apiPromptTokens || 0;
  const apiCompletionTokens = tokenUsage?.apiCompletionTokens || 0;
  const apiTotalTokens =
    tokenUsage?.apiTotalTokens || apiPromptTokens + apiCompletionTokens;
  const apiCacheUsageAvailable = tokenUsage?.apiCacheUsageAvailable === true;
  const apiCacheReadTokens = tokenUsage?.apiCacheReadTokens || 0;
  const apiCacheWriteTokens = tokenUsage?.apiCacheWriteTokens || 0;
  const promptTokens = apiUsageAvailable
    ? apiPromptTokens
    : estimatedPromptTokens;
  const completionTokens = apiUsageAvailable
    ? apiCompletionTokens
    : estimatedCompletionTokens;
  const totalTokens = apiUsageAvailable ? apiTotalTokens : estimatedTotalTokens;

  return {
    modelCalls: tokenUsage ? Math.max(1, tokenUsage.modelCalls) : 0,
    promptChars,
    completionChars,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedPromptTokens,
    estimatedCompletionTokens,
    estimatedTotalTokens,
    apiUsageAvailable,
    apiPromptTokens,
    apiCompletionTokens,
    apiTotalTokens,
    ...(apiCacheUsageAvailable
      ? {
          apiCacheUsageAvailable,
          apiCacheReadTokens,
          apiCacheWriteTokens,
          cacheReadTokens: apiCacheReadTokens,
          cacheReadInputTokens: apiCacheReadTokens,
          cacheWriteTokens: apiCacheWriteTokens,
          cacheWriteInputTokens: apiCacheWriteTokens,
        }
      : {}),
  };
}

export function getGatewayStatus(): GatewayStatus {
  const sandbox = getSandboxDiagnostics();
  const codex = getCodexAuthStatus();
  return {
    status: 'ok',
    pid: process.pid,
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    sessions: getSessionCount(),
    activeContainers: sandbox.activeSessions,
    defaultModel: HYBRIDAI_MODEL,
    ragDefault: HYBRIDAI_ENABLE_RAG,
    timestamp: new Date().toISOString(),
    codex: {
      authenticated: codex.authenticated,
      source: codex.source,
      accountId: codex.accountId,
      expiresAt: codex.expiresAt,
      reloginRequired: codex.reloginRequired,
    },
    sandbox,
    observability: getObservabilityIngestState(),
    scheduler: {
      jobs: getSchedulerStatus(),
    },
  };
}

export function getGatewayHistory(
  sessionId: string,
  limit = MAX_HISTORY_MESSAGES,
): StoredMessage[] {
  return memoryService
    .getConversationHistory(sessionId, Math.max(1, Math.min(limit, 200)))
    .reverse();
}

function extractDelegationDepth(sessionId: string): number {
  const match = sessionId.match(/^delegate:d(\d+):/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextDelegationSessionId(
  parentSessionId: string,
  nextDepth: number,
): string {
  const safeParent = parentSessionId
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .slice(0, 48);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `delegate:d${nextDepth}:${safeParent}:${Date.now()}:${nonce}`;
}

function resolveSubagentAllowedTools(depth: number): string[] {
  if (depth < PROACTIVE_DELEGATION_MAX_DEPTH)
    return ORCHESTRATOR_SUBAGENT_ALLOWED_TOOLS;
  return BASE_SUBAGENT_ALLOWED_TOOLS;
}

function buildSubagentSystemPrompt(params: {
  depth: number;
  canDelegate: boolean;
  mode: DelegationMode;
  allowedTools: string[];
}): string {
  const { depth, canDelegate, mode, allowedTools } = params;
  const delegationLine = canDelegate
    ? 'You may delegate further only if absolutely necessary and still within depth/turn limits.'
    : 'You are a leaf subagent. Do not delegate further work.';
  const toolsSummary = buildToolsSummary({ allowedTools });

  return [
    '# Subagent Context',
    'You are a delegated subagent spawned by a parent agent for one specific task.',
    '',
    '## Identity',
    '- You are not the end-user assistant; you are a focused worker.',
    '- The next user message is a task handoff from the parent agent.',
    '- Your final response is what the parent uses; make it complete and actionable.',
    '',
    '## Mission',
    '- Complete exactly the delegated task and return concrete results.',
    '- Stay scoped to the assigned objective; no unrelated side quests.',
    '',
    '## Runtime',
    `Delegation mode: ${mode}.`,
    `Current delegation depth: ${depth}.`,
    delegationLine,
    '',
    ...(toolsSummary ? [toolsSummary, ''] : []),
    '## Rules',
    '- Do not interact with users directly.',
    '- Do not create schedules or persistent autonomous workflows.',
    'Do not poll or sleep for completion checks; return when the task is complete.',
    '- Use tools only when needed and keep actions minimal and relevant.',
    '',
    '## Output Format (required)',
    'Use this exact section structure in your final response:',
    '## Completed',
    '- What you accomplished.',
    '## Files Touched',
    '- Exact paths read/modified (or "None").',
    '## Key Findings',
    '- The important technical results for the parent.',
    '## Issues / Limits',
    '- Errors, blockers, or confidence caveats (or "None").',
  ].join('\n');
}

function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function abbreviateForUser(
  text: string,
  maxChars = MAX_DELEGATION_USER_CHARS,
): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function classifyDelegationError(errorText: string): DelegationErrorClass {
  if (
    PERMANENT_DELEGATION_ERROR_PATTERNS.some((pattern) =>
      pattern.test(errorText),
    )
  )
    return 'permanent';
  if (
    TRANSIENT_DELEGATION_ERROR_PATTERNS.some((pattern) =>
      pattern.test(errorText),
    )
  )
    return 'transient';
  return 'unknown';
}

function inferDelegationStatus(errorText: string): DelegationRunStatus {
  return /timeout|timed out|deadline exceeded/i.test(errorText)
    ? 'timeout'
    : 'failed';
}

function normalizeDelegationTask(
  raw: unknown,
  fallbackModel: string,
): NormalizedDelegationTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as DelegationTaskSpec;
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt) return null;
  const label = typeof task.label === 'string' ? task.label.trim() : '';
  const model =
    typeof task.model === 'string' && task.model.trim()
      ? task.model.trim()
      : fallbackModel;
  return {
    prompt,
    label: label || undefined,
    model,
  };
}

function normalizeDelegationEffect(
  effect: DelegationSideEffect,
  fallbackModel: string,
): {
  plan?: NormalizedDelegationPlan;
  error?: string;
} {
  const rawMode =
    typeof effect.mode === 'string' ? effect.mode.trim().toLowerCase() : '';
  const modeRaw: DelegationMode | '' =
    rawMode === 'single' || rawMode === 'parallel' || rawMode === 'chain'
      ? rawMode
      : '';
  if (rawMode && !modeRaw) {
    return { error: 'Invalid delegation mode' };
  }

  const label = typeof effect.label === 'string' ? effect.label.trim() : '';
  const baseModel =
    typeof effect.model === 'string' && effect.model.trim()
      ? effect.model.trim()
      : fallbackModel;
  const prompt = typeof effect.prompt === 'string' ? effect.prompt.trim() : '';
  const rawTasks = Array.isArray(effect.tasks) ? effect.tasks : [];
  const rawChain = Array.isArray(effect.chain) ? effect.chain : [];

  let mode: DelegationMode;
  if (modeRaw) mode = modeRaw;
  else if (rawChain.length > 0) mode = 'chain';
  else if (rawTasks.length > 0) mode = 'parallel';
  else mode = 'single';

  if (mode === 'single') {
    if (!prompt) return { error: 'Single-mode delegation missing prompt' };
    return {
      plan: {
        mode,
        label: label || undefined,
        tasks: [{ prompt, label: label || undefined, model: baseModel }],
      },
    };
  }

  const sourceTasks = mode === 'parallel' ? rawTasks : rawChain;
  if (sourceTasks.length === 0) {
    return { error: `${mode} delegation requires at least one task` };
  }
  if (sourceTasks.length > MAX_DELEGATION_TASKS) {
    return {
      error: `${mode} delegation exceeds max tasks (${MAX_DELEGATION_TASKS})`,
    };
  }
  const tasks: NormalizedDelegationTask[] = [];
  for (let i = 0; i < sourceTasks.length; i++) {
    const normalized = normalizeDelegationTask(sourceTasks[i], baseModel);
    if (!normalized)
      return { error: `${mode} delegation task #${i + 1} is invalid` };
    tasks.push(normalized);
  }
  return {
    plan: {
      mode,
      label: label || undefined,
      tasks,
    },
  };
}

function renderDelegationTaskTitle(
  mode: DelegationMode,
  task: NormalizedDelegationTask,
  index: number,
  total: number,
): string {
  if (task.label) return task.label;
  if (mode === 'chain') return `step ${index + 1}/${total}`;
  if (mode === 'parallel') return `task ${index + 1}/${total}`;
  return 'task';
}

function interpolateChainPrompt(
  prompt: string,
  previousResult: string,
): string {
  if (!prompt.includes('{previous}')) return prompt;
  const replacement = previousResult.trim() || '(no previous output)';
  return prompt.replace(/\{previous\}/g, replacement);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDelegationTaskWithRetry(
  input: DelegationTaskRunInput,
): Promise<DelegationRunResult> {
  const {
    parentSessionId,
    childDepth,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    mode,
    task,
  } = input;
  const allowedTools = resolveSubagentAllowedTools(childDepth);
  const canDelegate = allowedTools.includes('delegate');
  const maxAttempts = PROACTIVE_AUTO_RETRY_ENABLED
    ? PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS
    : 1;
  let attempt = 0;
  let delayMs = PROACTIVE_AUTO_RETRY_BASE_DELAY_MS;
  let lastError = 'Delegation failed with unknown error';
  let lastStatus: DelegationRunStatus = 'failed';
  let lastDuration = 0;
  let lastSessionId = nextDelegationSessionId(parentSessionId, childDepth);
  let lastToolsUsed: string[] = [];
  let lastArtifacts: ArtifactMetadata[] | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    const sessionId = nextDelegationSessionId(parentSessionId, childDepth);
    lastSessionId = sessionId;
    const startedAt = Date.now();
    try {
      const output = await runAgent(
        sessionId,
        [
          {
            role: 'system',
            content: buildSubagentSystemPrompt({
              depth: childDepth,
              canDelegate,
              mode,
              allowedTools,
            }),
          },
          { role: 'user', content: task.prompt },
        ],
        chatbotId,
        enableRag,
        task.model,
        agentId,
        channelId,
        undefined,
        allowedTools,
      );
      const durationMs = Date.now() - startedAt;
      lastDuration = durationMs;
      lastToolsUsed = output.toolsUsed || [];
      lastArtifacts = output.artifacts;

      if (output.status === 'success' && output.result?.trim()) {
        return {
          status: 'completed',
          sessionId,
          model: task.model,
          durationMs,
          attempts: attempt,
          toolsUsed: output.toolsUsed || [],
          result: output.result.trim(),
          artifacts: output.artifacts,
        };
      }

      const errorText = output.error || 'Delegated run returned empty output.';
      lastError = errorText;
      lastStatus = inferDelegationStatus(errorText);
      const classification = classifyDelegationError(errorText);
      const shouldRetry =
        classification === 'transient' && attempt < maxAttempts;
      if (!shouldRetry) break;

      logger.warn(
        {
          parentSessionId,
          sessionId,
          attempt,
          maxAttempts,
          delayMs,
          errorText,
        },
        'Delegation retry scheduled after transient error',
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, PROACTIVE_AUTO_RETRY_MAX_DELAY_MS);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      lastDuration = durationMs;
      const errorText = err instanceof Error ? err.message : String(err);
      lastError = errorText;
      lastStatus = inferDelegationStatus(errorText);
      const classification = classifyDelegationError(errorText);
      const shouldRetry =
        classification === 'transient' && attempt < maxAttempts;
      if (!shouldRetry) break;
      logger.warn(
        {
          parentSessionId,
          sessionId,
          attempt,
          maxAttempts,
          delayMs,
          errorText,
        },
        'Delegation retry scheduled after transient exception',
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, PROACTIVE_AUTO_RETRY_MAX_DELAY_MS);
    }
  }

  return {
    status: lastStatus,
    sessionId: lastSessionId,
    model: task.model,
    durationMs: lastDuration,
    attempts: attempt,
    toolsUsed: lastToolsUsed,
    error: lastError,
    artifacts: lastArtifacts,
  };
}

function formatDelegationCompletion(params: {
  mode: DelegationMode;
  label?: string;
  entries: DelegationCompletionEntry[];
  totalDurationMs: number;
}): { forUser: string; forLLM: string; artifacts?: ArtifactMetadata[] } {
  const { mode, label, entries, totalDurationMs } = params;
  const completedCount = entries.filter(
    (entry) => entry.run.status === 'completed',
  ).length;
  const failedCount = entries.length - completedCount;
  const overallStatus =
    failedCount === 0
      ? 'completed'
      : completedCount === 0
        ? 'failed'
        : 'partial';
  const heading = label?.trim()
    ? `[Delegate: ${label.trim()}]`
    : `[Delegate ${mode}]`;

  const userLines = [
    `${heading} ${overallStatus} (${completedCount}/${entries.length} completed, ${formatDurationMs(totalDurationMs)}).`,
  ];
  for (const entry of entries) {
    if (entry.run.status === 'completed') {
      userLines.push(
        `- ${entry.title}: ${abbreviateForUser(entry.run.result || '')}`,
      );
    } else {
      userLines.push(
        `- ${entry.title}: ${entry.run.status} (${abbreviateForUser(entry.run.error || 'Unknown error')})`,
      );
    }
  }

  const llmLines = [
    `${heading} ${overallStatus}`,
    `mode: ${mode}`,
    `completed: ${completedCount}/${entries.length}`,
    `duration_ms_total: ${totalDurationMs}`,
    '',
  ];
  for (const entry of entries) {
    llmLines.push(`## ${entry.title}`);
    llmLines.push(`status: ${entry.run.status}`);
    llmLines.push(`session_id: ${entry.run.sessionId}`);
    llmLines.push(`model: ${entry.run.model}`);
    llmLines.push(`duration_ms: ${entry.run.durationMs}`);
    llmLines.push(`attempts: ${entry.run.attempts}`);
    if (entry.run.toolsUsed.length > 0) {
      llmLines.push(`tools_used: ${entry.run.toolsUsed.join(', ')}`);
    }
    if (entry.run.status === 'completed') {
      llmLines.push('');
      llmLines.push(entry.run.result || '(empty result)');
    } else {
      llmLines.push(`error: ${entry.run.error || 'Unknown error'}`);
    }
    llmLines.push('');
  }

  const artifacts: ArtifactMetadata[] = [];
  const seenArtifactKeys = new Set<string>();
  for (const entry of entries) {
    for (const artifact of entry.run.artifacts || []) {
      if (!artifact?.path) continue;
      const key = `${artifact.path}|${artifact.filename}|${artifact.mimeType}`;
      if (seenArtifactKeys.has(key)) continue;
      seenArtifactKeys.add(key);
      artifacts.push(artifact);
    }
  }

  return {
    forUser: abbreviateForUser(userLines.join('\n')),
    forLLM: llmLines.join('\n').trimEnd(),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

async function publishDelegationCompletion(params: {
  parentSessionId: string;
  channelId: string;
  agentId: string;
  forLLM: string;
  forUser: string;
  artifacts?: ArtifactMetadata[];
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
}): Promise<void> {
  const {
    parentSessionId,
    channelId,
    agentId,
    forLLM,
    forUser,
    artifacts,
    onProactiveMessage,
  } = params;

  memoryService.storeMessage({
    sessionId: parentSessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: forLLM,
  });
  appendSessionTranscript(agentId, {
    sessionId: parentSessionId,
    channelId,
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: forLLM,
  });

  if (onProactiveMessage) {
    await onProactiveMessage({ text: forUser, artifacts });
    return;
  }
  logger.info(
    {
      parentSessionId,
      message: forUser,
      artifactCount: artifacts?.length || 0,
    },
    'Delegation completion (no proactive channel callback)',
  );
}

function enqueueDelegationFromSideEffect(params: {
  plan: NormalizedDelegationPlan;
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  parentDepth: number;
}): void {
  const {
    plan,
    parentSessionId,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    onProactiveMessage,
    parentDepth,
  } = params;
  const childDepth = parentDepth + 1;
  if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
    logger.info(
      { parentSessionId, childDepth, maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH },
      'Delegation skipped — depth limit reached',
    );
    return;
  }

  const jobId = `${parentSessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  enqueueDelegation({
    id: jobId,
    run: async () => {
      const startedAt = Date.now();
      const entries: DelegationCompletionEntry[] = [];

      if (plan.mode === 'parallel') {
        const runs = await Promise.all(
          plan.tasks.map(async (task, index) => {
            const run = await runDelegationTaskWithRetry({
              parentSessionId,
              childDepth,
              channelId,
              chatbotId,
              enableRag,
              agentId,
              mode: plan.mode,
              task,
            });
            return {
              title: renderDelegationTaskTitle(
                plan.mode,
                task,
                index,
                plan.tasks.length,
              ),
              run,
            } as DelegationCompletionEntry;
          }),
        );
        entries.push(...runs);
      } else if (plan.mode === 'chain') {
        let previousResult = '';
        for (let i = 0; i < plan.tasks.length; i++) {
          const task = plan.tasks[i];
          const run = await runDelegationTaskWithRetry({
            parentSessionId,
            childDepth,
            channelId,
            chatbotId,
            enableRag,
            agentId,
            mode: plan.mode,
            task: {
              ...task,
              prompt: interpolateChainPrompt(task.prompt, previousResult),
            },
          });
          entries.push({
            title: renderDelegationTaskTitle(
              plan.mode,
              task,
              i,
              plan.tasks.length,
            ),
            run,
          });
          if (run.status !== 'completed') break;
          previousResult = run.result || '';
        }
      } else {
        const task = plan.tasks[0];
        const run = await runDelegationTaskWithRetry({
          parentSessionId,
          childDepth,
          channelId,
          chatbotId,
          enableRag,
          agentId,
          mode: plan.mode,
          task,
        });
        entries.push({
          title: renderDelegationTaskTitle(plan.mode, task, 0, 1),
          run,
        });
      }

      if (entries.length === 0) {
        logger.warn(
          { parentSessionId, mode: plan.mode },
          'Delegation produced no entries',
        );
        return;
      }

      const completion = formatDelegationCompletion({
        mode: plan.mode,
        label: plan.label,
        entries,
        totalDurationMs: Date.now() - startedAt,
      });
      await publishDelegationCompletion({
        parentSessionId,
        channelId,
        agentId,
        forLLM: completion.forLLM,
        forUser: completion.forUser,
        artifacts: completion.artifacts,
        onProactiveMessage,
      });
    },
  });
}

export async function handleGatewayMessage(
  req: GatewayChatRequest,
): Promise<GatewayChatResult> {
  const startedAt = Date.now();
  const runId = makeAuditRunId('turn');
  const session = memoryService.getOrCreateSession(
    req.sessionId,
    req.guildId,
    req.channelId,
  );
  const chatbotId = req.chatbotId ?? session.chatbot_id ?? HYBRIDAI_CHATBOT_ID;
  const enableRag = req.enableRag ?? session.enable_rag === 1;
  const model = req.model ?? session.model ?? HYBRIDAI_MODEL;
  const provider = resolveModelProvider(model);
  const turnIndex = session.message_count + 1;
  const media = normalizeMediaContextItems(req.media);
  const debugMeta = {
    sessionId: req.sessionId,
    guildId: req.guildId,
    channelId: req.channelId,
    userId: req.userId,
    model,
    provider,
    turnIndex,
    mediaCount: media.length,
    contentLength: req.content.length,
    streamingRequested: Boolean(req.onTextDelta || req.onToolProgress),
  };

  logger.debug(debugMeta, 'Gateway chat request received');

  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
    event: {
      type: 'session.start',
      userId: req.userId,
      channel: req.channelId,
      cwd: process.cwd(),
      model,
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
    event: {
      type: 'turn.start',
      turnIndex,
      userInput: req.content,
      username: req.username,
      mediaCount: media.length,
    },
  });

  if (modelRequiresChatbotId(model) && !chatbotId) {
    const error =
      'No chatbot configured. Set `hybridai.defaultChatbotId` in ~/.hybridclaw/config.json or select a bot for this session.';
    logger.warn(
      {
        ...debugMeta,
        sessionModel: session.model ?? null,
        sessionChatbotId: session.chatbot_id ?? null,
        requestChatbotId: req.chatbotId ?? null,
        defaultModel: HYBRIDAI_MODEL,
        defaultChatbotConfigured: Boolean(HYBRIDAI_CHATBOT_ID),
        durationMs: Date.now() - startedAt,
      },
      'Gateway chat blocked by missing chatbot configuration',
    );
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'configuration',
        message: error,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error,
    };
  }

  const agentId = resolveAgentIdForModel(model, chatbotId);
  ensureBootstrapFiles(agentId);

  if (isVersionOnlyQuestion(req.content)) {
    const resultText = `HybridClaw v${APP_VERSION}`;
    recordSuccessfulTurn({
      sessionId: req.sessionId,
      agentId,
      chatbotId,
      enableRag,
      model,
      channelId: req.channelId,
      runId,
      turnIndex,
      userId: req.userId,
      username: req.username,
      userContent: req.content,
      resultText,
      toolCallCount: 0,
      startedAt,
    });
    return {
      status: 'success',
      result: resultText,
      toolsUsed: [],
    };
  }

  const history = memoryService
    .getConversationHistory(req.sessionId, MAX_HISTORY_MESSAGES * 2)
    .filter((message) => !isSilentReply(message.content))
    .slice(0, MAX_HISTORY_MESSAGES);
  let canonicalContext: CanonicalSessionContext = {
    summary: null,
    recent_messages: [],
  };
  if (req.userId.trim()) {
    try {
      canonicalContext = memoryService.getCanonicalContext({
        agentId,
        userId: req.userId,
        windowSize: 12,
        excludeSessionId: req.sessionId,
      });
      canonicalContext = {
        ...canonicalContext,
        recent_messages: canonicalContext.recent_messages.filter(
          (message) => !isSilentReply(message.content),
        ),
      };
    } catch (err) {
      logger.debug(
        { sessionId: req.sessionId, userId: req.userId, err },
        'Failed to load canonical session context',
      );
    }
  }
  const canonicalPromptSummary = formatCanonicalContextPrompt({
    summary: canonicalContext.summary,
    recentMessages: canonicalContext.recent_messages,
  });
  const memoryContext = memoryService.buildPromptMemoryContext({
    session,
    query: req.content,
  });
  const mergedSessionSummary =
    [canonicalPromptSummary, memoryContext.promptSummary]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      .join('\n\n')
      .trim() || null;
  const mediaPolicy = resolveMediaToolPolicy(req.content, media);
  const { messages, skills, historyStats } = buildConversationContext({
    agentId,
    sessionSummary: mergedSessionSummary,
    history,
    runtimeInfo: {
      chatbotId,
      model,
      defaultModel: HYBRIDAI_MODEL,
      channelType: 'discord',
      channelId: req.channelId,
      guildId: req.guildId,
    },
    blockedTools: mediaPolicy.blockedTools,
  });
  const historyStart =
    messages.length > 0 && messages[0].role === 'system' ? 1 : 0;
  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
    event: {
      type: 'context.optimization',
      historyMessagesOriginal: historyStats.originalCount,
      historyMessagesIncluded: historyStats.includedCount,
      historyMessagesDropped: historyStats.droppedCount,
      historyCharsOriginal: historyStats.originalChars,
      historyCharsPreBudget: historyStats.preBudgetChars,
      historyCharsIncluded: historyStats.includedChars,
      historyCharsDropped: historyStats.droppedChars,
      historyMaxChars: historyStats.maxTotalChars,
      historyMaxMessageChars: historyStats.maxMessageChars,
      perMessageTruncatedCount: historyStats.perMessageTruncatedCount,
      middleCompressionApplied: historyStats.middleCompressionApplied,
      historyEstimatedTokens: estimateTokenCountFromMessages(
        messages.slice(historyStart),
      ),
      canonicalSummaryIncluded: Boolean(canonicalPromptSummary),
      canonicalRecentMessagesIncluded: canonicalContext.recent_messages.length,
    },
  });
  if (mediaPolicy.prioritizeVisionTool) {
    logger.info(
      {
        sessionId: req.sessionId,
        mediaCount: media.length,
        blockedTools: mediaPolicy.blockedTools || [],
      },
      'Routing Discord image question to vision_analyze tool',
    );
  }
  const mediaContextBlock = buildMediaPromptContext(media);
  const expandedUserContent = expandSkillInvocation(req.content, skills);
  const agentUserContent = mediaContextBlock
    ? `${expandedUserContent}\n\n${mediaContextBlock}`
    : expandedUserContent;
  logger.debug(
    {
      ...debugMeta,
      durationMs: Date.now() - startedAt,
      historyMessages: history.length,
      promptMessages: messages.length + 1,
      skillsLoaded: skills.length,
      blockedTools: mediaPolicy.blockedTools || [],
      scheduledTaskHistoryCount: historyStats.includedCount,
    },
    'Gateway chat context prepared',
  );
  messages.push({
    role: 'user',
    content: agentUserContent,
  });

  try {
    const scheduledTasks: ScheduledTask[] = getTasksForSession(req.sessionId);
    let firstTextDeltaMs: number | null = null;
    const onTextDelta = (delta: string): void => {
      if (firstTextDeltaMs == null && delta) {
        firstTextDeltaMs = Date.now() - startedAt;
        logger.debug(
          {
            ...debugMeta,
            firstTextDeltaMs,
            firstDeltaChars: delta.length,
          },
          'Gateway chat emitted first text delta',
        );
      }
      req.onTextDelta?.(delta);
    };
    const onToolProgress = (event: ToolProgressEvent): void => {
      logger.debug(
        {
          ...debugMeta,
          toolName: event.toolName,
          phase: event.phase,
          toolDurationMs: event.durationMs ?? null,
          sinceStartMs: Date.now() - startedAt,
        },
        'Gateway tool progress',
      );
      req.onToolProgress?.(event);
    };
    logger.debug(
      {
        ...debugMeta,
        scheduledTaskCount: scheduledTasks.length,
      },
      'Gateway chat invoking agent',
    );
    const output = await runAgent(
      req.sessionId,
      messages,
      chatbotId,
      enableRag,
      model,
      agentId,
      req.channelId,
      scheduledTasks,
      undefined,
      mediaPolicy.blockedTools,
      onTextDelta,
      onToolProgress,
      req.abortSignal,
      media,
    );
    const effectiveUserContent =
      typeof output.effectiveUserPrompt === 'string' &&
      output.effectiveUserPrompt.trim()
        ? output.effectiveUserPrompt.trim()
        : req.content;
    const toolExecutions = output.toolExecutions || [];
    emitToolExecutionAuditEvents({
      sessionId: req.sessionId,
      runId,
      toolExecutions,
    });
    const usagePayload = buildTokenUsageAuditPayload(
      messages,
      output.result,
      output.tokenUsage,
    );
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'model.usage',
        provider,
        model,
        durationMs: Date.now() - startedAt,
        toolCallCount: toolExecutions.length,
        ...usagePayload,
      },
    });
    recordUsageEvent({
      sessionId: req.sessionId,
      agentId,
      model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      toolCalls: toolExecutions.length,
      costUsd: extractUsageCostUsd(output.tokenUsage),
    });

    const parentDepth = extractDelegationDepth(req.sessionId);
    let acceptedDelegations = 0;
    processSideEffects(output, req.sessionId, req.channelId, {
      onDelegation: (effect) => {
        const normalized = normalizeDelegationEffect(effect, model);
        if (!normalized.plan) {
          logger.warn(
            {
              sessionId: req.sessionId,
              error: normalized.error || 'unknown',
              effect,
            },
            'Delegation skipped — invalid payload',
          );
          return;
        }

        const childDepth = parentDepth + 1;
        if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
          logger.info(
            {
              sessionId: req.sessionId,
              childDepth,
              maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH,
            },
            'Delegation skipped — depth limit reached',
          );
          return;
        }

        const requestedRuns = normalized.plan.tasks.length;
        if (
          acceptedDelegations + requestedRuns >
          PROACTIVE_DELEGATION_MAX_PER_TURN
        ) {
          logger.info(
            {
              sessionId: req.sessionId,
              limit: PROACTIVE_DELEGATION_MAX_PER_TURN,
              requestedRuns,
              acceptedDelegations,
            },
            'Delegation skipped — per-turn limit reached',
          );
          return;
        }
        acceptedDelegations += requestedRuns;
        enqueueDelegationFromSideEffect({
          plan: normalized.plan,
          parentSessionId: req.sessionId,
          channelId: req.channelId,
          chatbotId,
          enableRag,
          agentId,
          onProactiveMessage: req.onProactiveMessage,
          parentDepth,
        });
      },
    });

    if (output.status === 'error') {
      const errorMessage = output.error || 'Unknown agent error.';
      logger.debug(
        {
          ...debugMeta,
          durationMs: Date.now() - startedAt,
          toolCallCount: toolExecutions.length,
          firstTextDeltaMs,
          artifactCount: output.artifacts?.length || 0,
        },
        'Gateway chat completed with agent error',
      );
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'error',
          errorType: 'agent',
          message: errorMessage,
          recoverable: true,
        },
      });
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex,
          finishReason: 'error',
        },
      });
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'session.end',
          reason: 'error',
          stats: {
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: toolExecutions.length,
            durationMs: Date.now() - startedAt,
          },
        },
      });
      return {
        status: 'error',
        result: null,
        toolsUsed: output.toolsUsed || [],
        artifacts: output.artifacts,
        toolExecutions,
        tokenUsage: output.tokenUsage,
        error: errorMessage,
      };
    }

    const resultText = output.result || 'No response from agent.';
    logger.debug(
      {
        ...debugMeta,
        durationMs: Date.now() - startedAt,
        toolCallCount: toolExecutions.length,
        firstTextDeltaMs,
        artifactCount: output.artifacts?.length || 0,
      },
      'Gateway chat completed successfully',
    );
    recordSuccessfulTurn({
      sessionId: req.sessionId,
      agentId,
      chatbotId,
      enableRag,
      model,
      channelId: req.channelId,
      runId,
      turnIndex,
      userId: req.userId,
      username: req.username,
      userContent: effectiveUserContent,
      resultText,
      toolCallCount: toolExecutions.length,
      startedAt,
    });

    return {
      status: 'success',
      result: resultText,
      toolsUsed: output.toolsUsed || [],
      artifacts: output.artifacts,
      toolExecutions,
      tokenUsage: output.tokenUsage,
      effectiveUserPrompt: output.effectiveUserPrompt,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logAudit(
      'error',
      req.sessionId,
      { error: errorMsg },
      Date.now() - startedAt,
    );
    logger.error(
      { ...debugMeta, durationMs: Date.now() - startedAt, err },
      'Gateway message handling failed',
    );
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'gateway',
        message: errorMsg,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      toolExecutions: undefined,
      error: errorMsg,
    };
  }
}

export async function runGatewayScheduledTask(
  origSessionId: string,
  channelId: string,
  prompt: string,
  taskId: number,
  onResult: (result: ProactiveMessagePayload) => Promise<void>,
  onError: (error: unknown) => void,
  runKey?: string,
): Promise<void> {
  const session = memoryService.getOrCreateSession(
    origSessionId,
    null,
    channelId,
  );
  const chatbotId = session.chatbot_id || HYBRIDAI_CHATBOT_ID;
  const model = session.model || HYBRIDAI_MODEL;
  if (modelRequiresChatbotId(model) && !chatbotId) {
    logger.warn(
      {
        sessionId: origSessionId,
        channelId,
        taskId,
        model,
        sessionModel: session.model ?? null,
        sessionChatbotId: session.chatbot_id ?? null,
        defaultModel: HYBRIDAI_MODEL,
        defaultChatbotConfigured: Boolean(HYBRIDAI_CHATBOT_ID),
      },
      'Scheduled task skipped due to missing chatbot configuration',
    );
    return;
  }
  const agentId = resolveAgentIdForModel(model, chatbotId);

  await runIsolatedScheduledTask({
    taskId,
    prompt,
    channelId,
    chatbotId,
    model,
    agentId,
    sessionKey: runKey,
    onResult,
    onError,
  });
}

export async function handleGatewayCommand(
  req: GatewayCommandRequest,
): Promise<GatewayCommandResult> {
  const cmd = (req.args[0] || '').toLowerCase();
  const session = memoryService.getOrCreateSession(
    req.sessionId,
    req.guildId,
    req.channelId,
  );

  switch (cmd) {
    case 'help': {
      const help = [
        '`bot list` — List available bots',
        '`bot set <id|name>` — Set chatbot for this session',
        '`bot info` — Show current chatbot settings',
        '`model list` — List available models',
        '`model set <name>` — Set model for this session',
        '`model default [name]` — Show or set default model for new sessions',
        '`model info` — Show current model',
        '`rag [on|off]` — Toggle or set RAG mode',
        '`channel mode [off|mention|free]` — Set or inspect this Discord channel response mode',
        '`channel policy [open|allowlist|disabled]` — Set or inspect guild channel policy',
        '`ralph [on|off|set <n>|info]` — Configure Ralph loop (0 off, -1 unlimited)',
        '`mcp list` — List configured MCP servers',
        '`mcp add <name> <json>` — Add or update an MCP server config',
        '`mcp remove <name>` — Remove an MCP server config',
        '`mcp toggle <name>` — Enable or disable an MCP server',
        '`mcp reconnect <name>` — Restart current session runtime so the server reconnects next turn',
        '`clear` — Clear session history',
        '`/compact` — Archive older history, summarize it, and retain recent context',
        '`/status` — Show runtime status (Discord slash command, private to caller)',
        '`/approve [view|yes|session|agent|no] [approval_id]` — View/respond to pending approvals privately',
        '`/channel-mode <off|mention|free>` — Set this Discord channel response mode',
        '`/channel-policy <open|allowlist|disabled>` — Set Discord guild channel policy',
        '`/model info` — Show current default model and allowed list',
        '`/model default <name>` — Set default model for new sessions',
        '`sessions` — List active sessions',
        '`usage [summary|daily|monthly|model [daily|monthly] [agentId]]` — Usage/cost aggregates',
        '`export session [sessionId]` — Export session JSONL snapshot for debugging',
        '`audit [sessionId]` — Show recent structured audit events for a session',
        '`schedule add "<cron>" <prompt>` — Add cron scheduled task',
        '`schedule add at "<ISO time>" <prompt>` — Add one-shot task',
        '`schedule add every <ms> <prompt>` — Add interval task',
        '`schedule list` — List scheduled tasks',
        '`schedule remove <id>` — Remove a task',
        '`schedule toggle <id>` — Enable/disable a task',
      ];
      return infoCommand('HybridClaw Commands', help.join('\n'));
    }

    case 'bot': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'list') {
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          if (bots.length === 0) return plainCommand('No bots available.');
          const list = bots
            .map(
              (b) =>
                `• ${b.name} (${b.id})${b.description ? ` — ${b.description}` : ''}`,
            )
            .join('\n');
          return infoCommand('Available Bots', list);
        } catch (err) {
          return badCommand('Error', formatHybridAIBotFetchError(err));
        }
      }

      if (sub === 'set') {
        const requested = req.args.slice(2).join(' ').trim();
        if (!requested)
          return badCommand('Usage', 'Usage: `bot set <id|name>`');
        let resolvedBotId = requested;
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          const matched = bots.find(
            (b) =>
              b.id === requested ||
              b.name.toLowerCase() === requested.toLowerCase(),
          );
          if (matched) resolvedBotId = matched.id;
        } catch {
          // keep user-supplied value when lookup fails
        }
        updateSessionChatbot(session.id, resolvedBotId);
        return plainCommand(
          `Chatbot set to \`${resolvedBotId}\` for this session.`,
        );
      }

      if (sub === 'info') {
        const botId = session.chatbot_id || HYBRIDAI_CHATBOT_ID || 'Not set';
        let botLabel = botId;
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          const bot = bots.find((b) => b.id === botId);
          if (bot) botLabel = `${bot.name} (${bot.id})`;
        } catch {
          // keep ID fallback
        }
        const model = session.model || HYBRIDAI_MODEL;
        const ragStatus = session.enable_rag ? 'Enabled' : 'Disabled';
        return infoCommand(
          'Bot Info',
          `Chatbot: ${botLabel}\nModel: ${model}\nRAG: ${ragStatus}`,
        );
      }

      return badCommand('Usage', 'Usage: `bot list|set <id|name>|info`');
    }

    case 'model': {
      const availableModels = CONFIGURED_MODELS;
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'list') {
        const current = session.model || HYBRIDAI_MODEL;
        const list = availableModels
          .map((m) => (m === current ? `${m} (current)` : m))
          .join('\n');
        return infoCommand('Available Models', list);
      }

      if (sub === 'default') {
        const modelName = req.args[2];
        if (!modelName) {
          const defaultLine = `Default model: ${HYBRIDAI_MODEL}`;
          if (availableModels.length === 0) {
            return infoCommand('Default Model', defaultLine);
          }
          const list = availableModels
            .map((m) => (m === HYBRIDAI_MODEL ? `${m} (default)` : m))
            .join('\n');
          return infoCommand('Default Model', `${defaultLine}\n\n${list}`);
        }
        if (
          availableModels.length > 0 &&
          !availableModels.includes(modelName)
        ) {
          return badCommand(
            'Unknown Model',
            `\`${modelName}\` is not in the available models list.`,
          );
        }
        updateRuntimeConfig((draft) => {
          draft.hybridai.defaultModel = modelName;
        });
        return plainCommand(
          `Default model set to \`${modelName}\` for new sessions.`,
        );
      }

      if (sub === 'set') {
        const modelName = req.args[2];
        if (!modelName) return badCommand('Usage', 'Usage: `model set <name>`');
        if (
          availableModels.length > 0 &&
          !availableModels.includes(modelName)
        ) {
          return badCommand(
            'Unknown Model',
            `\`${modelName}\` is not in the available models list.`,
          );
        }
        updateSessionModel(session.id, modelName);
        return plainCommand(`Model set to \`${modelName}\` for this session.`);
      }

      if (sub === 'info') {
        const current = session.model || HYBRIDAI_MODEL;
        return infoCommand(
          'Model Info',
          `Current model: ${current}\nDefault model: ${HYBRIDAI_MODEL}`,
        );
      }

      return badCommand(
        'Usage',
        'Usage: `model list|set <name>|default [name]|info`',
      );
    }

    case 'rag': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'on' || sub === 'off') {
        updateSessionRag(session.id, sub === 'on');
        return plainCommand(
          `RAG ${sub === 'on' ? 'enabled' : 'disabled'} for this session.`,
        );
      }
      if (!sub) {
        const nextEnabled = session.enable_rag === 0;
        updateSessionRag(session.id, nextEnabled);
        return plainCommand(
          `RAG ${nextEnabled ? 'enabled' : 'disabled'} for this session.`,
        );
      }
      return badCommand('Usage', 'Usage: `rag [on|off]`');
    }

    case 'channel': {
      const sub = (req.args[1] || '').toLowerCase();
      if (sub === 'mode' || !sub) {
        const guildId = req.guildId;
        if (!guildId) {
          return badCommand(
            'Guild Only',
            '`channel mode` is only available in Discord guild channels.',
          );
        }
        const requestedMode = (req.args[sub ? 2 : 1] || '').toLowerCase();
        if (!requestedMode) {
          const currentMode = resolveGuildChannelMode(guildId, req.channelId);
          return infoCommand(
            'Channel Mode',
            [
              `Current mode: \`${currentMode}\``,
              `Group policy: \`${DISCORD_GROUP_POLICY}\``,
              `Config path: \`discord.guilds.${guildId}.channels.${req.channelId}.mode\``,
              'Usage: `channel mode off|mention|free`',
            ].join('\n'),
          );
        }
        if (!DISCORD_CHANNEL_MODE_VALUES.has(requestedMode)) {
          return badCommand('Usage', 'Usage: `channel mode off|mention|free`');
        }
        const mode = requestedMode as 'off' | 'mention' | 'free';
        updateRuntimeConfig((draft) => {
          const guild = draft.discord.guilds[guildId] ?? {
            defaultMode: 'mention',
            channels: {},
          };
          guild.channels[req.channelId] = { mode };
          draft.discord.guilds[guildId] = guild;
        });
        return plainCommand(
          `Set channel mode to \`${mode}\` for this channel. (Policy: \`${DISCORD_GROUP_POLICY}\`)`,
        );
      }

      if (sub === 'policy') {
        const requestedPolicy = (req.args[2] || '').toLowerCase();
        if (!requestedPolicy) {
          return infoCommand(
            'Channel Policy',
            [
              `Current policy: \`${DISCORD_GROUP_POLICY}\``,
              'Policies:',
              '• `open` — all guild channels are active unless a per-channel mode overrides',
              '• `allowlist` — only channels listed under `discord.guilds.<guild>.channels` are active',
              '• `disabled` — all guild channels are disabled',
              'Usage: `channel policy open|allowlist|disabled`',
            ].join('\n'),
          );
        }
        if (!DISCORD_GROUP_POLICY_VALUES.has(requestedPolicy)) {
          return badCommand(
            'Usage',
            'Usage: `channel policy open|allowlist|disabled`',
          );
        }
        const policy = requestedPolicy as 'open' | 'allowlist' | 'disabled';
        updateRuntimeConfig((draft) => {
          draft.discord.groupPolicy = policy;
        });
        return plainCommand(`Discord group policy set to \`${policy}\`.`);
      }

      return badCommand(
        'Usage',
        'Usage: `channel mode [off|mention|free]` or `channel policy [open|allowlist|disabled]`',
      );
    }

    case 'ralph': {
      const sub = (req.args[1] || '').toLowerCase();
      if (!sub || sub === 'info' || sub === 'status') {
        const current = normalizeRalphIterations(
          PROACTIVE_RALPH_MAX_ITERATIONS,
        );
        return infoCommand(
          'Ralph Loop',
          [
            `Current: ${formatRalphIterations(current)}`,
            'Usage: `ralph on|off|set <n>|info`',
            'Set values: `0` disables, `-1` is unlimited, `1-64` are extra autonomous iterations.',
          ].join('\n'),
        );
      }

      let nextValue: number | null = null;
      if (sub === 'on') {
        nextValue =
          PROACTIVE_RALPH_MAX_ITERATIONS === 0
            ? 3
            : PROACTIVE_RALPH_MAX_ITERATIONS;
      } else if (sub === 'off') {
        nextValue = 0;
      } else if (sub === 'set') {
        if (req.args[2] == null) {
          return badCommand(
            'Usage',
            'Usage: `ralph set <n>` (0=off, -1=unlimited, 1-64=extra iterations)',
          );
        }
        const parsed = Number.parseInt(req.args[2], 10);
        if (Number.isNaN(parsed)) {
          return badCommand(
            'Usage',
            'Usage: `ralph set <n>` where n is an integer',
          );
        }
        if (parsed < -1 || parsed > MAX_RALPH_ITERATIONS) {
          return badCommand(
            'Range',
            `Ralph iterations must be between -1 and ${MAX_RALPH_ITERATIONS}.`,
          );
        }
        nextValue = parsed;
      } else {
        const parsed = Number.parseInt(sub, 10);
        if (Number.isNaN(parsed)) {
          return badCommand('Usage', 'Usage: `ralph on|off|set <n>|info`');
        }
        if (parsed < -1 || parsed > MAX_RALPH_ITERATIONS) {
          return badCommand(
            'Range',
            `Ralph iterations must be between -1 and ${MAX_RALPH_ITERATIONS}.`,
          );
        }
        nextValue = parsed;
      }

      const normalized = normalizeRalphIterations(nextValue);
      updateRuntimeConfig((draft) => {
        draft.proactive.ralph.maxIterations = normalized;
      });
      const restarted = stopSessionExecution(req.sessionId);
      const restartNote = restarted
        ? ' Current session container restarted to apply immediately.'
        : '';
      return plainCommand(
        `Ralph loop set to ${formatRalphIterations(normalized)}.${restartNote}`,
      );
    }

    case 'mcp': {
      const sub = (req.args[1] || 'list').toLowerCase();
      const runtimeConfig = getRuntimeConfig();
      const servers = runtimeConfig.mcpServers || {};

      if (sub === 'list') {
        const entries = Object.entries(servers);
        if (entries.length === 0) {
          return plainCommand(
            'No MCP servers configured. Use `mcp add <name> <json>`.',
          );
        }
        entries.sort(([left], [right]) => left.localeCompare(right));
        return infoCommand(
          'MCP Servers',
          entries
            .map(([name, config]) => summarizeMcpServer(name, config))
            .join('\n'),
        );
      }

      if (sub === 'add') {
        const parsedName = parseMcpServerName(String(req.args[2] || ''));
        if (!parsedName.name) {
          return badCommand(
            parsedName.error === 'Usage: `mcp add <name> <json>`'
              ? 'Usage'
              : 'Invalid MCP Name',
            parsedName.error || 'Invalid MCP server name.',
          );
        }
        const name = parsedName.name;
        const parsed = parseMcpServerConfig(req.args.slice(3).join(' '));
        if (!parsed.config) {
          return badCommand(
            'Invalid MCP Config',
            parsed.error || 'Invalid config.',
          );
        }
        updateRuntimeConfig((draft) => {
          draft.mcpServers[name] = parsed.config as McpServerConfig;
        });
        return plainCommand(
          `MCP server \`${name}\` saved.${restartNoteForMcpChange(req.sessionId)}`,
        );
      }

      if (sub === 'remove') {
        const name = String(req.args[2] || '').trim();
        if (!name) {
          return badCommand('Usage', 'Usage: `mcp remove <name>`');
        }
        if (!servers[name]) {
          return badCommand(
            'Not Found',
            `MCP server \`${name}\` was not found.`,
          );
        }
        updateRuntimeConfig((draft) => {
          delete draft.mcpServers[name];
        });
        return plainCommand(
          `MCP server \`${name}\` removed.${restartNoteForMcpChange(req.sessionId)}`,
        );
      }

      if (sub === 'toggle') {
        const name = String(req.args[2] || '').trim();
        if (!name) {
          return badCommand('Usage', 'Usage: `mcp toggle <name>`');
        }
        const existing = servers[name];
        if (!existing) {
          return badCommand(
            'Not Found',
            `MCP server \`${name}\` was not found.`,
          );
        }
        const nextEnabled = existing.enabled === false;
        updateRuntimeConfig((draft) => {
          const entry = draft.mcpServers[name];
          if (entry) entry.enabled = nextEnabled;
        });
        return plainCommand(
          `MCP server \`${name}\` ${nextEnabled ? 'enabled' : 'disabled'}.${restartNoteForMcpChange(req.sessionId)}`,
        );
      }

      if (sub === 'reconnect') {
        const name = String(req.args[2] || '').trim();
        if (!name) {
          return badCommand('Usage', 'Usage: `mcp reconnect <name>`');
        }
        if (!servers[name]) {
          return badCommand(
            'Not Found',
            `MCP server \`${name}\` was not found.`,
          );
        }
        return plainCommand(
          `MCP server \`${name}\` scheduled for reconnect.${restartNoteForMcpChange(req.sessionId)}`,
        );
      }

      return badCommand(
        'Usage',
        'Usage: `mcp list|add <name> <json>|remove <name>|toggle <name>|reconnect <name>`',
      );
    }

    case 'clear': {
      const deleted = memoryService.clearSessionHistory(session.id);
      return infoCommand(
        'Session Cleared',
        `Deleted ${deleted} messages. Workspace files preserved.`,
      );
    }

    case 'compact': {
      try {
        const result = await memoryService.compactSession(session.id);
        const compressionRatio =
          result.tokensBefore > 0
            ? 1 - result.tokensAfter / result.tokensBefore
            : 0;
        return infoCommand(
          'Session Compacted',
          [
            `Tokens: ${formatCompactNumber(result.tokensBefore)} -> ${formatCompactNumber(result.tokensAfter)} (${formatPercent(compressionRatio)} smaller)`,
            `Messages: compacted ${result.messagesCompacted}, preserved ${result.messagesPreserved}`,
            `Archive: ${formatArchiveReference(result.archivePath)}`,
          ].join('\n'),
        );
      } catch (err) {
        if (err instanceof NoCompactableMessagesError) {
          return plainCommand(
            'Nothing to compact. The session is already within the preserved recent window.',
          );
        }
        return badCommand(
          'Compaction Failed',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    case 'status': {
      const status = getGatewayStatus();
      const delegationStatus = delegationQueueStatus();
      const commitShort = resolveGitCommitShort();
      const sessionModel = session.model || HYBRIDAI_MODEL;
      const modelContextWindowTokens =
        resolveModelContextWindowFallback(sessionModel);
      const metrics = readSessionStatusSnapshot(session.id, {
        modelContextWindowTokens,
      });
      const queueLabel = `${delegationStatus.active} active / ${delegationStatus.queued} queued`;
      const proactiveQueued = getQueuedProactiveMessageCount();
      const cacheKnown =
        metrics.cacheReadTokens != null || metrics.cacheWriteTokens != null;
      const contextLabel =
        metrics.contextUsedTokens != null && metrics.contextBudgetTokens != null
          ? `${formatCompactNumber(metrics.contextUsedTokens)}/${formatCompactNumber(metrics.contextBudgetTokens)} (${formatPercent(metrics.contextUsagePercent)})`
          : metrics.contextUsedTokens != null
            ? `${formatCompactNumber(metrics.contextUsedTokens)}/? (window unknown)`
            : 'n/a';
      const sandboxLabel = `${status.sandbox?.mode || 'container'} (${status.sandbox?.activeSessions ?? status.activeContainers} active)`;
      const lines = [
        `🦞 HybridClaw v${status.version}${commitShort ? ` (${commitShort})` : ''}`,
        `🧠 Model: ${sessionModel}`,
        `🧮 Tokens: ${formatCompactNumber(metrics.promptTokens)} in / ${formatCompactNumber(metrics.completionTokens)} out`,
        cacheKnown
          ? `🗄️ Cache: ${formatPercent(metrics.cacheHitPercent)} hit · ${formatCompactNumber(metrics.cacheReadTokens)} cached, ${formatCompactNumber(metrics.cacheWriteTokens)} new`
          : '🗄️ Cache: n/a (provider did not report cache stats)',
        `📚 Context: ${contextLabel} · 🧹 Compactions: ${session.compaction_count}`,
        `📊 Usage: uptime ${formatUptime(status.uptime)} · sessions ${status.sessions} · sandbox ${sandboxLabel}`,
        `🧵 Session: ${session.id} • updated ${formatRelativeTime(session.last_active)}`,
        `⚙️ Runtime: ${status.sandbox?.mode || 'container'} · RAG: ${session.enable_rag ? 'on' : 'off'} · Ralph: ${formatRalphIterations(normalizeRalphIterations(PROACTIVE_RALPH_MAX_ITERATIONS))}`,
        `👥 Activation: ${resolveActivationModeLabel()} · 🪢 Queue: ${queueLabel} · 📬 Proactive queued: ${proactiveQueued}`,
      ];
      return infoCommand('Status', lines.join('\n'));
    }

    case 'sessions': {
      const sessions = getAllSessions();
      if (sessions.length === 0) return plainCommand('No active sessions.');
      const list = sessions
        .slice(0, 20)
        .map(
          (s) =>
            `${s.id} — ${s.message_count} msgs, last active ${s.last_active}`,
        )
        .join('\n');
      return infoCommand('Sessions', list);
    }

    case 'usage': {
      const sub = (req.args[1] || 'summary').toLowerCase();
      if (sub === 'daily' || sub === 'monthly') {
        const rows = listUsageByAgent({ window: sub });
        if (rows.length === 0) {
          return plainCommand(`No usage events recorded for ${sub} window.`);
        }
        const lines = rows.slice(0, 20).map((row) => {
          return `${row.agent_id} — ${formatCompactNumber(row.total_tokens)} tokens (${formatCompactNumber(row.total_input_tokens)} in / ${formatCompactNumber(row.total_output_tokens)} out) · ${row.call_count} calls · ${formatUsd(row.total_cost_usd)}`;
        });
        return infoCommand(`Usage (${sub} · by agent)`, lines.join('\n'));
      }

      if (sub === 'model') {
        const maybeWindow = (req.args[2] || '').toLowerCase();
        const window =
          maybeWindow === 'daily' || maybeWindow === 'monthly'
            ? maybeWindow
            : 'monthly';
        const modelAgentId =
          maybeWindow === 'daily' || maybeWindow === 'monthly'
            ? (req.args[3] || '').trim()
            : (req.args[2] || '').trim();
        const rows = listUsageByModel({
          window,
          agentId: modelAgentId || undefined,
        });
        if (rows.length === 0) {
          return plainCommand('No usage events recorded for model breakdown.');
        }
        const lines = rows.slice(0, 20).map((row) => {
          return `${row.model} — ${formatCompactNumber(row.total_tokens)} tokens · ${row.call_count} calls · ${formatUsd(row.total_cost_usd)}`;
        });
        const scope = modelAgentId ? `agent ${modelAgentId}` : 'all agents';
        return infoCommand(
          `Usage (${window} · by model · ${scope})`,
          lines.join('\n'),
        );
      }

      if (sub !== 'summary') {
        return badCommand(
          'Usage',
          'Usage: `usage [summary|daily|monthly|model [daily|monthly] [agentId]]`',
        );
      }

      const currentAgentId = resolveSessionAgentId(session);
      const daily = getUsageTotals({
        agentId: currentAgentId || undefined,
        window: 'daily',
      });
      const monthly = getUsageTotals({
        agentId: currentAgentId || undefined,
        window: 'monthly',
      });
      const topModels = listUsageByModel({
        agentId: currentAgentId || undefined,
        window: 'monthly',
      }).slice(0, 5);
      const scopeLabel = currentAgentId || 'all agents';
      const lines = [
        `Scope: ${scopeLabel}`,
        `Today: ${formatCompactNumber(daily.total_tokens)} tokens · ${daily.call_count} calls · ${formatUsd(daily.total_cost_usd)}`,
        `Month: ${formatCompactNumber(monthly.total_tokens)} tokens · ${monthly.call_count} calls · ${formatUsd(monthly.total_cost_usd)}`,
      ];
      if (topModels.length > 0) {
        lines.push('Top models (monthly):');
        lines.push(
          ...topModels.map(
            (row) =>
              `- ${row.model}: ${formatCompactNumber(row.total_tokens)} tokens · ${formatUsd(row.total_cost_usd)}`,
          ),
        );
      }
      return infoCommand('Usage Summary', lines.join('\n'));
    }

    case 'export': {
      const sub = (req.args[1] || 'session').toLowerCase();
      if (sub !== 'session') {
        return badCommand('Usage', 'Usage: `export session [sessionId]`');
      }
      const targetSessionId = (req.args[2] || session.id || '').trim();
      if (!targetSessionId) {
        return badCommand('Usage', 'Usage: `export session [sessionId]`');
      }
      const targetSession = memoryService.getSessionById(targetSessionId);
      if (!targetSession) {
        return badCommand(
          'Not Found',
          `Session \`${targetSessionId}\` was not found.`,
        );
      }
      const exportAgentId =
        resolveSessionAgentId(targetSession) || resolveSessionAgentId(session);
      if (!exportAgentId) {
        return badCommand(
          'Missing Agent',
          'Cannot export session: no agent/chatbot is configured for the target session.',
        );
      }
      const messages = memoryService.getRecentMessages(targetSessionId);
      const exported = exportSessionSnapshotJsonl({
        agentId: exportAgentId,
        sessionId: targetSessionId,
        channelId: targetSession.channel_id,
        summary: targetSession.session_summary,
        messages,
        reason: 'manual',
      });
      if (!exported) {
        return badCommand(
          'Export Failed',
          'Failed to write session export JSONL file. Check gateway logs for details.',
        );
      }
      return infoCommand(
        'Session Exported',
        [
          `File: ${exported.path}`,
          `Messages: ${messages.length}`,
          `Summary: ${targetSession.session_summary ? 'yes' : 'no'}`,
        ].join('\n'),
      );
    }

    case 'audit': {
      const targetSessionId = (req.args[1] || session.id || '').trim();
      if (!targetSessionId) {
        return badCommand('Usage', 'Usage: `audit [sessionId]`');
      }
      const rows = getRecentStructuredAuditForSession(targetSessionId, 20);
      if (rows.length === 0) {
        return plainCommand(
          `No structured audit events for session \`${targetSessionId}\`.`,
        );
      }
      const lines = rows.map((row) => {
        return `#${row.seq} ${row.event_type} ${row.timestamp} ${summarizeAuditPayload(row.payload)}`;
      });
      return infoCommand(`Audit (${targetSessionId})`, lines.join('\n'));
    }

    case 'schedule': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'add') {
        const rest = req.args.slice(2).join(' ');
        const atMatch = rest.match(/^at\s+"([^"]+)"\s+(.+)$/i);
        if (atMatch) {
          const [, runAtRaw, prompt] = atMatch;
          const parsedDate = new Date(runAtRaw);
          if (Number.isNaN(parsedDate.getTime())) {
            return badCommand(
              'Invalid Time',
              `\`${runAtRaw}\` is not a valid ISO timestamp.`,
            );
          }
          const taskId = createTask(
            session.id,
            req.channelId,
            '',
            prompt,
            parsedDate.toISOString(),
          );
          rearmScheduler();
          return plainCommand(
            `Task #${taskId} created: one-shot at \`${parsedDate.toISOString()}\` — ${prompt}`,
          );
        }

        const everyMatch = rest.match(/^every\s+(\d+)\s+(.+)$/i);
        if (everyMatch) {
          const [, everyRaw, prompt] = everyMatch;
          const everyMs = Number.parseInt(everyRaw, 10);
          if (!Number.isFinite(everyMs) || everyMs < 10_000) {
            return badCommand(
              'Invalid Interval',
              'Interval must be at least 10000ms.',
            );
          }
          const taskId = createTask(
            session.id,
            req.channelId,
            '',
            prompt,
            undefined,
            everyMs,
          );
          rearmScheduler();
          return plainCommand(
            `Task #${taskId} created: every \`${everyMs}ms\` — ${prompt}`,
          );
        }

        const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
        if (!cronMatch) {
          return badCommand(
            'Usage',
            'Usage: `schedule add "<cron>" <prompt>` or `schedule add at "<ISO time>" <prompt>` or `schedule add every <ms> <prompt>`',
          );
        }
        const [, cronExpr, prompt] = cronMatch;
        try {
          CronExpressionParser.parse(cronExpr);
        } catch {
          return badCommand(
            'Invalid Cron',
            `\`${cronExpr}\` is not a valid cron expression.`,
          );
        }
        const taskId = createTask(session.id, req.channelId, cronExpr, prompt);
        rearmScheduler();
        return plainCommand(
          `Task #${taskId} created: cron \`${cronExpr}\` — ${prompt}`,
        );
      }

      if (sub === 'list') {
        const tasks = getTasksForSession(session.id);
        if (tasks.length === 0) return plainCommand('No scheduled tasks.');
        const list = tasks
          .map((task) => {
            const scheduleLabel = task.run_at
              ? `at ${task.run_at}`
              : task.every_ms
                ? `every ${task.every_ms}ms`
                : task.cron_expr
                  ? `cron ${task.cron_expr}`
                  : 'unspecified';
            const statusLabel = task.last_status || 'n/a';
            const errorSuffix =
              task.consecutive_errors > 0
                ? ` · errors ${task.consecutive_errors}`
                : '';
            return `#${task.id} ${task.enabled ? 'enabled' : 'disabled'} (${scheduleLabel}) [${statusLabel}${errorSuffix}] — ${task.prompt.slice(0, 60)}`;
          })
          .join('\n');
        return infoCommand('Scheduled Tasks', list);
      }

      if (sub === 'remove') {
        const taskId = parseIntOrNull(req.args[2]);
        if (!taskId)
          return badCommand('Usage', 'Usage: `schedule remove <id>`');
        deleteTask(taskId);
        rearmScheduler();
        return plainCommand(`Task #${taskId} removed.`);
      }

      if (sub === 'toggle') {
        const taskId = parseIntOrNull(req.args[2]);
        if (!taskId)
          return badCommand('Usage', 'Usage: `schedule toggle <id>`');
        const tasks = getTasksForSession(session.id);
        const task = tasks.find((t) => t.id === taskId);
        if (!task)
          return badCommand(
            'Not Found',
            `Task #${taskId} was not found in this session.`,
          );
        if (task.enabled) {
          pauseTask(taskId);
        } else {
          resumeTask(taskId);
        }
        rearmScheduler();
        return plainCommand(
          `Task #${taskId} ${task.enabled ? 'disabled' : 'enabled'}.`,
        );
      }

      return badCommand('Usage', 'Usage: `schedule add|list|remove|toggle`');
    }

    default:
      return badCommand(
        'Unknown Command',
        `Unknown command: \`${cmd || '(empty)'}\`.`,
      );
  }
}
