import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { runAgent } from '../agent/agent.js';
import {
  delegationQueueStatus,
  enqueueDelegation,
} from '../agent/delegation-manager.js';
import {
  getActiveExecutorSessionIds,
  getSandboxDiagnostics,
} from '../agent/executor.js';
import {
  buildToolsSummary,
  getKnownToolGroupLabel,
  getKnownToolGroups,
  isKnownToolName,
} from '../agent/tool-summary.js';
import {
  deleteRegisteredAgent,
  findAgentConfig,
  getAgentById,
  getStoredAgentConfig,
  listAgents,
  resolveAgentConfig,
  resolveAgentForRequest,
  resolveAgentModel,
  upsertRegisteredAgent,
} from '../agents/agent-registry.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getObservabilityIngestState } from '../audit/observability-ingest.js';
import { getCodexAuthStatus } from '../auth/codex-auth.js';
import { getHybridAIAuthStatus } from '../auth/hybridai-auth.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import {
  APP_VERSION,
  DATA_DIR,
  DISCORD_COMMANDS_ONLY,
  DISCORD_FREE_RESPONSE_CHANNELS,
  DISCORD_GROUP_POLICY,
  DISCORD_GUILDS,
  FULLAUTO_NEVER_APPROVE_TOOLS,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
  MissingRequiredEnvVarError,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_DELEGATION_MAX_DEPTH,
  PROACTIVE_RALPH_MAX_ITERATIONS,
  WEB_API_TOKEN,
} from '../config/config.js';
import {
  getRuntimeConfig,
  type RuntimeConfig,
  runtimeConfigPath,
  saveRuntimeConfig,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { NoCompactableMessagesError } from '../memory/compaction.js';
import {
  createFreshSessionInstance,
  createTask,
  deleteSessionData,
  deleteTask,
  getAllSessions,
  getAllTasks,
  getFullAutoSessionCount,
  getQueuedProactiveMessageCount,
  getRecentStructuredAuditForSession,
  getSessionCount,
  getSessionFileChangeCounts,
  getSessionMessageCounts,
  getSessionToolCallBreakdown,
  getSessionUsageTotalsSince,
  getTasksForSession,
  getUsageTotals,
  listStructuredAuditEntries,
  listUsageByAgent,
  listUsageByModel,
  listUsageBySession,
  logAudit,
  pauseTask,
  recordRequestLog,
  resumeTask,
  updateSessionAgent,
  updateSessionChatbot,
  updateSessionModel,
  updateSessionRag,
  updateSessionShowMode,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import {
  readPluginConfigEntry,
  readPluginConfigValue,
  unsetPluginConfigValue,
  writePluginConfigValue,
} from '../plugins/plugin-config.js';
import { formatPluginSummaryList } from '../plugins/plugin-formatting.js';
import {
  installPlugin,
  reinstallPlugin,
  uninstallPlugin,
} from '../plugins/plugin-install.js';
import {
  ensurePluginManagerInitialized,
  listLoadedPluginCommands,
  type PluginManager,
  reloadPluginManager,
  shutdownPluginManager,
} from '../plugins/plugin-manager.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import {
  fetchHybridAIBots,
  HybridAIBotFetchError,
} from '../providers/hybridai-bots.js';
import {
  getDiscoveredHybridAIModelContextWindow,
  getDiscoveredHybridAIModelNames,
} from '../providers/hybridai-discovery.js';
import { resolveModelContextWindowFallback } from '../providers/hybridai-models.js';
import {
  getLocalModelInfo,
  resolveLocalModelContextWindow,
} from '../providers/local-discovery.js';
import { getAllBackendHealth } from '../providers/local-health.js';
import {
  getAvailableModelList,
  isAvailableModelFree,
  normalizeModelCatalogProviderFilter,
  refreshAvailableModelCatalogs,
} from '../providers/model-catalog.js';
import {
  formatModelForDisplay,
  normalizeHybridAIModelForRuntime,
} from '../providers/model-names.js';
import {
  discoverOpenRouterModels,
  getDiscoveredOpenRouterModelContextWindow,
} from '../providers/openrouter-discovery.js';
import { runIsolatedScheduledTask } from '../scheduler/scheduled-task-runner.js';
import {
  getScheduledTaskNextRunAt,
  getSchedulerStatus,
  parseSchedulerTimestampMs,
  pauseConfigJob,
  rearmScheduler,
  resumeConfigJob,
} from '../scheduler/scheduler.js';
import { redactSecrets } from '../security/redact.js';
import { runtimeSecretsPath } from '../security/runtime-secrets.js';
import { exportSessionSnapshotJsonl } from '../session/session-export.js';
import {
  maybeCompactSession,
  runPreCompactionMemoryFlush,
} from '../session/session-maintenance.js';
import {
  evaluateSessionExpiry,
  resolveResetPolicy,
  resolveSessionResetChannelKind,
  type SessionExpiryEvaluation,
  type SessionResetPolicy,
} from '../session/session-reset.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import type {
  SkillAmendment,
  SkillHealthMetrics,
  SkillObservation,
} from '../skills/adaptive-skills-types.js';
import { loadSkillCatalog } from '../skills/skills.js';
import type {
  ArtifactMetadata,
  ChatMessage,
  DelegationSideEffect,
  DelegationTaskSpec,
  McpServerConfig,
  PendingApproval,
  ScheduledTask,
  Session,
  StoredMessage,
  StructuredAuditEntry,
  ToolExecution,
  ToolProgressEvent,
} from '../types.js';
import { sleep } from '../utils/sleep.js';
import { resetWorkspace } from '../workspace.js';
import {
  buildFullAutoStatusLines,
  configureFullAutoRuntime,
  describeFullAutoWorkspaceSummary,
  disableFullAutoSession,
  enableFullAutoSession,
  getFullAutoRuntimeState,
  isFullAutoEnabled,
  maybeScheduleFullAutoAfterSuccess,
  type ProactiveMessagePayload,
  resolveFullAutoPrompt,
  resolveSessionRalphIterations,
} from './fullauto.js';
import { mapLogicalAgentCard, mapSessionCard } from './gateway-agent-cards.js';
import {
  classifyGatewayError,
  type GatewayErrorClass,
} from './gateway-error-utils.js';
import {
  abbreviateForUser,
  formatCompactNumber,
  formatRalphIterations,
} from './gateway-formatting.js';
import { GATEWAY_LOG_REQUESTS_ENV } from './gateway-lifecycle.js';
import {
  interruptGatewaySessionExecution,
  registerActiveGatewayRequest,
} from './gateway-request-runtime.js';
import { readSessionStatusSnapshot } from './gateway-session-status.js';
import { formatRelativeTime, parseTimestamp } from './gateway-time.js';
import {
  type GatewayAdminAuditResponse,
  type GatewayAdminChannelsResponse,
  type GatewayAdminChannelUpsertRequest,
  type GatewayAdminConfigResponse,
  type GatewayAdminDeleteSessionResult,
  type GatewayAdminMcpResponse,
  type GatewayAdminModelsResponse,
  type GatewayAdminModelUsageRow,
  type GatewayAdminOverview,
  type GatewayAdminPluginsResponse,
  type GatewayAdminSchedulerJob,
  type GatewayAdminSchedulerResponse,
  type GatewayAdminSession,
  type GatewayAdminSkillsResponse,
  type GatewayAdminToolCatalogEntry,
  type GatewayAdminToolsResponse,
  type GatewayAdminUsageSummary,
  type GatewayAgentsResponse,
  type GatewayChatRequestBody,
  type GatewayChatResult,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayHistorySummary,
  type GatewayStatus,
  renderGatewayCommand,
} from './gateway-types.js';
import {
  buildGatewayCommandMiddlewareChain,
  buildGatewayPluginToolMiddlewareChain,
  buildGatewayScheduledTaskMiddlewareChain,
} from './middleware/chains.js';
import { buildGatewayMiddlewareChain } from './middleware/chat-runner.js';

export { resolveMediaToolPolicy } from './middleware/helpers.js';

import type {
  GatewayMiddlewareDependencies,
  GatewayPluginToolRequest,
  GatewayPromptPreparedContext,
} from './middleware/types.js';

export type { MediaToolPolicy } from './middleware/types.js';

import { numberFromUnknown, parseAuditPayload } from './gateway-utils.js';
import { isDiscordChannelId } from './proactive-delivery.js';
import { buildResetConfirmationComponents } from './reset-confirmation.js';
import {
  describeSessionShowMode,
  isSessionShowMode,
  normalizeSessionShowMode,
} from './show-mode.js';

const BOT_CACHE_TTL = 300_000; // 5 minutes
const MAX_HISTORY_MESSAGES = 40;
const REQUEST_LOG_SENSITIVE_KEY_RE =
  /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|session)/i;
const REQUEST_LOG_INLINE_SECRET_RE =
  /\b(pass(?:word)?|secret|token|api(?:[_ -]?key)?|authorization|cookie|credential)\b(\s*[:=]\s*)([^\n\r,;]+)|([?&](?:token|signature|x-amz-[^=]*))=([^&\s]+)/gi;
const ALWAYS_REDACT_TOOL_FIELDS: Record<string, ReadonlySet<string>> = {
  browser_type: new Set(['text']),
};
const GATEWAY_REQUEST_LOG_ENABLED_VALUE = '1';
let lastWarnedGatewayRequestLoggingValue: string | null = null;

function isGatewayRequestLoggingEnabled(): boolean {
  const raw = String(process.env[GATEWAY_LOG_REQUESTS_ENV] || '').trim();
  if (!raw) return false;
  if (raw === GATEWAY_REQUEST_LOG_ENABLED_VALUE) {
    lastWarnedGatewayRequestLoggingValue = null;
    return true;
  }
  if (raw !== lastWarnedGatewayRequestLoggingValue) {
    logger.warn(
      {
        envVar: GATEWAY_LOG_REQUESTS_ENV,
        expectedValue: GATEWAY_REQUEST_LOG_ENABLED_VALUE,
        value: raw,
      },
      'Ignoring invalid gateway request logging env value',
    );
    lastWarnedGatewayRequestLoggingValue = raw;
  }
  return false;
}

function redactRequestLogText(text: string): string {
  return redactSecrets(text).replace(
    REQUEST_LOG_INLINE_SECRET_RE,
    (
      match: string,
      label: string | undefined,
      separator: string | undefined,
      _value: string | undefined,
      queryKey: string | undefined,
      _queryValue: string | undefined,
    ) => {
      if (label && separator) return `${label}${separator}[REDACTED]`;
      if (queryKey) return `${queryKey}=[REDACTED]`;
      return match;
    },
  );
}

function sanitizeRequestLogValue(
  value: unknown,
  extraKeyRedact?: (key: string) => boolean,
): unknown {
  if (typeof value === 'string') return redactRequestLogText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRequestLogValue(entry, extraKeyRedact));
  }
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (REQUEST_LOG_SENSITIVE_KEY_RE.test(key) || extraKeyRedact?.(key)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    sanitized[key] = sanitizeRequestLogValue(raw, extraKeyRedact);
  }
  return sanitized;
}

function sanitizeRequestLogToolArguments(
  toolName: string,
  rawArguments: string,
): string {
  const trimmed = rawArguments.trim();
  if (!trimmed) return trimmed;

  const extraKeyRedact = (key: string) =>
    ALWAYS_REDACT_TOOL_FIELDS[toolName]?.has(key) ?? false;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(sanitizeRequestLogValue(parsed, extraKeyRedact));
  } catch {
    return redactRequestLogText(trimmed);
  }
}

function sanitizeRequestLogMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: sanitizeRequestLogValue(message.content) as ChatMessage['content'],
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          ...toolCall,
          function: {
            ...toolCall.function,
            arguments: sanitizeRequestLogToolArguments(
              toolCall.function.name,
              toolCall.function.arguments,
            ),
          },
        }))
      : message.tool_calls,
  }));
}

function sanitizeRequestLogToolExecutions(
  toolExecutions: ToolExecution[],
): ToolExecution[] {
  return toolExecutions.map((execution) => {
    const { arguments: rawArguments, ...executionWithoutArguments } = execution;
    return {
      ...(sanitizeRequestLogValue(executionWithoutArguments) as Omit<
        ToolExecution,
        'arguments'
      >),
      arguments: sanitizeRequestLogToolArguments(execution.name, rawArguments),
    };
  });
}

function maybeRecordGatewayRequestLog(params: {
  sessionId: string;
  model: string;
  chatbotId: string;
  messages: ChatMessage[];
  status: 'success' | 'error';
  response?: string | null;
  error?: string | null;
  toolExecutions?: ToolExecution[];
  toolsUsed?: string[];
  durationMs: number;
}): void {
  try {
    recordRequestLog({
      sessionId: params.sessionId,
      model: params.model,
      chatbotId: params.chatbotId,
      messages: sanitizeRequestLogMessages(params.messages),
      status: params.status,
      response: params.response ? redactRequestLogText(params.response) : null,
      error: params.error ? redactRequestLogText(params.error) : null,
      toolExecutions: Array.isArray(params.toolExecutions)
        ? sanitizeRequestLogToolExecutions(params.toolExecutions)
        : null,
      toolsUsed: params.toolsUsed,
      durationMs: params.durationMs,
    });
  } catch (error) {
    logger.warn(
      {
        sessionId: params.sessionId,
        model: params.model,
        err: error,
      },
      'Failed to persist request_log row',
    );
  }
}

export class GatewayRequestError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

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
  'web_extract',
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
const RESET_CONFIRMATION_TTL_MS = 120_000;
const DISCORD_CHANNEL_MODE_VALUES = new Set(['off', 'mention', 'free']);
const DISCORD_GROUP_POLICY_VALUES = new Set(['open', 'allowlist', 'disabled']);
let cachedGitCommitShort: string | null | undefined;
const pendingSessionResets = new Map<string, PendingSessionReset>();

type DelegationMode = 'single' | 'parallel' | 'chain';
type DelegationRunStatus = 'completed' | 'failed' | 'timeout';

interface PendingSessionReset {
  requestedAt: number;
  agentId: string;
  workspacePath: string;
  model: string;
  chatbotId: string;
}

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
  sessionMode?: GatewayChatRequestBody['sessionMode'];
  guildId: GatewayChatRequestBody['guildId'];
  channelId: GatewayChatRequestBody['channelId'];
  userId: GatewayChatRequestBody['userId'];
  username: GatewayChatRequestBody['username'];
  content: GatewayChatRequestBody['content'];
  media?: GatewayChatRequestBody['media'];
  agentId?: GatewayChatRequestBody['agentId'];
  chatbotId?: GatewayChatRequestBody['chatbotId'];
  model?: GatewayChatRequestBody['model'];
  enableRag?: GatewayChatRequestBody['enableRag'];
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  abortSignal?: AbortSignal;
  source?: string;
}

type GatewaySessionBootstrapRequest = {
  sessionId: string;
  sessionMode?: 'new' | 'resume';
  guildId: string | null;
  channelId: string;
  userId?: string | null;
  agentId?: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
};

function shouldForceNewTuiSession(
  req: Pick<
    GatewayChatRequest | GatewayCommandRequest,
    'channelId' | 'sessionMode'
  >,
): boolean {
  return req.channelId === 'tui' && req.sessionMode === 'new';
}

function resolveSessionAutoResetPolicy(channelId: string): SessionResetPolicy {
  return resolveResetPolicy({
    channelKind: resolveSessionResetChannelKind(channelId),
    config: getRuntimeConfig(),
  });
}

async function prepareGatewaySessionRecord(params: {
  request: GatewaySessionBootstrapRequest;
  pluginManager: PluginManager | null;
  sessionResetPolicy?: SessionResetPolicy;
}): Promise<Session> {
  const req = params.request;
  const requestedAgentId = String(req.agentId || '').trim() || undefined;
  const requestedChatbotId = String(req.chatbotId || '').trim() || undefined;
  const requestedModel = String(req.model || '').trim() || undefined;
  const sessionResetPolicy =
    params.sessionResetPolicy || resolveSessionAutoResetPolicy(req.channelId);
  const expiryEvaluation = await prepareSessionAutoReset({
    sessionId: req.sessionId,
    channelId: req.channelId,
    agentId: requestedAgentId,
    chatbotId: requestedChatbotId,
    model: requestedModel,
    enableRag: req.enableRag,
    policy: sessionResetPolicy,
  });
  const autoResetSession = memoryService.resetSessionIfExpired(req.sessionId, {
    policy: sessionResetPolicy,
    expiryEvaluation,
  });
  if (autoResetSession) {
    const previousSessionId = req.sessionId;
    req.sessionId = autoResetSession.id;
    if (params.pluginManager) {
      await params.pluginManager.handleSessionReset({
        previousSessionId,
        sessionId: req.sessionId,
        userId: String(req.userId || ''),
        agentId:
          requestedAgentId || autoResetSession.agent_id || DEFAULT_AGENT_ID,
        channelId: req.channelId,
        reason: 'auto-reset',
      });
    }
  }

  const session = memoryService.getOrCreateSession(
    req.sessionId,
    req.guildId,
    req.channelId,
    requestedAgentId,
    { forceNewCurrent: shouldForceNewTuiSession(req) },
  );
  if (session.id !== req.sessionId) {
    req.sessionId = session.id;
  }
  return session;
}

function resolveCanonicalContextScope(
  session: Pick<Session, 'main_session_key' | 'session_key' | 'id'>,
): string {
  return (
    String(session.main_session_key || '').trim() ||
    String(session.session_key || '').trim() ||
    String(session.id || '').trim()
  );
}

function clearCanonicalPromptContext(params: {
  agentId: string;
  session: Pick<Session, 'main_session_key' | 'session_key' | 'id'>;
  userId?: string | null;
}): void {
  const scopes = new Set<string>();
  const canonicalScope = resolveCanonicalContextScope(params.session);
  if (canonicalScope) scopes.add(canonicalScope);

  const requestUserId = String(params.userId || '').trim();
  if (requestUserId) scopes.add(requestUserId);

  for (const scope of scopes) {
    memoryService.clearCanonicalContext({
      agentId: params.agentId,
      userId: scope,
    });
  }
}

export { resumeEnabledFullAutoSessions } from './fullauto.js';
export type {
  GatewayAdminChannelsResponse,
  GatewayAdminConfigResponse,
  GatewayAdminDeleteSessionResult,
  GatewayAdminOverview,
  GatewayAdminSession,
  GatewayChatResult,
  GatewayCommandRequest,
  GatewayCommandResult,
  GatewayStatus,
};
export { renderGatewayCommand };

let gatewayServiceInitialized = false;
let gatewayServiceInitializing: Promise<void> | null = null;

export async function initGatewayService(): Promise<void> {
  if (gatewayServiceInitialized) return;
  if (gatewayServiceInitializing) {
    await gatewayServiceInitializing;
    return;
  }
  gatewayServiceInitializing = (async () => {
    listAgents();
    configureFullAutoRuntime({ handleGatewayMessage });
    try {
      await ensurePluginManagerInitialized();
    } catch (error) {
      logger.warn({ error }, 'Plugin manager initialization failed');
    }
    gatewayServiceInitialized = true;
  })();
  try {
    await gatewayServiceInitializing;
  } finally {
    gatewayServiceInitializing = null;
  }
}

export async function stopGatewayPlugins(): Promise<void> {
  await shutdownPluginManager();
}

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

function mapUsageSummary(value: {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}): GatewayAdminUsageSummary {
  return {
    totalInputTokens: value.total_input_tokens,
    totalOutputTokens: value.total_output_tokens,
    totalTokens: value.total_tokens,
    totalCostUsd: value.total_cost_usd,
    callCount: value.call_count,
    totalToolCalls: value.total_tool_calls,
  };
}

function mapGatewayAdminAgent(agent: AgentConfig): {
  id: string;
  name: string | null;
  model: string | null;
  chatbotId: string | null;
  enableRag: boolean | null;
  workspace: string | null;
  workspacePath: string;
} {
  const resolved = resolveAgentConfig(agent.id);
  return {
    id: resolved.id,
    name: resolved.name || null,
    model: resolveAgentModel(resolved) || null,
    chatbotId: resolved.chatbotId || null,
    enableRag:
      typeof resolved.enableRag === 'boolean' ? resolved.enableRag : null,
    workspace: resolved.workspace || null,
    workspacePath: path.resolve(agentWorkspaceDir(resolved.id)),
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function getAdminChannelDisabledSkills(
  value: RuntimeConfig['skills']['channelDisabled'],
): GatewayAdminSkillsResponse['channelDisabled'] {
  return Object.fromEntries(
    (
      Object.entries(value ?? {}) as [
        keyof NonNullable<RuntimeConfig['skills']['channelDisabled']>,
        string[],
      ][]
    )
      .map(([channel, names]) => [
        channel,
        [...names].sort((left, right) => left.localeCompare(right)),
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function buildGatewayProviderHealth(params: {
  localBackends: GatewayStatus['localBackends'];
  codex: ReturnType<typeof getCodexAuthStatus>;
  hybridai: ReturnType<typeof getHybridAIAuthStatus>;
}): NonNullable<GatewayStatus['providerHealth']> {
  const runtimeConfig = getRuntimeConfig();
  const providerHealth: NonNullable<GatewayStatus['providerHealth']> = {
    hybridai: {
      kind: 'remote',
      reachable: params.hybridai.authenticated,
      ...(params.hybridai.authenticated ? {} : { error: 'API key missing' }),
      modelCount: dedupeStrings([
        runtimeConfig.hybridai.defaultModel,
        ...runtimeConfig.hybridai.models,
        ...getDiscoveredHybridAIModelNames(),
      ]).length,
      detail: params.hybridai.authenticated
        ? `API key ready${params.hybridai.source ? ` via ${params.hybridai.source}` : ''}`
        : 'API key missing',
    },
    codex: {
      kind: 'remote',
      reachable: params.codex.authenticated && !params.codex.reloginRequired,
      ...(params.codex.authenticated && !params.codex.reloginRequired
        ? {}
        : {
            error: params.codex.reloginRequired
              ? 'Login required'
              : 'Not authenticated',
          }),
      modelCount: dedupeStrings(runtimeConfig.codex.models).length,
      detail:
        params.codex.authenticated && !params.codex.reloginRequired
          ? `Authenticated${params.codex.source ? ` via ${params.codex.source}` : ''}`
          : params.codex.reloginRequired
            ? 'Login required'
            : 'Not authenticated',
    },
  };

  for (const [name, status] of Object.entries(params.localBackends || {})) {
    providerHealth[name as keyof typeof providerHealth] = {
      kind: 'local',
      reachable: status.reachable,
      latencyMs: status.latencyMs,
      ...(status.error ? { error: status.error } : {}),
      ...(typeof status.modelCount === 'number'
        ? { modelCount: status.modelCount }
        : {}),
      detail: status.reachable
        ? `${status.latencyMs}ms`
        : status.error || 'unreachable',
    };
  }

  return providerHealth;
}

function mapModelUsageRow(
  value: ReturnType<typeof listUsageByModel>[number],
): GatewayAdminModelUsageRow {
  return {
    model: value.model,
    totalInputTokens: value.total_input_tokens,
    totalOutputTokens: value.total_output_tokens,
    totalTokens: value.total_tokens,
    totalCostUsd: value.total_cost_usd,
    callCount: value.call_count,
    totalToolCalls: value.total_tool_calls,
  };
}

function mapAdminSession(session: Session): GatewayAdminSession {
  const runtime = resolveAgentForRequest({ session });
  return {
    id: session.id,
    guildId: session.guild_id,
    channelId: session.channel_id,
    agentId: runtime.agentId,
    chatbotId: session.chatbot_id,
    effectiveChatbotId: runtime.chatbotId || null,
    model: session.model,
    effectiveModel: runtime.model,
    ragEnabled: session.enable_rag !== 0,
    messageCount: session.message_count,
    summary: session.session_summary,
    compactionCount: session.compaction_count,
    taskCount: getTasksForSession(session.id).length,
    createdAt: session.created_at,
    lastActive: session.last_active,
  };
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
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

function boundAuditActorField(
  value: string | null | undefined,
): string | null | undefined {
  if (typeof value !== 'string') return value;
  return value.slice(0, 128);
}

const HYBRIDAI_AUTH_LIKE_RE = /invalid api key|unauthorized|authentication/i;
const HYBRIDAI_NETWORK_LIKE_RE =
  /fetch failed|econnrefused|enotfound|ehostunreach|timed out|timeout|network|socket/i;
const HYBRIDAI_TLS_LIKE_RE =
  /wrong version number|ssl3_get_record|ssl routines|eproto/i;

type HybridAIBotFetchErrorClassification =
  | 'auth'
  | 'tls'
  | 'network'
  | 'unknown';

type HybridAIBotFetchFailureKind =
  | 'missing_credentials'
  | 'auth'
  | 'tls'
  | 'network'
  | 'other';

interface HybridAIBotFetchFailureInput {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  message: string;
}

function hasMatchingHttpStatus(
  value: unknown,
  statuses: readonly number[],
): boolean {
  return statuses.some(
    (status) =>
      value === status || String(value || '').trim() === String(status),
  );
}

function classifyHybridAIBotFetchFailure(input: {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  message: string;
}): HybridAIBotFetchErrorClassification {
  const message = input.message;
  if (
    hasMatchingHttpStatus(input.status, [401, 403]) ||
    hasMatchingHttpStatus(input.code, [401, 403]) ||
    /authentication_error/i.test(String(input.type || '')) ||
    HYBRIDAI_AUTH_LIKE_RE.test(message)
  ) {
    return 'auth';
  }

  const networkLike =
    hasMatchingHttpStatus(input.status, [0]) ||
    /network_error/i.test(String(input.type || '')) ||
    HYBRIDAI_NETWORK_LIKE_RE.test(message);
  if (!networkLike) {
    return 'unknown';
  }

  return HYBRIDAI_TLS_LIKE_RE.test(message) ? 'tls' : 'network';
}

function getHybridAIBotFetchFailureInput(
  error: unknown,
): HybridAIBotFetchFailureInput {
  if (error instanceof HybridAIBotFetchError) {
    return {
      status: error.status,
      code: error.code,
      type: error.type,
      message: error.message,
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

function describeHybridAIBotFetchFailure(error: unknown): {
  kind: HybridAIBotFetchFailureKind;
  message?: string;
} {
  if (error instanceof MissingRequiredEnvVarError) {
    return { kind: 'missing_credentials' };
  }

  const input = getHybridAIBotFetchFailureInput(error);
  const classification = classifyHybridAIBotFetchFailure(input);
  if (classification === 'auth') {
    return { kind: 'auth', message: input.message };
  }
  if (classification === 'tls') {
    return { kind: 'tls' };
  }
  if (classification === 'network') {
    return { kind: 'network' };
  }
  return { kind: 'other', message: input.message };
}

function formatHybridAIBotReachabilityError(
  classification: Extract<
    HybridAIBotFetchErrorClassification,
    'tls' | 'network'
  >,
  reachabilityHint: string,
): string {
  if (classification === 'tls') {
    const insecureBaseUrl = HYBRIDAI_BASE_URL.replace(/^https:/i, 'http:');
    return `HybridAI is not reachable at \`${HYBRIDAI_BASE_URL}\`. If this local HybridAI server does not use TLS, run \`hybridclaw auth login hybridai --base-url ${insecureBaseUrl}\`.`;
  }
  return `HybridAI is not reachable at \`${HYBRIDAI_BASE_URL}\`. ${reachabilityHint}`;
}

function formatHybridAIBotFetchError(error: unknown): string {
  const keyHint = `Update \`HYBRIDAI_API_KEY\` in ${runtimeSecretsPath()} or in the shell that starts HybridClaw, then restart the gateway. You can also run \`hybridclaw auth login hybridai\` to store a new key.`;
  const reachabilityHint =
    'Check `hybridai.baseUrl` and confirm the HybridAI service is running.';
  const failure = describeHybridAIBotFetchFailure(error);

  if (failure.kind === 'missing_credentials') {
    return `HybridAI bot commands require HybridAI API credentials. ${keyHint}`;
  }
  if (failure.kind === 'auth') {
    return `HybridAI rejected the configured API key: ${failure.message}. ${keyHint}`;
  }
  if (failure.kind === 'tls' || failure.kind === 'network') {
    return formatHybridAIBotReachabilityError(failure.kind, reachabilityHint);
  }
  return `Failed to fetch bots: ${failure.message}`;
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

function resolveSessionAgentId(session: { agent_id: string }): string {
  const sessionAgent = session.agent_id?.trim();
  if (sessionAgent) return sessionAgent;
  return DEFAULT_AGENT_ID;
}

function resolveActivationModeLabel(): string {
  if (DISCORD_COMMANDS_ONLY) return 'commands-only';
  if (DISCORD_GROUP_POLICY === 'disabled') return 'disabled';
  if (DISCORD_GROUP_POLICY === 'allowlist') return 'allowlist';
  if (DISCORD_FREE_RESPONSE_CHANNELS.length > 0)
    return `mention + ${DISCORD_FREE_RESPONSE_CHANNELS.length} free channel(s)`;
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
  return 'mention';
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
  canonicalScopeId: string;
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
    if (opts.canonicalScopeId.trim()) {
      memoryService.appendCanonicalMessages({
        agentId: opts.agentId,
        userId: opts.canonicalScopeId,
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
      {
        sessionId: opts.sessionId,
        canonicalScopeId: opts.canonicalScopeId,
        err,
      },
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

function badCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

async function tryEnsurePluginManagerInitializedForGateway(params: {
  sessionId: string;
  channelId: string;
  agentId?: string | null;
  surface: 'chat' | 'command' | 'scheduler';
}): Promise<{
  pluginManager: PluginManager | null;
  pluginInitError: unknown;
}> {
  try {
    return {
      pluginManager: await ensurePluginManagerInitialized(),
      pluginInitError: null,
    };
  } catch (pluginInitError) {
    logger.warn(
      {
        sessionId: params.sessionId,
        channelId: params.channelId,
        agentId: params.agentId ?? null,
        surface: params.surface,
        error: pluginInitError,
      },
      'Plugin manager init failed; proceeding without plugins',
    );
    return { pluginManager: null, pluginInitError };
  }
}

const gatewayMiddlewareDependencies: GatewayMiddlewareDependencies = {
  maxHistoryMessages: MAX_HISTORY_MESSAGES,
  prepareGatewaySessionRecord,
  prepareSessionAutoReset,
  shouldForceNewTuiSession,
  resolveCanonicalContextScope,
  recordSuccessfulTurn,
  maybeRecordGatewayRequestLog,
  normalizeDelegationEffect,
  extractDelegationDepth,
  enqueueDelegationFromSideEffect,
};

function infoCommand(
  title: string,
  text: string,
  components?: GatewayCommandResult['components'],
  extra?: Partial<GatewayCommandResult>,
): GatewayCommandResult {
  return {
    kind: 'info',
    title,
    text,
    ...(components === undefined ? {} : { components }),
    ...(extra || {}),
  };
}

function plainCommand(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

function normalizePluginCommandResult(value: unknown): GatewayCommandResult {
  if (typeof value === 'string') {
    return plainCommand(value);
  }
  if (value == null) {
    return plainCommand('');
  }
  return plainCommand(JSON.stringify(value, null, 2));
}

function formatRatioAsPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatSkillHealthMetrics(metrics: SkillHealthMetrics): string {
  const lines = [
    `Skill: ${metrics.skill_name}`,
    `Executions: ${metrics.total_executions}`,
    `Success rate: ${formatRatioAsPercent(metrics.success_rate)}`,
    `Avg duration: ${Math.round(metrics.avg_duration_ms)}ms`,
    `Tool breakage: ${formatRatioAsPercent(metrics.tool_breakage_rate)}`,
    `Positive feedback: ${metrics.positive_feedback_count}`,
    `Negative feedback: ${metrics.negative_feedback_count}`,
    `Degraded: ${metrics.degraded ? 'yes' : 'no'}`,
  ];
  if (metrics.degradation_reasons.length > 0) {
    lines.push(`Reasons: ${metrics.degradation_reasons.join('; ')}`);
  }
  if (metrics.error_clusters.length > 0) {
    lines.push(
      `Error clusters: ${metrics.error_clusters
        .map((cluster) =>
          cluster.sample_detail
            ? `${cluster.category}=${cluster.count} (${cluster.sample_detail})`
            : `${cluster.category}=${cluster.count}`,
        )
        .join('; ')}`,
    );
  }
  return lines.join('\n');
}

function formatSkillAmendment(amendment: SkillAmendment): string {
  const lines = [
    `Version: ${amendment.version}`,
    `Status: ${amendment.status}`,
    `Guard: ${amendment.guard_verdict} (${amendment.guard_findings_count} finding(s))`,
    `Runs since apply: ${amendment.runs_since_apply}`,
    `Created: ${amendment.created_at}`,
  ];
  if (amendment.reviewed_by) {
    lines.push(`Reviewed by: ${amendment.reviewed_by}`);
  }
  if (amendment.rationale) {
    lines.push(`Rationale: ${amendment.rationale}`);
  }
  if (amendment.diff_summary) {
    lines.push(`Diff: ${amendment.diff_summary}`);
  }
  return lines.join('\n');
}

function formatSkillObservationRun(observation: SkillObservation): string {
  const lines = [
    `Run: ${observation.run_id}`,
    `Outcome: ${observation.outcome}`,
    `Observed: ${observation.created_at}`,
    `Duration: ${observation.duration_ms}ms`,
    `Tools: ${observation.tool_calls_failed}/${observation.tool_calls_attempted} failed`,
  ];
  if (observation.feedback_sentiment) {
    lines.push(`Feedback: ${observation.feedback_sentiment}`);
  }
  if (observation.user_feedback) {
    lines.push(`Feedback note: ${observation.user_feedback}`);
  }
  if (observation.error_category) {
    lines.push(`Error category: ${observation.error_category}`);
  }
  if (observation.error_detail) {
    lines.push(`Error detail: ${observation.error_detail}`);
  }
  return lines.join('\n');
}

function formatSessionModelOverride(model: string | null | undefined): string {
  const normalized = String(model || '').trim();
  return normalized ? formatModelForDisplay(normalized) : '(none)';
}

function formatConfiguredAgentModel(
  agent: AgentConfig | null | undefined,
): string {
  const model = resolveAgentModel(agent);
  return model ? formatModelForDisplay(model) : '(none)';
}

function enableFullAutoCommand(params: {
  session: Session;
  req: GatewayCommandRequest;
  prompt: string | null;
}): GatewayCommandResult {
  const { session: refreshed, seeded } = enableFullAutoSession(params);
  return infoCommand(
    'Full-Auto Enabled',
    [
      'Full-auto mode enabled. Agent will run indefinitely. Use `stop` or `fullauto off` to halt.',
      `Prompt: ${resolveFullAutoPrompt(refreshed)}`,
      describeFullAutoWorkspaceSummary(refreshed, seeded),
      `Ralph: ${formatRalphIterations(resolveSessionRalphIterations(refreshed))}`,
    ].join('\n'),
  );
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
  return interruptGatewaySessionExecution(sessionId)
    ? ' Current session container restarted to apply immediately.'
    : ' Changes apply on the next turn.';
}

function resolveSessionRuntimeTarget(session: Session): {
  model: string;
  chatbotId: string;
  agentId: string;
  workspacePath: string;
} {
  const { agentId, model, chatbotId } = resolveAgentForRequest({ session });
  return {
    model,
    chatbotId,
    agentId,
    workspacePath: path.resolve(agentWorkspaceDir(agentId)),
  };
}

function prunePendingSessionResets(now = Date.now()): void {
  for (const [sessionId, pending] of pendingSessionResets.entries()) {
    if (now - pending.requestedAt > RESET_CONFIRMATION_TTL_MS) {
      pendingSessionResets.delete(sessionId);
    }
  }
}

function getPendingSessionReset(sessionId: string): PendingSessionReset | null {
  prunePendingSessionResets();
  return pendingSessionResets.get(sessionId) ?? null;
}

export function getGatewayStatus(): GatewayStatus {
  const sandbox = getSandboxDiagnostics();
  const codex = getCodexAuthStatus();
  const hybridai = getHybridAIAuthStatus();
  const localBackends = Object.fromEntries(
    [...getAllBackendHealth().entries()].map(([backend, status]) => [
      backend,
      {
        reachable: status.reachable,
        latencyMs: status.latencyMs,
        ...(status.error ? { error: status.error } : {}),
        ...(typeof status.modelCount === 'number'
          ? { modelCount: status.modelCount }
          : {}),
      },
    ]),
  ) as GatewayStatus['localBackends'];
  const providerHealth = buildGatewayProviderHealth({
    localBackends,
    codex,
    hybridai,
  });
  return {
    status: 'ok',
    webAuthConfigured: Boolean(WEB_API_TOKEN),
    pid: process.pid,
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    sessions: getSessionCount(),
    activeContainers: sandbox.activeSessions,
    defaultModel: HYBRIDAI_MODEL,
    ragDefault: HYBRIDAI_ENABLE_RAG,
    fullAuto: {
      activeSessions: getFullAutoSessionCount(),
    },
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
    providerHealth,
    localBackends,
    pluginCommands: listLoadedPluginCommands(),
  };
}

export function getGatewayAdminOverview(): GatewayAdminOverview {
  return {
    status: getGatewayStatus(),
    configPath: runtimeConfigPath(),
    recentSessions: getAllSessions().slice(0, 8).map(mapAdminSession),
    usage: {
      daily: mapUsageSummary(getUsageTotals({ window: 'daily' })),
      monthly: mapUsageSummary(getUsageTotals({ window: 'monthly' })),
      topModels: listUsageByModel({ window: 'monthly' })
        .slice(0, 6)
        .map(mapModelUsageRow),
    },
  };
}

export function getGatewayAdminAgents(): {
  agents: Array<ReturnType<typeof mapGatewayAdminAgent>>;
} {
  return {
    agents: listAgents().map((agent) => mapGatewayAdminAgent(agent)),
  };
}

export function createGatewayAdminAgent(params: {
  id: string;
  name?: string | null;
  model?: string | null;
  chatbotId?: string | null;
  enableRag?: boolean | null;
  workspace?: string | null;
}): { agent: ReturnType<typeof mapGatewayAdminAgent> } {
  const saved = upsertRegisteredAgent({
    id: params.id,
    ...(params.name?.trim() ? { name: params.name.trim() } : {}),
    ...(params.model?.trim() ? { model: params.model.trim() } : {}),
    ...(params.chatbotId?.trim() ? { chatbotId: params.chatbotId.trim() } : {}),
    ...(typeof params.enableRag === 'boolean'
      ? { enableRag: params.enableRag }
      : {}),
    ...(params.workspace?.trim() ? { workspace: params.workspace.trim() } : {}),
  });
  return {
    agent: mapGatewayAdminAgent(saved),
  };
}

export function updateGatewayAdminAgent(
  agentId: string,
  params: {
    name?: string | null;
    model?: string | null;
    chatbotId?: string | null;
    enableRag?: boolean | null;
    workspace?: string | null;
  },
): { agent: ReturnType<typeof mapGatewayAdminAgent> } {
  const existing = getAgentById(agentId);
  if (!existing) {
    throw new Error(`Agent "${agentId}" was not found.`);
  }
  const saved = upsertRegisteredAgent({
    ...existing,
    ...(params.name !== undefined
      ? { name: params.name?.trim() || undefined }
      : {}),
    ...(params.model !== undefined
      ? { model: params.model?.trim() || undefined }
      : {}),
    ...(params.chatbotId !== undefined
      ? { chatbotId: params.chatbotId?.trim() || undefined }
      : {}),
    ...(params.workspace !== undefined
      ? { workspace: params.workspace?.trim() || undefined }
      : {}),
    ...(typeof params.enableRag === 'boolean'
      ? { enableRag: params.enableRag }
      : {}),
  });
  return {
    agent: mapGatewayAdminAgent(saved),
  };
}

export function deleteGatewayAdminAgent(agentId: string): {
  deleted: boolean;
  agentId: string;
} {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    throw new Error('Agent id is required.');
  }
  if (normalizedAgentId === DEFAULT_AGENT_ID) {
    throw new Error('The main agent cannot be deleted.');
  }
  return {
    deleted: deleteRegisteredAgent(normalizedAgentId),
    agentId: normalizedAgentId,
  };
}

export function getGatewayAgents(): GatewayAgentsResponse {
  const status = getGatewayStatus();
  const activeSessionIds = new Set(getActiveExecutorSessionIds());
  const usageByAgent = new Map(
    listUsageByAgent({ window: 'all' }).map(
      (row) => [row.agent_id, row] as const,
    ),
  );
  const usageBySession = new Map(
    listUsageBySession({ window: 'all' }).map(
      (row) => [row.session_id, row] as const,
    ),
  );
  const sandboxMode = status.sandbox?.mode || 'container';
  const sessions = getAllSessions()
    .map((session) =>
      mapSessionCard({
        session,
        activeSessionIds,
        usageBySession,
        sandboxMode,
      }),
    )
    .sort((left, right) => {
      const rank = { active: 0, idle: 1, stopped: 2 } as const;
      const byStatus = rank[left.status] - rank[right.status];
      if (byStatus !== 0) return byStatus;
      return (
        (parseTimestamp(right.lastActive)?.getTime() || 0) -
        (parseTimestamp(left.lastActive)?.getTime() || 0)
      );
    });
  const configuredAgents = listAgents();
  const agentIds = dedupeStrings([
    ...configuredAgents.map((agent) => agent.id),
    ...sessions.map((session) => session.agentId),
  ]);
  const sessionsByAgent = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const existing = sessionsByAgent.get(session.agentId) ?? [];
    existing.push(session);
    sessionsByAgent.set(session.agentId, existing);
  }
  const agents = agentIds
    .map((agentId) =>
      mapLogicalAgentCard({
        agent: getAgentById(agentId) ?? resolveAgentConfig(agentId),
        sessions: sessionsByAgent.get(agentId) ?? [],
        usage: usageByAgent.get(agentId),
      }),
    )
    .sort((left, right) => {
      const rank = { active: 0, idle: 1, stopped: 2, unused: 3 } as const;
      const byStatus = rank[left.status] - rank[right.status];
      if (byStatus !== 0) return byStatus;
      const byLastActive =
        (parseTimestamp(right.lastActive)?.getTime() || 0) -
        (parseTimestamp(left.lastActive)?.getTime() || 0);
      if (byLastActive !== 0) return byLastActive;
      return left.id.localeCompare(right.id);
    });

  return {
    generatedAt: new Date().toISOString(),
    version: status.version,
    uptime: status.uptime,
    ralph: {
      enabled: PROACTIVE_RALPH_MAX_ITERATIONS !== 0,
      maxIterations: PROACTIVE_RALPH_MAX_ITERATIONS,
    },
    totals: {
      agents: {
        all: agents.length,
        active: agents.filter((agent) => agent.status === 'active').length,
        idle: agents.filter((agent) => agent.status === 'idle').length,
        stopped: agents.filter((agent) => agent.status === 'stopped').length,
        unused: agents.filter((agent) => agent.status === 'unused').length,
        running: agents.filter(
          (agent) => agent.status === 'active' || agent.status === 'idle',
        ).length,
        totalInputTokens: agents.reduce(
          (sum, agent) => sum + agent.inputTokens,
          0,
        ),
        totalOutputTokens: agents.reduce(
          (sum, agent) => sum + agent.outputTokens,
          0,
        ),
        totalTokens: agents.reduce(
          (sum, agent) => sum + agent.inputTokens + agent.outputTokens,
          0,
        ),
        totalCostUsd: agents.reduce((sum, agent) => sum + agent.costUsd, 0),
      },
      sessions: {
        all: sessions.length,
        active: sessions.filter((session) => session.status === 'active')
          .length,
        idle: sessions.filter((session) => session.status === 'idle').length,
        stopped: sessions.filter((session) => session.status === 'stopped')
          .length,
        running: sessions.filter((session) => session.status !== 'stopped')
          .length,
        totalInputTokens: sessions.reduce(
          (sum, session) => sum + session.inputTokens,
          0,
        ),
        totalOutputTokens: sessions.reduce(
          (sum, session) => sum + session.outputTokens,
          0,
        ),
        totalTokens: sessions.reduce(
          (sum, session) => sum + session.inputTokens + session.outputTokens,
          0,
        ),
        totalCostUsd: sessions.reduce(
          (sum, session) => sum + session.costUsd,
          0,
        ),
      },
    },
    agents,
    sessions,
  };
}

export function getGatewayAdminSessions(): GatewayAdminSession[] {
  return getAllSessions().map(mapAdminSession);
}

export function deleteGatewayAdminSession(
  sessionId: string,
): GatewayAdminDeleteSessionResult {
  interruptGatewaySessionExecution(sessionId);
  return deleteSessionData(sessionId);
}

export function getGatewayAdminChannels(): GatewayAdminChannelsResponse {
  const runtimeConfig = getRuntimeConfig();
  const channels: GatewayAdminChannelsResponse['channels'] = [];

  const guildEntries = Object.entries(runtimeConfig.discord.guilds).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [guildId, guild] of guildEntries) {
    const channelEntries = Object.entries(guild.channels).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [channelId, config] of channelEntries) {
      channels.push({
        id: `${guildId}:${channelId}`,
        transport: 'discord',
        guildId,
        channelId,
        defaultMode: guild.defaultMode,
        config,
      });
    }
  }

  const teamEntries = Object.entries(runtimeConfig.msteams.teams).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [teamId, team] of teamEntries) {
    const channelEntries = Object.entries(team.channels).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [channelId, config] of channelEntries) {
      channels.push({
        id: `msteams:${teamId}:${channelId}`,
        transport: 'msteams',
        guildId: teamId,
        channelId,
        defaultGroupPolicy:
          team.groupPolicy ?? runtimeConfig.msteams.groupPolicy,
        defaultReplyStyle: team.replyStyle || runtimeConfig.msteams.replyStyle,
        defaultRequireMention:
          team.requireMention ?? runtimeConfig.msteams.requireMention,
        config,
      });
    }
  }

  return {
    groupPolicy: runtimeConfig.discord.groupPolicy,
    defaultTypingMode: runtimeConfig.discord.typingMode,
    defaultDebounceMs: runtimeConfig.discord.debounceMs,
    defaultAckReaction: runtimeConfig.discord.ackReaction,
    defaultRateLimitPerUser: runtimeConfig.discord.rateLimitPerUser,
    defaultMaxConcurrentPerChannel:
      runtimeConfig.discord.maxConcurrentPerChannel,
    msteams: {
      enabled: runtimeConfig.msteams.enabled,
      groupPolicy: runtimeConfig.msteams.groupPolicy,
      dmPolicy: runtimeConfig.msteams.dmPolicy,
      defaultRequireMention: runtimeConfig.msteams.requireMention,
      defaultReplyStyle: runtimeConfig.msteams.replyStyle,
    },
    channels,
  };
}

export function upsertGatewayAdminChannel(
  input: GatewayAdminChannelUpsertRequest,
): GatewayAdminChannelsResponse {
  const guildId = input.guildId.trim();
  const channelId = input.channelId.trim();
  if (!guildId || !channelId) {
    throw new Error('Both `guildId` and `channelId` are required.');
  }

  updateRuntimeConfig((draft) => {
    if (input.transport === 'msteams') {
      const team = draft.msteams.teams[guildId] ?? {
        requireMention: draft.msteams.requireMention,
        replyStyle: draft.msteams.replyStyle,
        channels: {},
      };
      team.channels[channelId] = input.config;
      draft.msteams.teams[guildId] = team;
      return;
    }

    const guild = draft.discord.guilds[guildId] ?? {
      defaultMode: 'mention',
      channels: {},
    };
    guild.channels[channelId] = input.config;
    draft.discord.guilds[guildId] = guild;
  });

  return getGatewayAdminChannels();
}

export function removeGatewayAdminChannel(params: {
  transport?: 'discord' | 'msteams';
  guildId: string;
  channelId: string;
}): GatewayAdminChannelsResponse {
  const guildId = params.guildId.trim();
  const channelId = params.channelId.trim();
  if (!guildId || !channelId) {
    throw new Error('Both `guildId` and `channelId` are required.');
  }

  updateRuntimeConfig((draft) => {
    if (params.transport === 'msteams') {
      const team = draft.msteams.teams[guildId];
      if (!team?.channels[channelId]) return;
      delete team.channels[channelId];
      draft.msteams.teams[guildId] = team;
      return;
    }

    const guild = draft.discord.guilds[guildId];
    if (!guild?.channels[channelId]) return;
    delete guild.channels[channelId];
    draft.discord.guilds[guildId] = guild;
  });

  return getGatewayAdminChannels();
}

export function getGatewayAdminConfig(): GatewayAdminConfigResponse {
  return {
    path: runtimeConfigPath(),
    config: getRuntimeConfig(),
  };
}

export function saveGatewayAdminConfig(
  next: RuntimeConfig,
): GatewayAdminConfigResponse {
  return {
    path: runtimeConfigPath(),
    config: saveRuntimeConfig(next),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArrayInput(
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Expected array \`${fieldName}\`.`);
  }
  return dedupeStrings(value.map((entry) => String(entry || '').trim()));
}

function parseAdminSchedulerJob(
  value: unknown,
): RuntimeConfig['scheduler']['jobs'][number] {
  if (!isRecord(value)) {
    throw new Error('Expected object `job`.');
  }

  const id = String(value.id || '').trim();
  if (!id) {
    throw new Error('Scheduler job requires a non-empty `id`.');
  }

  const name = String(value.name || '').trim();
  const description = String(value.description || '').trim();
  const rawSchedule = isRecord(value.schedule) ? value.schedule : {};
  const rawAction = isRecord(value.action) ? value.action : {};
  const rawDelivery = isRecord(value.delivery) ? value.delivery : {};

  const scheduleKind = String(rawSchedule.kind || 'cron')
    .trim()
    .toLowerCase();
  if (
    scheduleKind !== 'cron' &&
    scheduleKind !== 'every' &&
    scheduleKind !== 'at'
  ) {
    throw new Error(
      'Scheduler schedule kind must be `cron`, `every`, or `at`.',
    );
  }

  let at: string | null = null;
  let everyMs: number | null = null;
  let expr: string | null = null;
  if (scheduleKind === 'at') {
    at = String(rawSchedule.at || '').trim();
    const parsedAt = new Date(at);
    if (!at || Number.isNaN(parsedAt.getTime())) {
      throw new Error('`schedule.at` must be a valid ISO timestamp.');
    }
    at = parsedAt.toISOString();
  } else if (scheduleKind === 'every') {
    const parsedEveryMs =
      typeof rawSchedule.everyMs === 'number'
        ? rawSchedule.everyMs
        : Number.parseInt(String(rawSchedule.everyMs || ''), 10);
    if (!Number.isFinite(parsedEveryMs) || parsedEveryMs < 10_000) {
      throw new Error('`schedule.everyMs` must be at least 10000.');
    }
    everyMs = Math.floor(parsedEveryMs);
  } else {
    expr = String(rawSchedule.expr || '').trim();
    if (!expr) {
      throw new Error('`schedule.expr` is required for cron jobs.');
    }
    try {
      CronExpressionParser.parse(expr);
    } catch {
      throw new Error(`\`${expr}\` is not a valid cron expression.`);
    }
  }

  const actionKind = String(rawAction.kind || 'agent_turn')
    .trim()
    .toLowerCase();
  if (actionKind !== 'agent_turn' && actionKind !== 'system_event') {
    throw new Error(
      'Scheduler action kind must be `agent_turn` or `system_event`.',
    );
  }
  const actionMessage = String(rawAction.message || '').trim();
  if (!actionMessage) {
    throw new Error('`action.message` is required.');
  }

  const deliveryKind = String(rawDelivery.kind || 'channel')
    .trim()
    .toLowerCase();
  if (
    deliveryKind !== 'channel' &&
    deliveryKind !== 'last-channel' &&
    deliveryKind !== 'webhook'
  ) {
    throw new Error(
      'Scheduler delivery kind must be `channel`, `last-channel`, or `webhook`.',
    );
  }
  const deliveryTo = String(rawDelivery.to || '').trim();
  const webhookUrl = String(rawDelivery.webhookUrl || '').trim();
  if (deliveryKind === 'channel' && !deliveryTo) {
    throw new Error('`delivery.to` is required for channel deliveries.');
  }
  if (deliveryKind === 'webhook' && !webhookUrl) {
    throw new Error(
      '`delivery.webhookUrl` is required for webhook deliveries.',
    );
  }

  return {
    id,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    schedule: {
      kind: scheduleKind,
      at,
      everyMs,
      expr,
      tz: String(rawSchedule.tz || '').trim(),
    },
    action: {
      kind: actionKind,
      message: actionMessage,
    },
    delivery: {
      kind: deliveryKind,
      channel: String(rawDelivery.channel || 'discord').trim() || 'discord',
      to: deliveryTo,
      webhookUrl,
    },
    enabled: value.enabled !== false,
  };
}

function mapAdminAuditEntry(
  entry: StructuredAuditEntry,
): GatewayAdminAuditResponse['entries'][number] {
  return {
    id: entry.id,
    sessionId: entry.session_id,
    seq: entry.seq,
    eventType: entry.event_type,
    timestamp: entry.timestamp,
    runId: entry.run_id,
    parentRunId: entry.parent_run_id,
    payload: entry.payload,
    createdAt: entry.created_at,
  };
}

function readToolExecutionEvent(entry: StructuredAuditEntry): {
  toolName: string;
  durationMs: number | null;
  isError: boolean;
  summary: string | null;
} | null {
  const payload = parseAuditPayload(entry);
  const toolName = String(payload?.toolName || '').trim();
  if (!toolName) return null;
  const summary =
    typeof payload?.resultSummary === 'string' && payload.resultSummary.trim()
      ? payload.resultSummary.trim()
      : null;
  return {
    toolName,
    durationMs: numberFromUnknown(payload?.durationMs),
    isError: payload?.isError === true,
    summary,
  };
}

function mapAdminToolExecution(
  entry: StructuredAuditEntry,
  execution: NonNullable<ReturnType<typeof readToolExecutionEvent>>,
): GatewayAdminToolsResponse['recentExecutions'][number] {
  return {
    id: entry.id,
    toolName: execution.toolName,
    sessionId: entry.session_id,
    timestamp: entry.timestamp,
    durationMs: execution.durationMs,
    isError: execution.isError,
    summary: execution.summary,
  };
}

export function getGatewayAdminTools(): GatewayAdminToolsResponse {
  const recentEntries = listStructuredAuditEntries({
    eventType: 'tool.result',
    limit: 200,
  });
  const usageByTool = new Map<
    string,
    {
      recentCalls: number;
      recentErrors: number;
      lastUsedAt: string | null;
      recentErrorSamples: GatewayAdminToolCatalogEntry['recentErrorSamples'];
    }
  >();
  const recentExecutions: GatewayAdminToolsResponse['recentExecutions'] = [];

  for (const entry of recentEntries) {
    const execution = readToolExecutionEvent(entry);
    if (!execution) continue;
    recentExecutions.push(mapAdminToolExecution(entry, execution));
    const current = usageByTool.get(execution.toolName) || {
      recentCalls: 0,
      recentErrors: 0,
      lastUsedAt: null,
      recentErrorSamples: [],
    };
    current.recentCalls += 1;
    if (execution.isError) {
      current.recentErrors += 1;
      if (execution.summary && current.recentErrorSamples.length < 5) {
        current.recentErrorSamples.push({
          id: entry.id,
          sessionId: entry.session_id,
          timestamp: entry.timestamp,
          summary: execution.summary,
        });
      }
    }
    current.lastUsedAt ||= entry.timestamp;
    usageByTool.set(execution.toolName, current);
  }

  const groups: GatewayAdminToolsResponse['groups'] = getKnownToolGroups()
    .filter((group) => group.tools.length > 0)
    .map((group) => ({
      label: group.label,
      tools: group.tools.map((name) => {
        const usage = usageByTool.get(name);
        return {
          name,
          group: group.label,
          kind: 'builtin' as const,
          recentCalls: usage?.recentCalls || 0,
          recentErrors: usage?.recentErrors || 0,
          lastUsedAt: usage?.lastUsedAt || null,
          recentErrorSamples: usage?.recentErrorSamples || [],
        };
      }),
    }));

  const recentOnlyTools = Array.from(usageByTool.keys()).filter(
    (name) => !isKnownToolName(name),
  );
  const mcpTools = recentOnlyTools
    .filter((name) => name.includes('__'))
    .sort((left, right) => left.localeCompare(right));
  const otherTools = recentOnlyTools
    .filter((name) => !name.includes('__'))
    .sort((left, right) => left.localeCompare(right));

  if (mcpTools.length > 0) {
    groups.push({
      label: 'MCP',
      tools: mcpTools.map((name) => {
        const usage = usageByTool.get(name);
        return {
          name,
          group: 'MCP',
          kind: 'mcp' as const,
          recentCalls: usage?.recentCalls || 0,
          recentErrors: usage?.recentErrors || 0,
          lastUsedAt: usage?.lastUsedAt || null,
          recentErrorSamples: usage?.recentErrorSamples || [],
        };
      }),
    });
  }

  if (otherTools.length > 0) {
    groups.push({
      label: 'Other',
      tools: otherTools.map((name) => {
        const usage = usageByTool.get(name);
        return {
          name,
          group: getKnownToolGroupLabel(name) || 'Other',
          kind: 'other' as const,
          recentCalls: usage?.recentCalls || 0,
          recentErrors: usage?.recentErrors || 0,
          lastUsedAt: usage?.lastUsedAt || null,
          recentErrorSamples: usage?.recentErrorSamples || [],
        };
      }),
    });
  }

  const builtinTools = groups
    .filter((group) => group.label !== 'MCP' && group.label !== 'Other')
    .reduce((sum, group) => sum + group.tools.length, 0);
  const mcpToolCount = groups
    .filter((group) => group.label === 'MCP')
    .reduce((sum, group) => sum + group.tools.length, 0);
  const otherToolCount = groups
    .filter((group) => group.label === 'Other')
    .reduce((sum, group) => sum + group.tools.length, 0);

  return {
    totals: {
      totalTools: groups.reduce((sum, group) => sum + group.tools.length, 0),
      builtinTools,
      mcpTools: mcpToolCount,
      otherTools: otherToolCount,
      recentExecutions: recentExecutions.length,
      recentErrors: recentExecutions.filter((entry) => entry.isError).length,
    },
    groups,
    recentExecutions: recentExecutions.slice(0, 40),
  };
}

export async function getGatewayAdminModels(): Promise<GatewayAdminModelsResponse> {
  await refreshAvailableModelCatalogs({ includeHybridAI: true });

  const runtimeConfig = getRuntimeConfig();
  const hybridaiModels = dedupeStrings(runtimeConfig.hybridai.models);
  const codexModels = dedupeStrings(runtimeConfig.codex.models);
  const configuredHybridai = new Set(hybridaiModels);
  const configuredCodex = new Set(codexModels);
  const dailyUsage = new Map(
    listUsageByModel({ window: 'daily' }).map((row) => [row.model, row]),
  );
  const monthlyUsage = new Map(
    listUsageByModel({ window: 'monthly' }).map((row) => [row.model, row]),
  );

  const modelIds = dedupeStrings([
    runtimeConfig.hybridai.defaultModel,
    ...getAvailableModelList(),
  ]);
  const status = getGatewayStatus();

  return {
    defaultModel: runtimeConfig.hybridai.defaultModel,
    hybridaiModels,
    codexModels,
    providerStatus: status.providerHealth,
    models: modelIds
      .map((modelId) => {
        const info = getLocalModelInfo(modelId);
        const hybridaiContextWindow =
          getDiscoveredHybridAIModelContextWindow(modelId);
        const dailySummary = dailyUsage.get(modelId);
        const monthlySummary = monthlyUsage.get(modelId);
        return {
          id: modelId,
          configuredInHybridai: configuredHybridai.has(modelId),
          configuredInCodex: configuredCodex.has(modelId),
          discovered: Boolean(info),
          backend: info?.backend || null,
          contextWindow: info?.contextWindow ?? hybridaiContextWindow ?? null,
          maxTokens: info?.maxTokens ?? null,
          isReasoning: info?.isReasoning ?? false,
          thinkingFormat: info?.thinkingFormat || null,
          family: info?.family || null,
          parameterSize: info?.parameterSize || null,
          usageDaily: dailySummary ? mapUsageSummary(dailySummary) : null,
          usageMonthly: monthlySummary ? mapUsageSummary(monthlySummary) : null,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function saveGatewayAdminModels(input: {
  defaultModel?: unknown;
  hybridaiModels?: unknown;
  codexModels?: unknown;
}): Promise<GatewayAdminModelsResponse> {
  const defaultModel = String(input.defaultModel || '').trim();
  if (!defaultModel) {
    throw new Error('Expected non-empty `defaultModel`.');
  }

  const hybridaiModels = parseStringArrayInput(
    input.hybridaiModels,
    'hybridaiModels',
  );
  const codexModels = parseStringArrayInput(input.codexModels, 'codexModels');
  const discoveredDefault = getLocalModelInfo(defaultModel);

  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultModel = defaultModel;
    if (hybridaiModels) {
      draft.hybridai.models = hybridaiModels;
    }
    if (codexModels) {
      draft.codex.models = codexModels;
    }
    if (
      !draft.hybridai.models.includes(defaultModel) &&
      !draft.codex.models.includes(defaultModel) &&
      !discoveredDefault
    ) {
      draft.hybridai.models = dedupeStrings([
        ...draft.hybridai.models,
        defaultModel,
      ]);
    }
  });

  return getGatewayAdminModels();
}

export function getGatewayAdminScheduler(): GatewayAdminSchedulerResponse {
  const runtimeConfig = getRuntimeConfig();
  const statuses = new Map(
    getSchedulerStatus().map((job) => [job.id, job] as const),
  );
  const nowMs = Date.now();

  return {
    jobs: [
      ...runtimeConfig.scheduler.jobs.map((job) => {
        const runtime = statuses.get(job.id);
        return {
          id: job.id,
          source: 'config',
          name:
            (typeof job.name === 'string' && job.name.trim()) ||
            runtime?.name ||
            job.id,
          description:
            (typeof job.description === 'string' && job.description.trim()) ||
            runtime?.description ||
            null,
          enabled: job.enabled,
          schedule: job.schedule,
          action: job.action,
          delivery: job.delivery,
          lastRun: runtime?.lastRun || null,
          lastStatus: runtime?.lastStatus || null,
          nextRunAt: runtime?.nextRunAt || null,
          disabled: runtime?.disabled || false,
          consecutiveErrors: runtime?.consecutiveErrors || 0,
          createdAt: null,
          sessionId: null,
          channelId:
            job.delivery.kind === 'channel'
              ? job.delivery.to
              : job.delivery.kind === 'last-channel'
                ? 'last-channel'
                : null,
          taskId: null,
        } satisfies GatewayAdminSchedulerJob;
      }),
      ...getAllTasks().map((task) => {
        const normalizedPrompt = task.prompt.replace(/\s+/g, ' ').trim();
        const createdAtMs = parseSchedulerTimestampMs(task.created_at);
        const lastStatus =
          task.last_status === 'success' || task.last_status === 'error'
            ? task.last_status
            : null;

        return {
          id: `task:${task.id}`,
          source: 'task',
          name:
            normalizedPrompt.length > 72
              ? `${normalizedPrompt.slice(0, 69).trimEnd()}...`
              : normalizedPrompt || `Task #${task.id}`,
          description: `#${task.id}`,
          enabled: Boolean(task.enabled),
          schedule: task.run_at
            ? {
                kind: 'at',
                at: task.run_at,
                everyMs: null,
                expr: null,
                tz: '',
              }
            : task.every_ms
              ? {
                  kind: 'every',
                  at: null,
                  everyMs: task.every_ms,
                  expr: null,
                  tz: '',
                }
              : {
                  kind: 'cron',
                  at: null,
                  everyMs: null,
                  expr: task.cron_expr || null,
                  tz: '',
                },
          action: {
            kind: 'agent_turn',
            message: task.prompt,
          },
          delivery: {
            kind: 'channel',
            channel: 'session',
            to: task.channel_id,
            webhookUrl: '',
          },
          lastRun: task.last_run,
          lastStatus,
          nextRunAt: getScheduledTaskNextRunAt(task, nowMs),
          disabled: !task.enabled,
          consecutiveErrors: Math.max(0, task.consecutive_errors || 0),
          createdAt:
            createdAtMs == null
              ? task.created_at || null
              : new Date(createdAtMs).toISOString(),
          sessionId: task.session_id,
          channelId: task.channel_id,
          taskId: task.id,
        } satisfies GatewayAdminSchedulerJob;
      }),
    ].sort(compareGatewayAdminSchedulerJobs),
  };
}

function compareGatewayAdminSchedulerJobs(
  left: GatewayAdminSchedulerJob,
  right: GatewayAdminSchedulerJob,
): number {
  if (left.nextRunAt && right.nextRunAt) {
    const delta =
      new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime();
    if (delta !== 0) return delta;
  } else if (left.nextRunAt) {
    return -1;
  } else if (right.nextRunAt) {
    return 1;
  }

  if (left.createdAt && right.createdAt) {
    const delta =
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    if (delta !== 0) return delta;
  } else if (left.createdAt) {
    return -1;
  } else if (right.createdAt) {
    return 1;
  }

  return left.name.localeCompare(right.name);
}

export function upsertGatewayAdminSchedulerJob(input: {
  job: unknown;
}): GatewayAdminSchedulerResponse {
  const job = parseAdminSchedulerJob(input.job);

  updateRuntimeConfig((draft) => {
    const existingIndex = draft.scheduler.jobs.findIndex(
      (entry) => entry.id === job.id,
    );
    if (existingIndex >= 0) {
      draft.scheduler.jobs[existingIndex] = job;
      return;
    }
    draft.scheduler.jobs.push(job);
  });

  if (job.enabled) {
    resumeConfigJob(job.id);
  }
  rearmScheduler();
  return getGatewayAdminScheduler();
}

export function removeGatewayAdminSchedulerJob(
  jobId: string,
  source: 'config' | 'task' = 'config',
): GatewayAdminSchedulerResponse {
  if (source === 'task') {
    const taskId = Number.parseInt(jobId, 10);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      throw new Error('Expected numeric scheduler `taskId`.');
    }
    deleteTask(taskId);
    rearmScheduler();
    return getGatewayAdminScheduler();
  }

  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    throw new Error('Expected non-empty scheduler `jobId`.');
  }

  updateRuntimeConfig((draft) => {
    draft.scheduler.jobs = draft.scheduler.jobs.filter(
      (job) => job.id !== normalizedJobId,
    );
  });
  rearmScheduler();
  return getGatewayAdminScheduler();
}

export function setGatewayAdminSchedulerJobPaused(params: {
  jobId: string;
  paused: boolean;
  source?: 'config' | 'task';
}): GatewayAdminSchedulerResponse {
  if (params.source === 'task') {
    const taskId = Number.parseInt(params.jobId, 10);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      throw new Error('Expected numeric scheduler `taskId`.');
    }
    if (params.paused) {
      pauseTask(taskId);
    } else {
      resumeTask(taskId);
    }
    rearmScheduler();
    return getGatewayAdminScheduler();
  }

  const normalizedJobId = params.jobId.trim();
  if (!normalizedJobId) {
    throw new Error('Expected non-empty scheduler `jobId`.');
  }

  const ok = params.paused
    ? pauseConfigJob(normalizedJobId)
    : resumeConfigJob(normalizedJobId);
  if (!ok) {
    throw new Error(`Scheduler job \`${normalizedJobId}\` was not found.`);
  }
  return getGatewayAdminScheduler();
}

export function getGatewayAdminMcp(): GatewayAdminMcpResponse {
  const servers = Object.entries(getRuntimeConfig().mcpServers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => ({
      name,
      enabled: config.enabled !== false,
      summary: summarizeMcpServer(name, config),
      config,
    }));
  return { servers };
}

export function upsertGatewayAdminMcpServer(input: {
  name: string;
  config: unknown;
}): GatewayAdminMcpResponse {
  const parsedName = parseMcpServerName(input.name);
  if (!parsedName.name) {
    throw new Error(parsedName.error || 'Invalid MCP server name.');
  }
  const parsedConfig = parseMcpServerConfig(JSON.stringify(input.config));
  if (!parsedConfig.config) {
    throw new Error(parsedConfig.error || 'Invalid MCP server config.');
  }
  const serverName = parsedName.name;
  if (!serverName) {
    throw new Error(parsedName.error || 'Invalid MCP server name.');
  }

  updateRuntimeConfig((draft) => {
    draft.mcpServers[serverName] = parsedConfig.config as McpServerConfig;
  });
  return getGatewayAdminMcp();
}

export function removeGatewayAdminMcpServer(
  name: string,
): GatewayAdminMcpResponse {
  const parsedName = parseMcpServerName(name);
  if (!parsedName.name) {
    throw new Error(parsedName.error || 'Invalid MCP server name.');
  }
  const serverName = parsedName.name;
  if (!serverName) {
    throw new Error(parsedName.error || 'Invalid MCP server name.');
  }

  updateRuntimeConfig((draft) => {
    delete draft.mcpServers[serverName];
  });
  return getGatewayAdminMcp();
}

export function getGatewayAdminAudit(params?: {
  query?: string;
  sessionId?: string;
  eventType?: string;
  limit?: number;
}): GatewayAdminAuditResponse {
  const query = String(params?.query || '').trim();
  const sessionId = String(params?.sessionId || '').trim();
  const eventType = String(params?.eventType || '').trim();
  const limit = Math.max(1, Math.min(params?.limit ?? 60, 200));

  return {
    query,
    sessionId,
    eventType,
    limit,
    entries: listStructuredAuditEntries({
      query,
      sessionId,
      eventType,
      limit,
    }).map(mapAdminAuditEntry),
  };
}

export async function getGatewayAdminPlugins(): Promise<GatewayAdminPluginsResponse> {
  const pluginManager = await ensurePluginManagerInitialized();
  const plugins = pluginManager
    .listPluginSummary()
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.name || null,
      version: plugin.version || null,
      description: plugin.description || null,
      source: plugin.source,
      enabled: plugin.enabled,
      status: plugin.error ? ('failed' as const) : ('loaded' as const),
      error: plugin.error || null,
      commands: [...plugin.commands].sort((left, right) =>
        left.localeCompare(right),
      ),
      tools: [...plugin.tools].sort((left, right) => left.localeCompare(right)),
      hooks: [...plugin.hooks].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    totals: {
      totalPlugins: plugins.length,
      enabledPlugins: plugins.filter((plugin) => plugin.enabled).length,
      failedPlugins: plugins.filter((plugin) => plugin.status === 'failed')
        .length,
      commands: plugins.reduce(
        (sum, plugin) => sum + plugin.commands.length,
        0,
      ),
      tools: plugins.reduce((sum, plugin) => sum + plugin.tools.length, 0),
      hooks: plugins.reduce((sum, plugin) => sum + plugin.hooks.length, 0),
    },
    plugins,
  };
}

export function getGatewayAdminSkills(): GatewayAdminSkillsResponse {
  const runtimeConfig = getRuntimeConfig();
  return {
    extraDirs: runtimeConfig.skills.extraDirs,
    disabled: dedupeStrings(runtimeConfig.skills.disabled).sort((a, b) =>
      a.localeCompare(b),
    ),
    channelDisabled: getAdminChannelDisabledSkills(
      runtimeConfig.skills.channelDisabled,
    ),
    skills: loadSkillCatalog().map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: String(skill.source),
      available: skill.available,
      enabled: skill.enabled,
      missing: skill.missing,
      userInvocable: skill.userInvocable,
      disableModelInvocation: skill.disableModelInvocation,
      always: skill.always,
      tags: skill.metadata.hybridclaw.tags,
      relatedSkills: skill.metadata.hybridclaw.relatedSkills,
    })),
  };
}

export function setGatewayAdminSkillEnabled(input: {
  name: string;
  enabled: boolean;
  channel?: string;
}): GatewayAdminSkillsResponse {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new GatewayRequestError(400, 'Expected non-empty skill `name`.');
  }
  const rawChannel = String(input.channel || '').trim();
  const channelKind = rawChannel
    ? normalizeSkillConfigChannelKind(rawChannel)
    : undefined;
  if (rawChannel && !channelKind) {
    throw new GatewayRequestError(
      400,
      `Unsupported skill channel: ${rawChannel}`,
    );
  }
  const known = loadSkillCatalog().some((skill) => skill.name === name);
  if (!known) {
    throw new GatewayRequestError(400, `Skill \`${name}\` was not found.`);
  }

  updateRuntimeConfig((draft) => {
    setRuntimeSkillScopeEnabled(draft, name, input.enabled, channelKind);
  });

  return getGatewayAdminSkills();
}

export function getGatewayHistory(
  sessionId: string,
  limit = MAX_HISTORY_MESSAGES,
): StoredMessage[] {
  return memoryService
    .getConversationHistory(sessionId, Math.max(1, Math.min(limit, 200)))
    .reverse();
}

function resolveHistorySummarySinceMs(
  session: Session | undefined,
  sinceMs?: number | null,
): number {
  if (typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs > 0) {
    return Math.floor(sinceMs);
  }

  const createdAtMs = parseTimestamp(session?.created_at)?.getTime() ?? 0;
  if (createdAtMs > 0) return createdAtMs;
  return Date.now();
}

export function getGatewayHistorySummary(
  sessionId: string,
  options?: {
    sinceMs?: number | null;
  },
): GatewayHistorySummary {
  const session = memoryService.getSessionById(sessionId);
  const sinceMs = resolveHistorySummarySinceMs(session, options?.sinceMs);
  const sinceTimestamp = new Date(sinceMs).toISOString();
  const counts = getSessionMessageCounts(sessionId);
  const usage = getSessionUsageTotalsSince(sessionId, sinceTimestamp);
  const toolBreakdown = getSessionToolCallBreakdown(sessionId, sinceTimestamp);
  const fileChanges = getSessionFileChangeCounts(sessionId, sinceTimestamp);

  return {
    messageCount: counts.totalMessages,
    userMessageCount: counts.userMessages,
    toolCallCount: usage.total_tool_calls,
    inputTokenCount: usage.total_input_tokens,
    outputTokenCount: usage.total_output_tokens,
    costUsd: usage.total_cost_usd,
    toolBreakdown,
    fileChanges,
  };
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
      const output = await runAgent({
        sessionId,
        messages: [
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
        model: task.model,
        agentId,
        channelId,
        allowedTools,
      });
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
      const classification: GatewayErrorClass = classifyGatewayError(errorText);
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
      const classification: GatewayErrorClass = classifyGatewayError(errorText);
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
        `- ${entry.title}: ${abbreviateForUser(entry.run.result || '', MAX_DELEGATION_USER_CHARS)}`,
      );
    } else {
      userLines.push(
        `- ${entry.title}: ${entry.run.status} (${abbreviateForUser(entry.run.error || 'Unknown error', MAX_DELEGATION_USER_CHARS)})`,
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
    forUser: abbreviateForUser(userLines.join('\n'), MAX_DELEGATION_USER_CHARS),
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

async function prepareSessionAutoReset(params: {
  sessionId: string;
  channelId: string;
  agentId?: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
  policy: SessionResetPolicy;
}): Promise<SessionExpiryEvaluation | undefined> {
  const existingSession = memoryService.getSessionById(params.sessionId);
  if (!existingSession) return undefined;
  let expiryEvaluation: SessionExpiryEvaluation;
  try {
    const expiryStatus = evaluateSessionExpiry(
      params.policy,
      existingSession.last_active,
    );
    expiryEvaluation = {
      lastActive: existingSession.last_active,
      isExpired: expiryStatus.isExpired,
      reason: expiryStatus.reason,
    };
  } catch (err) {
    logger.warn(
      {
        sessionId: params.sessionId,
        channelId: params.channelId,
        lastActive: existingSession.last_active,
        err,
      },
      'Skipping session auto-reset due to invalid last_active timestamp',
    );
    expiryEvaluation = {
      lastActive: existingSession.last_active,
      isExpired: false,
      reason: null,
    };
  }
  if (!expiryEvaluation.isExpired) return expiryEvaluation;
  if (!getRuntimeConfig().sessionCompaction.preCompactionMemoryFlush.enabled) {
    return expiryEvaluation;
  }

  const resolvedRuntime = resolveAgentForRequest({
    agentId: params.agentId,
    session: existingSession,
    model: params.model,
    chatbotId: params.chatbotId,
  });

  await runPreCompactionMemoryFlush({
    sessionId: existingSession.id,
    agentId: resolvedRuntime.agentId,
    chatbotId: resolvedRuntime.chatbotId,
    enableRag: params.enableRag ?? existingSession.enable_rag !== 0,
    model: resolvedRuntime.model,
    channelId: params.channelId,
    sessionSummary: existingSession.session_summary,
    olderMessages: memoryService.getRecentMessages(existingSession.id),
  });
  return expiryEvaluation;
}

export async function handleGatewayMessage(
  req: GatewayChatRequest,
): Promise<GatewayChatResult> {
  const startedAt = Date.now();
  const { pluginManager } = await tryEnsurePluginManagerInitializedForGateway({
    sessionId: req.sessionId,
    channelId: req.channelId,
    agentId: req.agentId,
    surface: 'chat',
  });
  const runId = makeAuditRunId('turn');
  const source = req.source?.trim() || 'gateway.chat';
  const runtimeConfig = getRuntimeConfig();
  const gatewayMiddlewareChain = buildGatewayMiddlewareChain(
    runtimeConfig,
    gatewayMiddlewareDependencies,
  );
  const activeGatewayRequest = registerActiveGatewayRequest({
    sessionId: req.sessionId,
    abortSignal: req.abortSignal,
  });
  let preparedContext: GatewayPromptPreparedContext;
  try {
    preparedContext = await gatewayMiddlewareChain.runBeforeAgent({
      config: runtimeConfig,
      request: req,
      startedAt,
      runId,
      source,
      pluginManager,
      abortSignal: activeGatewayRequest.signal,
      requestLoggingEnabled: isGatewayRequestLoggingEnabled(),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to prepare gateway turn.';
    logger.error(
      {
        sessionId: req.sessionId,
        channelId: req.channelId,
        userId: req.userId,
        error,
      },
      'Gateway middleware preparation failed',
    );
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: message,
    };
  }

  const session = preparedContext.session;
  const agentId = preparedContext.agentId;
  const model = preparedContext.model;
  const chatbotId = preparedContext.chatbotId;
  const enableRag = preparedContext.enableRag;
  const provider = preparedContext.provider;
  const shouldEmitTools = preparedContext.shouldEmitTools;
  const media = preparedContext.media;
  const mediaPolicy = preparedContext.mediaPolicy;
  const userTurnContent = preparedContext.userTurnContent;
  const canonicalContextScope = preparedContext.canonicalContextScope;
  const turnIndex = preparedContext.turnIndex;
  const pluginsUsed = preparedContext.pluginsUsed;
  const requestMessages = preparedContext.requestMessages;
  const messages = preparedContext.messages;
  const attachSessionIdentity = (
    result: GatewayChatResult,
  ): GatewayChatResult => ({
    ...result,
    sessionId: req.sessionId,
    sessionKey: session.session_key,
    mainSessionKey: session.main_session_key,
  });
  const debugMeta = {
    sessionId: req.sessionId,
    guildId: req.guildId,
    channelId: req.channelId,
    userId: req.userId,
    model,
    provider,
    turnIndex,
    mediaCount: media.length,
    audioTranscriptCount: preparedContext.audioTranscriptCount,
    contentLength: userTurnContent.length,
    streamingRequested: Boolean(
      req.onTextDelta || req.onToolProgress || req.onApprovalProgress,
    ),
  };

  logger.debug(debugMeta, 'Gateway chat request received');

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
      canonicalScopeId: canonicalContextScope,
      userContent: req.content,
      resultText,
      toolCallCount: 0,
      startedAt,
    });
    const result: GatewayChatResult = {
      status: 'success',
      result: resultText,
      toolsUsed: [],
    };
    maybeScheduleFullAutoAfterSuccess({ session, req, result });
    return attachSessionIdentity(result);
  }
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
  logger.debug(
    {
      ...debugMeta,
      durationMs: Date.now() - startedAt,
      historyMessages: preparedContext.historyLength,
      promptMessages: messages.length,
      skillsLoaded: preparedContext.skillCount,
      blockedTools: mediaPolicy.blockedTools || [],
      scheduledTaskHistoryCount: preparedContext.historyStats.includedCount,
    },
    'Gateway chat context prepared',
  );

  let agentStage:
    | 'pre-agent'
    | 'awaiting-agent-output'
    | 'processing-agent-output' = 'pre-agent';

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
      if (!shouldEmitTools) return;
      req.onToolProgress?.(event);
    };
    const onApprovalProgress = (approval: PendingApproval): void => {
      logger.debug(
        {
          ...debugMeta,
          approvalId: approval.approvalId,
          approvalIntent: approval.intent,
          approvalReason: approval.reason,
          sinceStartMs: Date.now() - startedAt,
        },
        'Gateway approval progress',
      );
      req.onApprovalProgress?.(approval);
    };
    logger.debug(
      {
        ...debugMeta,
        scheduledTaskCount: scheduledTasks.length,
      },
      'Gateway chat invoking agent',
    );
    const beforeModelContext = await gatewayMiddlewareChain.runBeforeModel({
      ...preparedContext,
      scheduledTaskCount: scheduledTasks.length,
    });
    agentStage = 'awaiting-agent-output';
    const output = await runAgent({
      sessionId: req.sessionId,
      messages: beforeModelContext.messages,
      chatbotId: beforeModelContext.chatbotId,
      enableRag: beforeModelContext.enableRag,
      model: beforeModelContext.model,
      agentId: beforeModelContext.agentId,
      channelId: req.channelId,
      ralphMaxIterations: resolveSessionRalphIterations(session),
      fullAutoEnabled: isFullAutoEnabled(session),
      fullAutoNeverApproveTools: FULLAUTO_NEVER_APPROVE_TOOLS,
      scheduledTasks,
      blockedTools: beforeModelContext.mediaPolicy.blockedTools,
      onTextDelta,
      onToolProgress,
      onApprovalProgress,
      abortSignal: activeGatewayRequest.signal,
      media: beforeModelContext.media,
      audioTranscriptsPrepended: beforeModelContext.audioTranscriptCount > 0,
      pluginTools: beforeModelContext.pluginManager?.getToolDefinitions() ?? [],
    });
    agentStage = 'processing-agent-output';
    const afterModelContext = await gatewayMiddlewareChain.runAfterModel({
      ...beforeModelContext,
      output,
      firstTextDeltaMs,
    });
    const afterAgentContext =
      await gatewayMiddlewareChain.runAfterAgent(afterModelContext);
    return attachSessionIdentity(afterAgentContext.finalResult);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    logAudit('error', req.sessionId, { error: errorMsg }, durationMs);
    logger.error(
      {
        ...debugMeta,
        durationMs,
        stage: agentStage,
        err,
      },
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
        stage: agentStage,
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
          durationMs,
        },
      },
    });
    if (Array.isArray(requestMessages)) {
      maybeRecordGatewayRequestLog({
        sessionId: req.sessionId,
        model,
        chatbotId,
        messages: requestMessages,
        status: 'error',
        error: errorMsg,
        durationMs,
      });
    }
    return attachSessionIdentity({
      status: 'error',
      result: null,
      toolsUsed: [],
      pluginsUsed,
      toolExecutions: undefined,
      error: errorMsg,
    });
  } finally {
    activeGatewayRequest.release();
  }
}

export async function runGatewayPluginTool(params: {
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
  channelId?: string;
}): Promise<string> {
  const pluginManager = await ensurePluginManagerInitialized();
  const runtimeConfig = getRuntimeConfig();
  const gatewayPluginToolMiddlewareChain =
    buildGatewayPluginToolMiddlewareChain(
      runtimeConfig,
      gatewayMiddlewareDependencies,
    );
  const request: GatewayPluginToolRequest = {
    toolName: params.toolName,
    args: params.args,
    sessionId: String(params.sessionId || '').trim(),
    channelId: String(params.channelId || '').trim(),
    guildId: null,
    userId: 'plugin-tool',
  };
  const preparedContext = await gatewayPluginToolMiddlewareChain.runBeforeAgent(
    {
      config: runtimeConfig,
      request,
      messages: [],
      state: {
        pluginManager,
      },
    },
  );
  return pluginManager.executeTool({
    toolName: params.toolName,
    args: params.args,
    sessionId: preparedContext.state.session?.id || request.sessionId,
    channelId: request.channelId,
  });
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
  let currentSessionId = origSessionId;
  const { pluginManager } = await tryEnsurePluginManagerInitializedForGateway({
    sessionId: currentSessionId,
    channelId,
    surface: 'scheduler',
  });
  const runtimeConfig = getRuntimeConfig();
  const gatewayScheduledTaskMiddlewareChain =
    buildGatewayScheduledTaskMiddlewareChain(
      runtimeConfig,
      gatewayMiddlewareDependencies,
    );
  const preparedContext =
    await gatewayScheduledTaskMiddlewareChain.runBeforeAgent({
      config: runtimeConfig,
      request: {
        sessionId: currentSessionId,
        guildId: null,
        channelId,
        userId: 'scheduler',
        taskId,
        prompt,
      },
      messages: [],
      state: {
        pluginManager,
      },
    });
  const session = preparedContext.state.session;
  if (!session) {
    throw new Error(
      'Scheduled task middleware returned incomplete session state.',
    );
  }
  currentSessionId = session.id;
  const { agentId, chatbotId, model } = resolveAgentForRequest({ session });
  if (modelRequiresChatbotId(model) && !chatbotId) {
    logger.warn(
      {
        sessionId: currentSessionId,
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

  await runIsolatedScheduledTask({
    taskId,
    prompt,
    channelId,
    chatbotId,
    model,
    agentId,
    sessionId: session.id,
    sessionKey: runKey,
    mainSessionKey: session.main_session_key,
    onResult,
    onError,
  });
}

export async function handleGatewayCommand(
  req: GatewayCommandRequest,
): Promise<GatewayCommandResult> {
  const runtimeConfig = getRuntimeConfig();
  let { pluginManager, pluginInitError } =
    await tryEnsurePluginManagerInitializedForGateway({
      sessionId: req.sessionId,
      channelId: req.channelId,
      surface: 'command',
    });
  const gatewayCommandMiddlewareChain = buildGatewayCommandMiddlewareChain(
    runtimeConfig,
    gatewayMiddlewareDependencies,
  );
  const preparedContext = await gatewayCommandMiddlewareChain.runBeforeAgent({
    config: runtimeConfig,
    request: req,
    messages: [],
    state: {
      pluginManager,
    },
  });
  const preparedSession = preparedContext.state.session;
  if (!preparedSession) {
    throw new Error(
      'Gateway command middleware returned incomplete session state.',
    );
  }
  const cmd = String(preparedContext.state.commandName || '').trim();
  let session: Session = preparedSession;
  const attachCommandSessionIdentity = (
    result: GatewayCommandResult,
  ): GatewayCommandResult => ({
    ...result,
    sessionId: req.sessionId,
    sessionKey: session.session_key,
    mainSessionKey: session.main_session_key,
  });

  async function reloadPluginRuntime(): Promise<{
    ok: boolean;
    message: string;
  }> {
    try {
      pluginManager = await reloadPluginManager();
      pluginInitError = null;
      return {
        ok: true,
        message: 'Plugin runtime reloaded.',
      };
    } catch (error) {
      pluginManager = null;
      pluginInitError = error;
      return {
        ok: false,
        message: `Plugin runtime reload failed: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
  }

  function formatPluginConfigValue(value: unknown): string {
    if (value === undefined) return '(not set)';
    if (typeof value === 'string') return JSON.stringify(value);
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  const result = await (async (): Promise<GatewayCommandResult> => {
    switch (cmd) {
      case 'help': {
        const help = [
          '`agent` — Show current session agent',
          '`agent list` — List available agents',
          '`agent switch <id>` — Bind this session to an existing agent',
          '`agent create <id> [--model <model>]` — Create a new agent',
          '`agent model [name]` — Show or set the persistent model for the current agent',
          '`bot list` — List available bots',
          '`bot set <id|name>` — Set chatbot for this session',
          '`bot info` — Show current chatbot settings',
          '`model list [provider]` — List available models',
          '`model set <name>` — Set model for this session',
          '`model clear` — Clear the session model override',
          '`model default [name]` — Show or set default model for new sessions',
          '`model info` — Show effective, session, agent, and default models',
          '`rag [on|off]` — Toggle or set RAG mode',
          '`channel mode [off|mention|free]` — Set or inspect this Discord channel response mode',
          '`channel policy [open|allowlist|disabled]` — Set or inspect guild channel policy',
          '`ralph [on|off|set <n>|info]` — Configure Ralph loop (0 off, -1 unlimited)',
          '`fullauto [status|off|on [prompt]|<prompt>]` — Enable/inspect/disable session full-auto mode',
          '`show [all|thinking|tools|none]` — Control visible thinking/tool activity for this session',
          '`mcp list` — List configured MCP servers',
          '`mcp add <name> <json>` — Add or update an MCP server config',
          '`mcp remove <name>` — Remove an MCP server config',
          '`mcp toggle <name>` — Enable or disable an MCP server',
          '`mcp reconnect <name>` — Restart current session runtime so the server reconnects next turn',
          '`plugin list` — List discovered plugins, descriptions, commands, and load status',
          '`plugin config <plugin-id> [key] [value|--unset]` — Show or change a plugin config override',
          '`plugin install <path|npm-spec>` — Install a plugin from a local TUI/web session',
          '`plugin reinstall <path|npm-spec>` — Replace an installed plugin from a local TUI/web session',
          '`plugin reload` — Reload all plugins (picks up code changes without gateway restart)',
          '`plugin uninstall <plugin-id>` — Remove a home-installed plugin and matching runtime config overrides',
          '`clear` — Clear session history',
          '`reset [yes|no]` — Clear history, reset session settings, and remove the current agent workspace',
          '`/compact` — Archive older history, summarize it, and retain recent context',
          '`/status` — Show runtime status (Discord slash command, private to caller)',
          '`/approve [view|yes|session|agent|no] [approval_id]` — View/respond to pending approvals privately',
          '`/show <all|thinking|tools|none>` — Control visible thinking/tool activity for this session',
          '`stop` — Abort the current session run and disable full-auto mode',
          '`/channel-mode <off|mention|free>` — Set this Discord channel response mode',
          '`/channel-policy <open|allowlist|disabled>` — Set Discord guild channel policy',
          '`/model list [provider]` — List available runtime models',
          '`/model set <name>` — Set the model for this session',
          '`/model clear` — Clear the model override for this session',
          '`/model info` — Show effective, session, agent, and default model details',
          '`/model default [name]` — Show or set the default model for new sessions',
          '`/plugin list` — List discovered plugins, descriptions, commands, and load status',
          '`/plugin config <plugin-id> [key] [value|--unset]` — Show or change a plugin config override',
          '`/plugin install <path|npm-spec>` — Install a plugin from a local TUI/web session',
          '`/plugin reinstall <path|npm-spec>` — Replace an installed plugin from a local TUI/web session',
          '`/plugin reload` — Reload all plugins (picks up code changes without gateway restart)',
          '`/plugin uninstall <plugin-id>` — Remove a home-installed plugin and matching runtime config overrides',
          '`sessions` — List active sessions',
          '`usage [summary|daily|monthly|model [daily|monthly] [agentId]]` — Usage/cost aggregates',
          '`export session [sessionId]` — Export session JSONL snapshot for debugging',
          '`audit [sessionId]` — Show recent structured audit events for a session',
          '`skill list` — List available skills and availability',
          '`skill inspect <name>|--all` — Show observation-based skill health',
          '`skill runs <name>` — Show recent execution observations for a skill',
          '`skill amend <name> [--apply|--reject|--rollback]` — Stage or manage skill amendments',
          '`skill history <name>` — Show amendment history for a skill',
          '`schedule add "<cron>" <prompt>` — Add cron scheduled task',
          '`schedule add at "<ISO time>" <prompt>` — Add one-shot task',
          '`schedule add every <ms> <prompt>` — Add interval task',
          '`schedule list` — List scheduled tasks',
          '`schedule remove <id>` — Remove a task',
          '`schedule toggle <id>` — Enable/disable a task',
        ];
        return infoCommand('HybridClaw Commands', help.join('\n'));
      }

      case 'agent': {
        const sub = (req.args[1] || '').toLowerCase();
        if (!sub || sub === 'info' || sub === 'current') {
          const currentAgentId = resolveSessionAgentId(session);
          const agent = resolveAgentConfig(currentAgentId);
          const storedAgent = getStoredAgentConfig(currentAgentId);
          const runtime = resolveAgentForRequest({ session });
          return infoCommand(
            'Agent',
            [
              `Current agent: ${agent.id}`,
              ...(agent.name ? [`Name: ${agent.name}`] : []),
              `Effective model: ${formatModelForDisplay(runtime.model)}`,
              `Global model: ${formatModelForDisplay(HYBRIDAI_MODEL)}`,
              `Agent model: ${formatConfiguredAgentModel(storedAgent)}`,
              `Session model: ${formatSessionModelOverride(session.model)}`,
              `Chatbot: ${runtime.chatbotId || '(none)'}`,
              `Workspace: ${path.resolve(agentWorkspaceDir(agent.id))}`,
            ].join('\n'),
          );
        }

        if (sub === 'list') {
          const currentAgentId = resolveSessionAgentId(session);
          const entries = listAgents();
          const lines = entries.map((agent) => {
            const label =
              agent.id === currentAgentId ? `${agent.id} (current)` : agent.id;
            const model = resolveAgentModel(agent) || HYBRIDAI_MODEL;
            return agent.name
              ? `${label} — ${agent.name} · ${formatModelForDisplay(model)}`
              : `${label} — ${formatModelForDisplay(model)}`;
          });
          return infoCommand(
            'Agents',
            lines.length > 0 ? lines.join('\n') : 'No agents configured.',
          );
        }

        if (sub === 'switch') {
          const targetAgentId = String(req.args[2] || '').trim();
          if (!targetAgentId) {
            return badCommand('Usage', 'Usage: `agent switch <id>`');
          }
          const targetAgent = findAgentConfig(targetAgentId);
          if (!targetAgent) {
            return badCommand(
              'Not Found',
              `Agent \`${targetAgentId}\` was not found.`,
            );
          }
          updateSessionAgent(session.id, targetAgent.id);
          const model = resolveAgentModel(targetAgent) || HYBRIDAI_MODEL;
          return plainCommand(
            `Session agent set to \`${targetAgent.id}\` (model: \`${formatModelForDisplay(model)}\`).`,
          );
        }

        if (sub === 'model') {
          const currentAgentId = resolveSessionAgentId(session);
          const storedAgent =
            getStoredAgentConfig(currentAgentId) ??
            ({ id: currentAgentId } satisfies AgentConfig);
          const resolvedAgent = resolveAgentConfig(currentAgentId);
          const sessionOverride = formatSessionModelOverride(session.model);
          const modelName = String(req.args[2] || '').trim();

          if (!modelName) {
            const runtime = resolveAgentForRequest({ session });
            return infoCommand(
              'Agent Model',
              [
                `Current agent: ${resolvedAgent.id}`,
                `Effective model: ${formatModelForDisplay(runtime.model)}`,
                `Global model: ${formatModelForDisplay(HYBRIDAI_MODEL)}`,
                `Agent model: ${formatConfiguredAgentModel(storedAgent)}`,
                `Session model: ${sessionOverride}`,
              ].join('\n'),
            );
          }

          const normalizedModelName =
            normalizeHybridAIModelForRuntime(modelName);
          await refreshAvailableModelCatalogs({
            includeHybridAI:
              resolveModelProvider(normalizedModelName) === 'hybridai',
          });
          const availableModels = getAvailableModelList();
          if (
            availableModels.length > 0 &&
            !availableModels.includes(normalizedModelName)
          ) {
            return badCommand(
              'Unknown Model',
              `\`${modelName}\` is not in the available models list.`,
            );
          }

          const updated = upsertRegisteredAgent({
            ...storedAgent,
            model: normalizedModelName,
          });
          const effectiveModel = resolveAgentForRequest({ session }).model;
          const hasSessionOverride = sessionOverride !== '(none)';
          return infoCommand(
            'Agent Model Updated',
            [
              `Current agent: ${updated.id}`,
              `Effective model: ${formatModelForDisplay(effectiveModel)}`,
              `Global model: ${formatModelForDisplay(HYBRIDAI_MODEL)}`,
              `Agent model: ${formatConfiguredAgentModel(updated)}`,
              `Session model: ${sessionOverride}`,
              ...(hasSessionOverride
                ? [
                    'Run `model clear` to use the updated agent model in this session.',
                  ]
                : []),
            ].join('\n'),
          );
        }

        if (sub === 'create') {
          const newAgentId = String(req.args[2] || '').trim();
          if (!newAgentId) {
            return badCommand(
              'Usage',
              'Usage: `agent create <id> [--model <model>]`',
            );
          }
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(newAgentId)) {
            return badCommand(
              'Invalid Agent Id',
              'Agent ids must start with a letter or number and only use letters, numbers, `_`, or `-`.',
            );
          }
          if (findAgentConfig(newAgentId)) {
            return badCommand(
              'Already Exists',
              `Agent \`${newAgentId}\` already exists.`,
            );
          }

          let modelName: string | undefined;
          const trailingArgs = req.args.slice(3);
          if (trailingArgs.length > 0) {
            if (
              trailingArgs.length !== 2 ||
              trailingArgs[0] !== '--model' ||
              !String(trailingArgs[1] || '').trim()
            ) {
              return badCommand(
                'Usage',
                'Usage: `agent create <id> [--model <model>]`',
              );
            }
            modelName = normalizeHybridAIModelForRuntime(trailingArgs[1]);
            await refreshAvailableModelCatalogs({
              includeHybridAI: resolveModelProvider(modelName) === 'hybridai',
            });
            const availableModels = getAvailableModelList();
            if (availableModels.length === 0) {
              logger.warn(
                {
                  sessionId: req.sessionId,
                  agentId: newAgentId,
                  model: modelName,
                },
                'Skipping agent model validation because no available models are configured',
              );
            } else if (!availableModels.includes(modelName)) {
              return badCommand(
                'Unknown Model',
                `\`${modelName}\` is not in the available models list.`,
              );
            }
          }

          const created = upsertRegisteredAgent({
            id: newAgentId,
            ...(modelName ? { model: modelName } : {}),
          });
          return infoCommand(
            'Agent Created',
            [
              `Agent: ${created.id}`,
              `Model: ${formatModelForDisplay(resolveAgentModel(created) || HYBRIDAI_MODEL)}`,
              `Workspace: ${path.resolve(agentWorkspaceDir(created.id))}`,
            ].join('\n'),
          );
        }

        return badCommand(
          'Usage',
          'Usage: `agent|agent list|agent switch <id>|agent model [name]|agent create <id> [--model <model>]`',
        );
      }

      case 'bot': {
        const runtime = resolveAgentForRequest({ session });
        const sub = req.args[1]?.toLowerCase();
        if (sub === 'list') {
          try {
            const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
            if (bots.length === 0) return plainCommand('No bots available.');
            const list = bots
              .map(
                (b) =>
                  `• ${b.name} (${b.id})${b.model ? ` [${formatModelForDisplay(b.model)}]` : ''}${b.description ? ` — ${b.description}` : ''}`,
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
          const previousBotId = session.chatbot_id;
          const previousModel = session.model;
          let resolvedBotId = requested;
          let syncedModel: string | null = null;
          try {
            const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
            const matched = bots.find(
              (b) =>
                b.id === requested ||
                b.name.toLowerCase() === requested.toLowerCase(),
            );
            if (matched) {
              resolvedBotId = matched.id;
              const botModel = normalizeHybridAIModelForRuntime(
                matched.model || '',
              );
              syncedModel = botModel || null;
            }
          } catch (err) {
            return badCommand('Error', formatHybridAIBotFetchError(err));
          }
          updateSessionChatbot(session.id, resolvedBotId);
          if (syncedModel) {
            updateSessionModel(session.id, syncedModel);
          }
          recordAuditEvent({
            sessionId: session.id,
            runId: makeAuditRunId('cmd'),
            event: {
              type: 'bot.set',
              source: 'command',
              requestedBot: requested,
              previousBotId,
              resolvedBotId,
              changed: previousBotId !== resolvedBotId,
              previousModel,
              syncedModel,
              userId: boundAuditActorField(req.userId),
              username: boundAuditActorField(req.username),
            },
          });
          return plainCommand(
            syncedModel
              ? `Chatbot set to \`${resolvedBotId}\` and model set to \`${formatModelForDisplay(syncedModel)}\` for this session.`
              : `Chatbot set to \`${resolvedBotId}\` for this session.`,
          );
        }

        if (sub === 'info') {
          const botId = runtime.chatbotId || 'Not set';
          let botLabel = botId;
          let botModel: string | undefined;
          try {
            const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
            const bot = bots.find((b) => b.id === botId);
            if (bot) {
              botLabel = `${bot.name} (${bot.id})`;
              botModel = bot.model;
            }
          } catch {
            // keep ID fallback
          }
          const ragStatus = session.enable_rag ? 'Enabled' : 'Disabled';
          const lines = [
            `Chatbot: ${botLabel}`,
            ...(botModel
              ? [`Bot Model: ${formatModelForDisplay(botModel)}`]
              : []),
            `Model: ${formatModelForDisplay(runtime.model)}`,
            `RAG: ${ragStatus}`,
          ];
          return infoCommand('Bot Info', lines.join('\n'));
        }

        return badCommand('Usage', 'Usage: `bot list|set <id|name>|info`');
      }

      case 'model': {
        const sub = req.args[1]?.toLowerCase();
        const providerFilterArg = sub === 'list' ? req.args[2] : undefined;
        const providerFilter = providerFilterArg
          ? normalizeModelCatalogProviderFilter(providerFilterArg)
          : null;
        await refreshAvailableModelCatalogs({
          includeHybridAI:
            sub !== 'list' ||
            !providerFilterArg ||
            providerFilter === 'hybridai',
        });
        const availableModels = getAvailableModelList();
        const runtime = resolveSessionRuntimeTarget(session);
        const currentAgentId = resolveSessionAgentId(session);
        const resolvedAgent = resolveAgentConfig(currentAgentId);
        const sessionOverride = formatSessionModelOverride(session.model);
        const fallbackModel =
          resolveAgentModel(resolvedAgent) || HYBRIDAI_MODEL;
        if (sub === 'list') {
          if (providerFilterArg && !providerFilter) {
            return badCommand(
              'Unknown Provider',
              'Usage: `model list [hybridai|codex|openrouter|local|ollama|lmstudio|vllm]`',
            );
          }
          const listedModels = getAvailableModelList(providerFilterArg);
          const current = runtime.model;
          const modelCatalog = listedModels.map((model) => {
            const label = formatModelForDisplay(model);
            return {
              value: model,
              label: model === current ? `${label} (current)` : label,
              isFree: isAvailableModelFree(model),
            };
          });
          const list = modelCatalog.map((entry) => entry.label).join('\n');
          if (!list) {
            return infoCommand(
              'Available Models',
              providerFilterArg
                ? `No models available for provider \`${providerFilterArg}\`.`
                : 'No models available.',
            );
          }
          return infoCommand(
            providerFilterArg
              ? `Available Models (${providerFilterArg})`
              : 'Available Models',
            list,
            undefined,
            { modelCatalog },
          );
        }

        if (sub === 'default') {
          const modelName = req.args[2];
          if (!modelName) {
            const defaultLine = `Default model: ${formatModelForDisplay(HYBRIDAI_MODEL)}`;
            if (availableModels.length === 0) {
              return infoCommand('Default Model', defaultLine);
            }
            const list = availableModels
              .map((m) => {
                const label = formatModelForDisplay(m);
                return m === HYBRIDAI_MODEL ? `${label} (default)` : label;
              })
              .join('\n');
            return infoCommand('Default Model', `${defaultLine}\n\n${list}`);
          }
          const normalizedModelName =
            normalizeHybridAIModelForRuntime(modelName);
          if (
            availableModels.length > 0 &&
            !availableModels.includes(normalizedModelName)
          ) {
            return badCommand(
              'Unknown Model',
              `\`${modelName}\` is not in the available models list.`,
            );
          }
          updateRuntimeConfig((draft) => {
            draft.hybridai.defaultModel = normalizedModelName;
          });
          return plainCommand(
            `Default model set to \`${formatModelForDisplay(normalizedModelName)}\` for new sessions.`,
          );
        }

        if (sub === 'set') {
          const modelName = req.args[2];
          if (!modelName)
            return badCommand('Usage', 'Usage: `model set <name>`');
          const normalizedModelName =
            normalizeHybridAIModelForRuntime(modelName);
          if (
            availableModels.length > 0 &&
            !availableModels.includes(normalizedModelName)
          ) {
            return badCommand(
              'Unknown Model',
              `\`${modelName}\` is not in the available models list.`,
            );
          }
          updateSessionModel(session.id, normalizedModelName);
          return plainCommand(
            `Model set to \`${formatModelForDisplay(normalizedModelName)}\` for this session.`,
          );
        }

        if (sub === 'clear' || sub === 'auto') {
          updateSessionModel(session.id, null);
          return plainCommand(
            sessionOverride === '(none)'
              ? `Session model override is already clear. Effective model: \`${formatModelForDisplay(fallbackModel)}\`.`
              : `Session model override cleared. Effective model: \`${formatModelForDisplay(fallbackModel)}\`.`,
          );
        }

        if (sub === 'info') {
          return infoCommand(
            'Model Info',
            [
              `Effective model: ${formatModelForDisplay(runtime.model)}`,
              `Global model: ${formatModelForDisplay(HYBRIDAI_MODEL)}`,
              `Agent model: ${formatConfiguredAgentModel(resolvedAgent)}`,
              `Session model: ${sessionOverride}`,
            ].join('\n'),
          );
        }

        return badCommand(
          'Usage',
          'Usage: `model list [provider]|set <name>|clear|default [name]|info`',
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
            return badCommand(
              'Usage',
              'Usage: `channel mode off|mention|free`',
            );
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
        const restarted = interruptGatewaySessionExecution(req.sessionId);
        const restartNote = restarted
          ? ' Current session container restarted to apply immediately.'
          : '';
        return plainCommand(
          `Ralph loop set to ${formatRalphIterations(normalized)}.${restartNote}`,
        );
      }

      case 'fullauto': {
        const sub = (req.args[1] || '').trim().toLowerCase();
        if (!sub) {
          const refreshed = memoryService.getSessionById(session.id) ?? session;
          return infoCommand(
            'Full-Auto Status',
            buildFullAutoStatusLines(refreshed).join('\n'),
          );
        }

        if (sub === 'on') {
          const promptText = req.args.slice(2).join(' ').trim();
          return enableFullAutoCommand({
            session,
            req,
            prompt: promptText || null,
          });
        }

        if (sub === 'off' || sub === 'disable' || sub === 'stop') {
          await disableFullAutoSession({ sessionId: session.id });
          return plainCommand(
            'Full-auto mode disabled. Current turns may finish, but no further auto-turns will be queued.',
          );
        }

        if (sub === 'status' || sub === 'info') {
          const refreshed = memoryService.getSessionById(session.id) ?? session;
          return infoCommand(
            'Full-Auto Status',
            buildFullAutoStatusLines(refreshed).join('\n'),
          );
        }

        const prompt = req.args.slice(1).join(' ').trim();
        if (!prompt) {
          return badCommand(
            'Usage',
            'Usage: `fullauto [status|off|on [prompt]|<prompt>]`',
          );
        }
        return enableFullAutoCommand({
          session,
          req,
          prompt,
        });
      }

      case 'show': {
        const currentMode = normalizeSessionShowMode(session.show_mode);
        const nextMode = (req.args[1] || '').trim().toLowerCase();

        if (!nextMode || nextMode === 'info' || nextMode === 'status') {
          return infoCommand(
            'Show Mode',
            [
              `Current: ${currentMode}`,
              describeSessionShowMode(currentMode),
              'Modes: `show all`, `show thinking`, `show tools`, `show none`',
            ].join('\n'),
          );
        }

        if (!isSessionShowMode(nextMode)) {
          return badCommand('Usage', 'Usage: `show [all|thinking|tools|none]`');
        }

        updateSessionShowMode(session.id, nextMode);
        return infoCommand(
          'Show Mode',
          [`Current: ${nextMode}`, describeSessionShowMode(nextMode)].join(
            '\n',
          ),
        );
      }

      case 'stop':
      case 'abort': {
        await disableFullAutoSession({ sessionId: session.id });
        const stopped = interruptGatewaySessionExecution(req.sessionId);
        return plainCommand(
          stopped
            ? 'Stopped the current session run and disabled full-auto mode.'
            : 'No active session run. Full-auto mode disabled.',
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

      case 'plugin': {
        const sub = (req.args[1] || 'list').toLowerCase();
        if (sub === 'list') {
          if (!pluginManager) {
            return badCommand(
              'Plugin Runtime Unavailable',
              pluginInitError instanceof Error
                ? pluginInitError.message
                : 'Plugin manager failed to initialize.',
            );
          }
          return infoCommand(
            'Plugins',
            formatPluginSummaryList(pluginManager.listPluginSummary()),
          );
        }
        if (sub === 'config') {
          const pluginId = String(req.args[2] || '').trim();
          const key = String(req.args[3] || '').trim();
          const rawValue = req.args.slice(4).join(' ').trim();
          if (!pluginId) {
            return badCommand(
              'Usage',
              'Usage: `plugin config <plugin-id> [key] [value|--unset]`',
            );
          }
          if (!key) {
            const result = readPluginConfigEntry(pluginId);
            if (!result.entry) {
              return infoCommand(
                'Plugin Config',
                [
                  `Plugin: ${result.pluginId}`,
                  `Config file: ${result.configPath}`,
                  'Override: (none)',
                ].join('\n'),
              );
            }
            return infoCommand(
              'Plugin Config',
              [
                `Plugin: ${result.pluginId}`,
                `Config file: ${result.configPath}`,
                'Override:',
                formatPluginConfigValue(result.entry),
              ].join('\n'),
            );
          }
          if (!rawValue) {
            const result = readPluginConfigValue(pluginId, key);
            return infoCommand(
              'Plugin Config',
              [
                `Plugin: ${result.pluginId}`,
                `Key: ${result.key}`,
                `Value: ${formatPluginConfigValue(result.value)}`,
                `Config file: ${result.configPath}`,
              ].join('\n'),
            );
          }
          if (
            req.guildId !== null ||
            (req.channelId !== 'web' && req.channelId !== 'tui')
          ) {
            return badCommand(
              'Plugin Config Restricted',
              '`plugin config` writes runtime config and is only available from local TUI/web sessions.',
            );
          }

          const previousConfig = getRuntimeConfig();
          try {
            const result =
              rawValue === '--unset'
                ? await unsetPluginConfigValue(pluginId, key)
                : await writePluginConfigValue(pluginId, key, rawValue);
            const reloadResult = await reloadPluginRuntime();
            if (!reloadResult.ok) {
              saveRuntimeConfig(previousConfig);
              await reloadPluginRuntime();
              return badCommand(
                'Plugin Config Failed',
                [
                  `Plugin: ${result.pluginId}`,
                  `Key: ${result.key}`,
                  `Updated runtime config at \`${result.configPath}\`, but plugin reload failed.`,
                  'Previous runtime config was restored.',
                ].join('\n'),
              );
            }
            return infoCommand(
              result.removed
                ? result.changed
                  ? 'Plugin Config Removed'
                  : 'Plugin Config Unchanged'
                : result.changed
                  ? 'Plugin Config Updated'
                  : 'Plugin Config Unchanged',
              [
                `Plugin: ${result.pluginId}`,
                `Key: ${result.key}`,
                result.removed
                  ? result.changed
                    ? 'Value: (unset)'
                    : 'Value was already unset.'
                  : `Value: ${formatPluginConfigValue(result.value)}`,
                `Updated runtime config at \`${result.configPath}\`.`,
                reloadResult.message,
              ].join('\n'),
            );
          } catch (error) {
            saveRuntimeConfig(previousConfig);
            return badCommand(
              'Plugin Config Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (sub === 'install') {
          const source = String(req.args[2] || '').trim();
          if (!source) {
            return badCommand(
              'Usage',
              'Usage: `plugin install <path|npm-spec>`',
            );
          }
          if (
            req.guildId !== null ||
            (req.channelId !== 'web' && req.channelId !== 'tui')
          ) {
            return badCommand(
              'Plugin Install Restricted',
              '`plugin install` is only available from local TUI/web sessions.',
            );
          }
          try {
            const result = await installPlugin(source);
            const reloadResult = await reloadPluginRuntime();
            const lines = [
              result.alreadyInstalled
                ? `Plugin \`${result.pluginId}\` is already present at \`${result.pluginDir}\`.`
                : `Installed plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`,
              ...(result.dependenciesInstalled
                ? ['Installed plugin npm dependencies.']
                : []),
              `Plugin \`${result.pluginId}\` will auto-discover from \`${result.pluginDir}\`.`,
              ...(result.requiresEnv.length > 0
                ? [`Required env vars: ${result.requiresEnv.join(', ')}`]
                : []),
              result.requiredConfigKeys.length > 0
                ? `Add a \`plugins.list[]\` override in \`${runtimeConfigPath()}\` to set required config keys: ${result.requiredConfigKeys.join(', ')}`
                : `No config entry is required unless you want plugin overrides in \`${runtimeConfigPath()}\`.`,
              reloadResult.message,
            ];
            return infoCommand('Plugin Installed', lines.join('\n'));
          } catch (error) {
            return badCommand(
              'Plugin Install Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (sub === 'reinstall') {
          const source = String(req.args[2] || '').trim();
          if (!source) {
            return badCommand(
              'Usage',
              'Usage: `plugin reinstall <path|npm-spec>`',
            );
          }
          if (
            req.guildId !== null ||
            (req.channelId !== 'web' && req.channelId !== 'tui')
          ) {
            return badCommand(
              'Plugin Reinstall Restricted',
              '`plugin reinstall` is only available from local TUI/web sessions.',
            );
          }
          try {
            const result = await reinstallPlugin(source);
            const reloadResult = await reloadPluginRuntime();
            const lines = [
              result.replacedExistingInstall
                ? `Reinstalled plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`
                : `Installed plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`,
              ...(result.dependenciesInstalled
                ? ['Installed plugin npm dependencies.']
                : []),
              `Plugin \`${result.pluginId}\` will auto-discover from \`${result.pluginDir}\`.`,
              ...(result.requiresEnv.length > 0
                ? [`Required env vars: ${result.requiresEnv.join(', ')}`]
                : []),
              result.requiredConfigKeys.length > 0
                ? `Add a \`plugins.list[]\` override in \`${runtimeConfigPath()}\` to set required config keys: ${result.requiredConfigKeys.join(', ')}`
                : `No config entry is required unless you want plugin overrides in \`${runtimeConfigPath()}\`.`,
              reloadResult.message,
            ];
            return infoCommand('Plugin Reinstalled', lines.join('\n'));
          } catch (error) {
            return badCommand(
              'Plugin Reinstall Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (sub === 'uninstall') {
          const pluginId = String(req.args[2] || '').trim();
          if (!pluginId) {
            return badCommand(
              'Usage',
              'Usage: `plugin list|install <path|npm-spec>|reinstall <path|npm-spec>|uninstall <plugin-id>`',
            );
          }
          try {
            const result = await uninstallPlugin(pluginId);
            await shutdownPluginManager();
            const lines = [
              result.removedPluginDir
                ? `Uninstalled plugin \`${result.pluginId}\` from \`${result.pluginDir}\`.`
                : `Removed plugin overrides for \`${result.pluginId}\`; no home install existed at \`${result.pluginDir}\`.`,
              result.removedConfigOverrides > 0
                ? `Removed ${result.removedConfigOverrides} matching \`plugins.list[]\` override${result.removedConfigOverrides === 1 ? '' : 's'}.`
                : 'No matching `plugins.list[]` overrides were removed.',
              'Plugin runtime will reload on the next turn.',
            ];
            return infoCommand('Plugin Uninstalled', lines.join('\n'));
          } catch (error) {
            return badCommand(
              'Plugin Uninstall Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (sub === 'reload') {
          const reloadResult = await reloadPluginRuntime();
          if (!reloadResult.ok) {
            return badCommand('Plugin Reload Failed', reloadResult.message);
          }
          return infoCommand('Plugins Reloaded', reloadResult.message);
        }
        return badCommand(
          'Usage',
          'Usage: `plugin list|config <plugin-id> [key] [value|--unset]|install <path|npm-spec>|reinstall <path|npm-spec>|reload|uninstall <plugin-id>`',
        );
      }

      case 'clear': {
        const rotated = createFreshSessionInstance(session.id);
        req.sessionId = rotated.session.id;
        session = rotated.session;
        if (pluginManager) {
          await pluginManager.handleSessionReset({
            previousSessionId: rotated.previousSession.id,
            sessionId: rotated.session.id,
            userId: String(req.userId || ''),
            agentId: resolveSessionAgentId(rotated.previousSession),
            channelId: req.channelId,
            reason: 'clear',
          });
        }
        if (typeof req.userId === 'string' && req.userId.trim()) {
          memoryService.clearCanonicalContext({
            agentId: resolveSessionAgentId(session),
            userId: req.userId,
          });
        }
        clearCanonicalPromptContext({
          agentId: resolveSessionAgentId(session),
          session,
          userId: req.userId,
        });
        return infoCommand(
          'Session Cleared',
          `Deleted ${rotated.deletedMessages} messages. Workspace files preserved.`,
        );
      }

      case 'reset': {
        const sub = req.args[1]?.toLowerCase();
        if (sub && sub !== 'yes' && sub !== 'no') {
          return badCommand('Usage', 'Usage: `reset [yes|no]`');
        }

        if (sub === 'no') {
          pendingSessionResets.delete(req.sessionId);
          return plainCommand(
            'Reset cancelled. Session history and workspace were left unchanged.',
          );
        }

        if (sub === 'yes') {
          const pending = getPendingSessionReset(req.sessionId);
          if (!pending) {
            return badCommand(
              'Confirmation Required',
              'Run `reset` first, then confirm with `reset yes` or cancel with `reset no`.',
            );
          }

          pendingSessionResets.delete(req.sessionId);
          await disableFullAutoSession({ sessionId: session.id });
          interruptGatewaySessionExecution(req.sessionId);
          const rotated = createFreshSessionInstance(session.id, {
            resetSettings: true,
            defaultEnableRag: HYBRIDAI_ENABLE_RAG,
          });
          req.sessionId = rotated.session.id;
          session = rotated.session;
          if (pluginManager) {
            await pluginManager.handleSessionReset({
              previousSessionId: rotated.previousSession.id,
              sessionId: rotated.session.id,
              userId: String(req.userId || ''),
              agentId: pending.agentId,
              channelId: req.channelId,
              reason: 'reset',
            });
          }
          if (typeof req.userId === 'string' && req.userId.trim()) {
            memoryService.clearCanonicalContext({
              agentId: pending.agentId,
              userId: req.userId,
            });
          }
          clearCanonicalPromptContext({
            agentId: pending.agentId,
            session,
            userId: req.userId,
          });
          const workspaceReset = resetWorkspace(pending.agentId);
          const workspaceLine = workspaceReset.removed
            ? `Removed workspace: ${workspaceReset.workspacePath}`
            : `Workspace was already empty: ${workspaceReset.workspacePath}`;
          return infoCommand(
            'Session Reset',
            [
              `Deleted ${rotated.deletedMessages} messages.`,
              `Session model/chatbot/show settings reset to defaults. RAG default is now ${HYBRIDAI_ENABLE_RAG ? 'enabled' : 'disabled'}.`,
              workspaceLine,
            ].join('\n'),
          );
        }

        const runtime = resolveSessionRuntimeTarget(session);
        const resetComponents =
          isDiscordChannelId(req.channelId) && typeof req.userId === 'string'
            ? buildResetConfirmationComponents({
                sessionId: req.sessionId,
                userId: req.userId,
              })
            : undefined;
        pendingSessionResets.set(req.sessionId, {
          requestedAt: Date.now(),
          agentId: runtime.agentId,
          workspacePath: runtime.workspacePath,
          model: runtime.model,
          chatbotId: runtime.chatbotId,
        });
        return infoCommand(
          'Confirm Reset',
          [
            `This will delete this session's history, reset per-session model/bot/show settings, and remove the current agent workspace.`,
            `Model: ${formatModelForDisplay(runtime.model)}`,
            `Agent workspace: ${runtime.workspacePath}`,
            resetComponents
              ? 'Use the buttons below to continue or cancel.'
              : 'Reply with `reset yes` to continue or `reset no` to cancel.',
          ].join('\n'),
          resetComponents,
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
        const runtime = resolveSessionRuntimeTarget(session);
        const sessionModel = runtime.model;
        if (sessionModel.trim().toLowerCase().startsWith('openrouter/')) {
          await discoverOpenRouterModels();
        }
        const modelContextWindowTokens =
          resolveLocalModelContextWindow(sessionModel) ??
          getDiscoveredHybridAIModelContextWindow(sessionModel) ??
          getDiscoveredOpenRouterModelContextWindow(sessionModel) ??
          resolveModelContextWindowFallback(sessionModel);
        const metrics = readSessionStatusSnapshot(session.id, {
          modelContextWindowTokens,
        });
        const queueLabel = `${delegationStatus.active} active / ${delegationStatus.queued} queued`;
        const proactiveQueued = getQueuedProactiveMessageCount();
        const cacheKnown =
          metrics.cacheReadTokens != null || metrics.cacheWriteTokens != null;
        const cacheHitLabel = formatPercent(
          cacheKnown ? (metrics.cacheHitPercent ?? 0) : metrics.cacheHitPercent,
        );
        const contextLabel =
          metrics.contextUsedTokens != null &&
          metrics.contextBudgetTokens != null
            ? `${formatCompactNumber(metrics.contextUsedTokens)}/${formatCompactNumber(metrics.contextBudgetTokens)} (${formatPercent(metrics.contextUsagePercent)})`
            : metrics.contextUsedTokens != null
              ? `${formatCompactNumber(metrics.contextUsedTokens)}/? (window unknown)`
              : 'n/a';
        const sandboxLabel = `${status.sandbox?.mode || 'container'} (${status.sandbox?.activeSessions ?? status.activeContainers} active)`;
        const fullAutoState = getFullAutoRuntimeState(session.id);
        const fullAutoLabel = isFullAutoEnabled(session)
          ? `on (${fullAutoState?.turns ?? 0} turns, ${fullAutoState?.consecutiveErrors ?? 0} errors)`
          : 'off';
        const showMode = normalizeSessionShowMode(session.show_mode);
        const lines = [
          `🦞 HybridClaw v${status.version}${commitShort ? ` (${commitShort})` : ''}`,
          `🧠 Model: ${formatModelForDisplay(sessionModel)}`,
          `🧮 Tokens: ${formatCompactNumber(metrics.promptTokens)} in / ${formatCompactNumber(metrics.completionTokens)} out`,
          cacheKnown
            ? `🗄️ Cache: ${cacheHitLabel} hit · ${formatCompactNumber(metrics.cacheReadTokens)} cached, ${formatCompactNumber(metrics.cacheWriteTokens)} new`
            : '🗄️ Cache: n/a (provider did not report cache stats)',
          `📚 Context: ${contextLabel} · 🧹 Compactions: ${session.compaction_count}`,
          `📊 Usage: uptime ${formatUptime(status.uptime)} · sessions ${status.sessions} · sandbox ${sandboxLabel}`,
          `🧵 Session: ${session.id} • updated ${formatRelativeTime(session.last_active)}`,
          `🤖 Agent: ${runtime.agentId}`,
          `📁 CWD: ${runtime.workspacePath}`,
          `⚙️ Runtime: ${status.sandbox?.mode || 'container'} · RAG: ${session.enable_rag ? 'on' : 'off'} · Ralph: ${formatRalphIterations(resolveSessionRalphIterations(session))} · Show: ${showMode}`,
          `🤖 Full-auto: ${fullAutoLabel}`,
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
            return plainCommand(
              'No usage events recorded for model breakdown.',
            );
          }
          const lines = rows.slice(0, 20).map((row) => {
            return `${formatModelForDisplay(row.model)} — ${formatCompactNumber(row.total_tokens)} tokens · ${row.call_count} calls · ${formatUsd(row.total_cost_usd)}`;
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
          agentId: currentAgentId,
          window: 'daily',
        });
        const monthly = getUsageTotals({
          agentId: currentAgentId,
          window: 'monthly',
        });
        const topModels = listUsageByModel({
          agentId: currentAgentId,
          window: 'monthly',
        }).slice(0, 5);
        const scopeLabel = currentAgentId;
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
                `- ${formatModelForDisplay(row.model)}: ${formatCompactNumber(row.total_tokens)} tokens · ${formatUsd(row.total_cost_usd)}`,
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
        const exportAgentId = resolveSessionAgentId(targetSession);
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

      case 'skill': {
        const sub = (req.args[1] || '').trim().toLowerCase();
        if (!sub) {
          return badCommand(
            'Usage',
            'Usage: `skill list|inspect <name>|inspect --all|amend <name> [--apply|--reject|--rollback]|history <name>`',
          );
        }

        if (sub === 'list') {
          const catalog = loadSkillCatalog();
          if (catalog.length === 0) {
            return plainCommand('No skills are available.');
          }
          const lines = catalog.map((skill) => {
            const availability = skill.available
              ? skill.enabled
                ? 'available'
                : 'disabled'
              : skill.missing.join(', ');
            const description = skill.description
              ? ` — ${skill.description}`
              : '';
            return `${skill.name} [${availability}]${description}`;
          });
          return infoCommand('Skills', lines.join('\n'));
        }

        if (sub === 'inspect') {
          const inspectionModule = await import(
            '../skills/skills-inspection.js'
          );
          const target = String(req.args[2] || '').trim();
          if (!target) {
            return badCommand(
              'Usage',
              'Usage: `skill inspect <name>` or `skill inspect --all`',
            );
          }
          if (target === '--all' || target.toLowerCase() === 'all') {
            const metricsList = inspectionModule.inspectAllSkills();
            if (metricsList.length === 0) {
              return plainCommand(
                'No observed skills found in the current inspection window.',
              );
            }
            return infoCommand(
              'Skill Health',
              metricsList.map(formatSkillHealthMetrics).join('\n\n'),
            );
          }

          const metrics = inspectionModule.inspectSkill(target);
          if (metrics.total_executions === 0) {
            return plainCommand(`No observations found for \`${target}\`.`);
          }
          return infoCommand('Skill Health', formatSkillHealthMetrics(metrics));
        }

        if (sub === 'amend') {
          const skillName = String(req.args[2] || '').trim();
          if (!skillName) {
            return badCommand(
              'Usage',
              'Usage: `skill amend <name> [--apply|--reject|--rollback]`',
            );
          }

          const actions = new Set(
            req.args
              .slice(3)
              .map((entry) =>
                String(entry || '')
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean),
          );
          const hasApply = actions.has('--apply') || actions.has('apply');
          const hasReject = actions.has('--reject') || actions.has('reject');
          const hasRollback =
            actions.has('--rollback') || actions.has('rollback');
          const selectedActions = [hasApply, hasReject, hasRollback].filter(
            Boolean,
          ).length;
          if (selectedActions > 1) {
            return badCommand(
              'Usage',
              'Choose at most one amendment action: `--apply`, `--reject`, or `--rollback`.',
            );
          }

          const dbModule = await import('../memory/db.js');
          const amendmentModule = await import('../skills/skills-amendment.js');
          const evaluationModule = await import(
            '../skills/skills-evaluation.js'
          );
          const inspectionModule = await import(
            '../skills/skills-inspection.js'
          );

          if (hasApply) {
            const amendment = dbModule.getLatestSkillAmendment({
              skillName,
              status: 'staged',
            });
            if (!amendment) {
              return plainCommand(
                `No staged amendment found for \`${skillName}\`.`,
              );
            }
            const result = await amendmentModule.applyAmendment({
              amendmentId: amendment.id,
              reviewedBy: 'gateway-command',
            });
            if (!result.ok) {
              return badCommand(
                'Apply Failed',
                result.reason || 'Failed to apply amendment.',
              );
            }
            return plainCommand(
              `Applied staged amendment v${amendment.version} for \`${skillName}\`.`,
            );
          }

          if (hasReject) {
            const amendment = dbModule.getLatestSkillAmendment({
              skillName,
              status: 'staged',
            });
            if (!amendment) {
              return plainCommand(
                `No staged amendment found for \`${skillName}\`.`,
              );
            }
            const result = amendmentModule.rejectAmendment({
              amendmentId: amendment.id,
              reviewedBy: 'gateway-command',
            });
            if (!result.ok) {
              return badCommand(
                'Reject Failed',
                result.reason || 'Failed to reject amendment.',
              );
            }
            return plainCommand(
              `Rejected staged amendment v${amendment.version} for \`${skillName}\`.`,
            );
          }

          if (hasRollback) {
            const amendment = dbModule.getLatestSkillAmendment({
              skillName,
              status: 'applied',
            });
            if (!amendment) {
              return plainCommand(
                `No applied amendment found for \`${skillName}\`.`,
              );
            }
            const result = await evaluationModule.rollbackAmendment({
              amendmentId: amendment.id,
              reason: 'Rollback requested via gateway command.',
            });
            if (!result.ok) {
              return badCommand(
                'Rollback Failed',
                result.reason || 'Failed to roll back amendment.',
              );
            }
            return plainCommand(
              `Rolled back amendment v${amendment.version} for \`${skillName}\`.`,
            );
          }

          const metrics = inspectionModule.inspectSkill(skillName);
          if (metrics.total_executions === 0) {
            return plainCommand(
              `No observations found for \`${skillName}\`; run the skill first before proposing an amendment.`,
            );
          }
          const amendment = await amendmentModule.proposeAmendment({
            skillName,
            metrics,
            agentId: resolveSessionAgentId(session) || DEFAULT_AGENT_ID,
          });
          return infoCommand(
            `Skill Amendment (${skillName})`,
            formatSkillAmendment(amendment),
          );
        }

        if (sub === 'history') {
          const skillName = String(req.args[2] || '').trim();
          if (!skillName) {
            return badCommand('Usage', 'Usage: `skill history <name>`');
          }
          const dbModule = await import('../memory/db.js');
          const history = dbModule.getAmendmentHistory(skillName);
          if (history.length === 0) {
            return plainCommand(
              `No amendment history found for \`${skillName}\`.`,
            );
          }
          return infoCommand(
            `Skill History (${skillName})`,
            history.map(formatSkillAmendment).join('\n\n'),
          );
        }

        if (sub === 'runs') {
          const skillName = String(req.args[2] || '').trim();
          if (!skillName) {
            return badCommand('Usage', 'Usage: `skill runs <name>`');
          }
          const { getSkillExecutionRuns } = await import(
            '../skills/skills-management.js'
          );
          const runs = getSkillExecutionRuns(skillName);
          if (runs.length === 0) {
            return plainCommand(`No observations found for \`${skillName}\`.`);
          }
          return infoCommand(
            `Skill Runs (${skillName})`,
            runs.map(formatSkillObservationRun).join('\n\n'),
          );
        }

        return badCommand(
          'Usage',
          'Usage: `skill list|inspect <name>|inspect --all|runs <name>|amend <name> [--apply|--reject|--rollback]|history <name>`',
        );
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
          const taskId = createTask(
            session.id,
            req.channelId,
            cronExpr,
            prompt,
          );
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

      default: {
        const pluginCommand = pluginManager?.findCommand(cmd);
        if (pluginCommand) {
          try {
            return normalizePluginCommandResult(
              await pluginCommand.handler(req.args.slice(1), {
                sessionId: req.sessionId,
                channelId: req.channelId,
                userId: req.userId,
                username: req.username ?? null,
                guildId: req.guildId ?? null,
              }),
            );
          } catch (error) {
            return badCommand(
              'Plugin Command Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return badCommand(
          'Unknown Command',
          `Unknown command: \`${cmd || '(empty)'}\`.`,
        );
      }
    }
  })();

  return attachCommandSessionIdentity(result);
}
