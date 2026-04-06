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
  getActiveExecutorSessionIds,
  getSandboxDiagnostics,
} from '../agent/executor.js';
import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import {
  buildToolsSummary,
  getKnownToolGroupLabel,
  getKnownToolGroups,
  isKnownToolName,
} from '../agent/tool-summary.js';
import {
  isLocalFilesystemInstallSource,
  resolveInstallArchiveSource,
} from '../agents/agent-install-source.js';
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
  type RuntimeHttpRequestAuthRule,
  reloadRuntimeConfig,
  resolveDefaultAgentId,
  runtimeConfigPath,
  saveRuntimeConfig,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import {
  parseRuntimeConfigCommandValue,
  setRuntimeConfigValueAtPath,
} from '../config/runtime-config-edit.js';
import { checkConfigFile } from '../doctor/checks/config.js';
import { summarizeCounts } from '../doctor/utils.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { isAudioMediaItem } from '../media/audio-transcription.js';
import { summarizeMediaFilenames } from '../media/media-summary.js';
import { NoCompactableMessagesError } from '../memory/compaction.js';
import {
  createFreshSessionInstance,
  createTask,
  deleteMemoryValue,
  deleteSessionData,
  deleteTask,
  getAllSessions,
  getFullAutoSessionCount,
  getMemoryValue,
  getQueuedProactiveMessageCount,
  getRecentSessionsForUser,
  getRecentStructuredAuditForSession,
  getSessionBoundaryMessagesBySessionIds,
  getSessionCount,
  getSessionFileChangeCounts,
  getSessionMessageCounts,
  getSessionToolCallBreakdown,
  getSessionUsageTotals,
  getSessionUsageTotalsSince,
  getStructuredAuditForSession,
  getTasksForSession,
  getUsageTotals,
  listStructuredAuditEntries,
  listUsageByAgent,
  listUsageByModel,
  listUsageBySession,
  pauseTask,
  recordRequestLog,
  recordUsageEvent,
  resumeTask,
  setMemoryValue,
  updateSessionAgent,
  updateSessionChatbot,
  updateSessionModel,
  updateSessionRag,
  updateSessionShowMode,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { listLoadedPluginCommands } from '../plugins/plugin-manager.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import {
  discoverHuggingFaceModels,
  getDiscoveredHuggingFaceModelContextWindow,
} from '../providers/huggingface-discovery.js';
import { readHuggingFaceApiKey } from '../providers/huggingface-utils.js';
import {
  fetchHybridAIAccountChatbotId,
  fetchHybridAIBots,
  HybridAIBotFetchError,
} from '../providers/hybridai-bots.js';
import {
  getDiscoveredHybridAIModelContextWindow,
  getDiscoveredHybridAIModelNames,
} from '../providers/hybridai-discovery.js';
import {
  type HybridAIHealthResult,
  hybridAIProbe,
} from '../providers/hybridai-health.js';
import { resolveModelContextWindowFallback } from '../providers/hybridai-models.js';
import {
  getLocalModelInfo,
  resolveLocalModelContextWindow,
} from '../providers/local-discovery.js';
import { localBackendsProbe } from '../providers/local-health.js';
import {
  discoverMistralModels,
  getDiscoveredMistralModelContextWindow,
  resolveDiscoveredMistralModelCanonicalName,
} from '../providers/mistral-discovery.js';
import { readMistralApiKey } from '../providers/mistral-utils.js';
import {
  getAvailableModelList,
  getAvailableModelListWithOptions,
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
import { readOpenRouterApiKey } from '../providers/openrouter-utils.js';
import { isRecommendedModel } from '../providers/recommended-models.js';
import { getSchedulerStatus, rearmScheduler } from '../scheduler/scheduler.js';
import { redactSecrets } from '../security/redact.js';
import {
  isReservedNonSecretRuntimeName,
  isRuntimeSecretName,
  listStoredRuntimeSecretNames,
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { buildSessionContext } from '../session/session-context.js';
import { exportSessionSnapshotJsonl } from '../session/session-export.js';
import { parseSessionKey } from '../session/session-key.js';
import {
  maybeCompactSession,
  runPreCompactionMemoryFlush,
} from '../session/session-maintenance.js';
import {
  buildSessionBoundaryPreview,
  SESSIONS_COMMAND_SNIPPET_MAX_LENGTH,
} from '../session/session-preview.js';
import {
  evaluateSessionExpiry,
  resolveResetPolicy,
  resolveSessionResetChannelKind,
  type SessionExpiryEvaluation,
  type SessionResetPolicy,
} from '../session/session-reset.js';
import { exportSessionTraceAtifJsonl } from '../session/session-trace-export.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type {
  SkillAmendment,
  SkillHealthMetrics,
  SkillObservation,
} from '../skills/adaptive-skills-types.js';
import { parseSkillImportArgs } from '../skills/skill-import-args.js';
import { buildGuardWarningLines } from '../skills/skill-import-warnings.js';
import { loadSkillCatalog } from '../skills/skills.js';
import type { ChatMessage } from '../types/api.js';
import type { StructuredAuditEntry } from '../types/audit.js';
import type { MediaContextItem } from '../types/container.js';
import type { ArtifactMetadata, ToolExecution } from '../types/execution.js';
import type { McpServerConfig } from '../types/models.js';
import type {
  ConversationHistoryPage,
  Session,
  StoredMessage,
} from '../types/session.js';
import type {
  DelegationSideEffect,
  DelegationTaskSpec,
} from '../types/side-effects.js';
import type { TokenUsageStats } from '../types/usage.js';
import { sleep } from '../utils/sleep.js';
import {
  ensureBootstrapFiles,
  resetWorkspace,
  resolveStartupBootstrapFile,
} from '../workspace.js';
import {
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from './chat-result.js';
import { handleConciergeCommand } from './concierge-commands.js';
import {
  buildFullAutoStatusLines,
  disableFullAutoSession,
  enableFullAutoSession,
} from './fullauto.js';
import {
  getFullAutoRuntimeState,
  isFullAutoEnabled,
  type ProactiveMessagePayload,
  resolveSessionRalphIterations,
} from './fullauto-runtime.js';
import {
  describeFullAutoWorkspaceSummary,
  resolveFullAutoPrompt,
} from './fullauto-workspace.js';
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
import { tryEnsurePluginManagerInitializedForGateway } from './gateway-plugin-runtime.js';
import {
  handlePluginGatewayCommand,
  reloadPluginRuntime,
  tryHandlePluginDefinedGatewayCommand,
} from './gateway-plugin-service.js';
import { interruptGatewaySessionExecution } from './gateway-request-runtime.js';
import { readSessionStatusSnapshot } from './gateway-session-status.js';
import {
  formatDisplayTimestamp,
  formatRelativeTime,
  parseTimestamp,
} from './gateway-time.js';
import {
  type GatewayAdminAuditResponse,
  type GatewayAdminChannelsResponse,
  type GatewayAdminChannelUpsertRequest,
  type GatewayAdminConfigResponse,
  type GatewayAdminDeleteSessionResult,
  type GatewayAdminJobsContextResponse,
  type GatewayAdminMcpResponse,
  type GatewayAdminModelsResponse,
  type GatewayAdminModelUsageRow,
  type GatewayAdminOverview,
  type GatewayAdminSession,
  type GatewayAdminSkillsResponse,
  type GatewayAdminToolCatalogEntry,
  type GatewayAdminToolsResponse,
  type GatewayAdminUsageSummary,
  type GatewayAgentsResponse,
  type GatewayAssistantPresentation,
  type GatewayChatRequest,
  type GatewayChatResult,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayHistorySummary,
  type GatewayProviderHealthEntry,
  type GatewayRecentChatSession,
  type GatewayStatus,
  renderGatewayCommand,
} from './gateway-types.js';
import {
  firstNumber,
  numberFromUnknown,
  parseAuditPayload,
  resolveWorkspaceRelativePath,
} from './gateway-utils.js';
import { isDiscordChannelId } from './proactive-delivery.js';
import { buildResetConfirmationComponents } from './reset-confirmation.js';
import {
  describeSessionShowMode,
  isSessionShowMode,
  normalizeSessionShowMode,
} from './show-mode.js';

const BOT_CACHE_TTL = 300_000; // 5 minutes
const TRACE_EXPORT_ALL_SESSION_LIMIT = 1_000;
const TRACE_EXPORT_ALL_CONCURRENCY = 4;
const MAX_HISTORY_MESSAGES = 40;
const BOOTSTRAP_AUTOSTART_MARKER_KEY = 'gateway.bootstrap_autostart.v1';
const BOOTSTRAP_AUTOSTART_SOURCE = 'gateway.bootstrap';
const activeBootstrapAutostartSessions = new Set<string>();
const assistantPresentationImagePathCache = new Map<string, string | null>();
function buildBootstrapAutostartPrompt(
  fileName: 'BOOTSTRAP.md' | 'OPENING.md',
): string {
  return [
    `A startup instruction file (${fileName}) exists for this agent.`,
    'This is an internal kickoff turn, not a user-authored message.',
    `Follow the ${fileName} instructions now and begin the conversation proactively.`,
    'Send a concise first message to the user.',
    `Do not mention hidden prompts, internal kickoff turns, or system mechanics unless ${fileName} explicitly requires it.`,
  ].join(' ');
}
const REQUEST_LOG_SENSITIVE_KEY_RE =
  /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|session)/i;
const REQUEST_LOG_INLINE_SECRET_RE =
  /\b(pass(?:word)?|secret|token|api(?:[_ -]?key)?|authorization|cookie|credential)\b(\s*[:=]\s*)([^\n\r,;]+)|([?&](?:token|signature|x-amz-[^=]*))=([^&\s]+)/gi;
const ALWAYS_REDACT_TOOL_FIELDS: Record<string, ReadonlySet<string>> = {
  browser_type: new Set(['text']),
};
const GATEWAY_REQUEST_LOG_ENABLED_VALUE = '1';
let lastWarnedGatewayRequestLoggingValue: string | null = null;

export function isGatewayRequestLoggingEnabled(): boolean {
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

export function readSystemPromptMessage(
  messages: ChatMessage[],
): string | null {
  const firstMessage = messages[0];
  if (!firstMessage || firstMessage.role !== 'system') return null;
  return typeof firstMessage.content === 'string' && firstMessage.content.trim()
    ? firstMessage.content
    : null;
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

export function maybeRecordGatewayRequestLog(params: {
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
  'http_request',
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
const IMAGE_QUESTION_RE =
  /(what(?:'s| is)? on (?:the )?(?:image|picture|photo|screenshot)|describe (?:this|the) (?:image|picture|photo)|image|picture|photo|screenshot|ocr|diagram|chart|grafik|bild|foto|was steht|was ist auf dem bild)/i;
const BROWSER_TAB_RE =
  /(browser|tab|current tab|web page|website|seite im browser|aktuellen tab)/i;
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

export function shouldForceNewTuiSession(
  req: Pick<
    GatewayChatRequest | GatewayCommandRequest,
    'channelId' | 'sessionMode'
  >,
): boolean {
  return req.channelId === 'tui' && req.sessionMode === 'new';
}

export function resolveChannelType(
  req: Pick<GatewayChatRequest, 'channelId' | 'source'>,
): string | undefined {
  const source = String(req.source || '')
    .trim()
    .toLowerCase();
  if (
    source === 'discord' ||
    source === 'imessage' ||
    source === 'whatsapp' ||
    source === 'email' ||
    source === 'msteams'
  ) {
    return source;
  }
  const inferredChannelType = resolveSessionResetChannelKind(req.channelId);
  if (
    inferredChannelType === 'discord' ||
    inferredChannelType === 'imessage' ||
    inferredChannelType === 'whatsapp' ||
    inferredChannelType === 'email'
  ) {
    return inferredChannelType;
  }
  return source && source !== 'unknown' ? source : undefined;
}

export function resolveSessionAutoResetPolicy(
  channelId: string,
): SessionResetPolicy {
  return resolveResetPolicy({
    channelKind: resolveSessionResetChannelKind(channelId),
    config: getRuntimeConfig(),
  });
}

export function resolveCanonicalContextScope(
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

function buildHybridAIProviderEntry(
  probe: HybridAIHealthResult,
  runtimeConfig: RuntimeConfig,
): GatewayProviderHealthEntry {
  const configModelCount = dedupeStrings([
    runtimeConfig.hybridai.defaultModel,
    ...runtimeConfig.hybridai.models,
    ...getDiscoveredHybridAIModelNames(),
  ]).length;

  return {
    kind: 'remote',
    reachable: probe.reachable,
    ...(probe.error ? { error: probe.error } : {}),
    latencyMs: probe.latencyMs,
    modelCount: probe.modelCount ?? configModelCount,
    detail: probe.reachable
      ? `${probe.latencyMs}ms`
      : probe.error || 'unreachable',
  };
}

function buildGatewayProviderHealth(params: {
  localBackends: GatewayStatus['localBackends'];
  codex: ReturnType<typeof getCodexAuthStatus>;
  hybridaiHealth: HybridAIHealthResult;
}): NonNullable<GatewayStatus['providerHealth']> {
  const runtimeConfig = getRuntimeConfig();
  const providerHealth: NonNullable<GatewayStatus['providerHealth']> = {
    hybridai: buildHybridAIProviderEntry(params.hybridaiHealth, runtimeConfig),
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

function isOpenRouterAvailableForModelCommands(): boolean {
  const runtimeConfig = getRuntimeConfig();
  return (
    runtimeConfig.openrouter.enabled &&
    Boolean(readOpenRouterApiKey({ required: false }))
  );
}

function isHuggingFaceAvailableForModelCommands(): boolean {
  const runtimeConfig = getRuntimeConfig();
  return (
    runtimeConfig.huggingface.enabled &&
    Boolean(readHuggingFaceApiKey({ required: false }))
  );
}

function isMistralAvailableForModelCommands(): boolean {
  const runtimeConfig = getRuntimeConfig();
  return (
    runtimeConfig.mistral.enabled &&
    Boolean(readMistralApiKey({ required: false }))
  );
}

function isModelAvailableForCurrentGatewayState(
  model: string,
  providerHealth: GatewayStatus['providerHealth'],
): boolean {
  switch (resolveModelProvider(model)) {
    case 'hybridai':
      return providerHealth?.hybridai?.reachable === true;
    case 'openai-codex':
      return providerHealth?.codex?.reachable === true;
    case 'openrouter':
      return isOpenRouterAvailableForModelCommands();
    case 'mistral':
      return isMistralAvailableForModelCommands();
    case 'huggingface':
      return isHuggingFaceAvailableForModelCommands();
    case 'ollama':
      return providerHealth?.ollama?.reachable === true;
    case 'lmstudio':
      return providerHealth?.lmstudio?.reachable === true;
    case 'llamacpp':
      return providerHealth?.llamacpp?.reachable === true;
    case 'vllm':
      return providerHealth?.vllm?.reachable === true;
    default:
      return true;
  }
}

function filterModelsForCurrentGatewayState(
  models: string[],
  providerHealth: GatewayStatus['providerHealth'],
): string[] {
  return models.filter((model) =>
    isModelAvailableForCurrentGatewayState(model, providerHealth),
  );
}

async function getGatewayStatusForModelSubcommand(
  subcommand: string | undefined,
): Promise<GatewayStatus> {
  if (subcommand === 'list' || subcommand === 'info') {
    // These commands are expected to reflect the current live provider state,
    // not a recently cached health snapshot.
    localBackendsProbe.invalidate();
    hybridAIProbe.invalidate();
  }
  return await getGatewayStatus();
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

function resolveKnownModelContextWindow(model: string): number | null {
  return (
    resolveLocalModelContextWindow(model) ??
    getDiscoveredHuggingFaceModelContextWindow(model) ??
    getDiscoveredHybridAIModelContextWindow(model) ??
    getDiscoveredMistralModelContextWindow(model) ??
    getDiscoveredOpenRouterModelContextWindow(model) ??
    resolveModelContextWindowFallback(model)
  );
}

function resolveDisplayedModelName(model: string): string {
  const normalized = String(model || '').trim();
  if (!normalized) return normalized;
  if (normalized.toLowerCase().startsWith('mistral/')) {
    return resolveDiscoveredMistralModelCanonicalName(normalized);
  }
  return normalized;
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

export function normalizeMediaContextItems(raw: unknown): MediaContextItem[] {
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

export function cloneMediaContextItems(
  media: MediaContextItem[],
): MediaContextItem[] {
  return media.map((item) => ({ ...item }));
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

function buildVisibleMediaSummary(media: MediaContextItem[]): string {
  if (media.length === 0) return '';
  const summary = summarizeMediaFilenames(media.map((item) => item.filename));
  return media.length === 1
    ? `Attached file: ${summary}`
    : `Attached files: ${summary}`;
}

export function buildStoredUserTurnContent(
  userContent: string,
  media: MediaContextItem[],
): string {
  const text = String(userContent || '').trim();
  const mediaSummary = buildVisibleMediaSummary(media);
  if (!mediaSummary) return text;
  if (text === mediaSummary || text.endsWith(`\n\n${mediaSummary}`)) {
    return text;
  }
  return text ? `${text}\n\n${mediaSummary}` : mediaSummary;
}

export function buildMediaPromptContext(media: MediaContextItem[]): string {
  if (media.length === 0) return '';
  const mediaPaths = media
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));
  const imagePaths = media
    .filter((item) => isImageMediaItem(item) && item.path)
    .map((item) => item.path as string);
  const audioPaths = media
    .filter((item) => isAudioMediaItem(item) && item.path)
    .map((item) => item.path as string);
  const documentPaths = media
    .filter(
      (item) => !isImageMediaItem(item) && !isAudioMediaItem(item) && item.path,
    )
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
    `AudioMediaPaths: ${JSON.stringify(audioPaths)}`,
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

function formatHybridAIAccountChatbotResolutionError(error: unknown): string {
  const keyHint = `Update \`HYBRIDAI_API_KEY\` in ${runtimeSecretsPath()} or in the shell that starts HybridClaw, then restart the gateway. You can also run \`hybridclaw auth login hybridai\` to store a new key.`;
  const reachabilityHint =
    'Check `hybridai.baseUrl` and confirm the HybridAI service is running.';
  const failure = describeHybridAIBotFetchFailure(error);

  if (failure.kind === 'missing_credentials') {
    return `HybridAI chatbot fallback requires HybridAI API credentials. ${keyHint}`;
  }
  if (failure.kind === 'auth') {
    return `HybridAI rejected the configured API key: ${failure.message}. ${keyHint}`;
  }
  if (failure.kind === 'tls' || failure.kind === 'network') {
    return formatHybridAIBotReachabilityError(failure.kind, reachabilityHint);
  }
  return `Failed to resolve the HybridAI account chatbot id: ${failure.message}`;
}

export async function resolveGatewayChatbotId(params: {
  model: string;
  chatbotId: string;
  sessionId: string;
  channelId: string;
  agentId: string;
  trigger: 'bootstrap' | 'chat' | 'scheduler';
  taskId?: string | number | null;
}): Promise<{
  chatbotId: string;
  source: 'configured' | 'hybridai-account' | 'missing';
  error?: string;
}> {
  const configuredChatbotId = String(params.chatbotId || '').trim();
  if (configuredChatbotId) {
    return { chatbotId: configuredChatbotId, source: 'configured' };
  }
  if (!modelRequiresChatbotId(params.model)) {
    return { chatbotId: '', source: 'missing' };
  }

  try {
    const fallbackChatbotId = await fetchHybridAIAccountChatbotId({
      cacheTtlMs: BOT_CACHE_TTL,
    });
    updateSessionChatbot(params.sessionId, fallbackChatbotId);
    logger.info(
      {
        sessionId: params.sessionId,
        channelId: params.channelId,
        agentId: params.agentId,
        model: params.model,
        trigger: params.trigger,
        taskId: params.taskId ?? null,
        fallbackChatbotId,
      },
      'Resolved HybridAI chatbot ID from /bot-management/me fallback',
    );
    return {
      chatbotId: fallbackChatbotId,
      source: 'hybridai-account',
    };
  } catch (error) {
    const formattedError = formatHybridAIAccountChatbotResolutionError(error);
    logger.warn(
      {
        sessionId: params.sessionId,
        channelId: params.channelId,
        agentId: params.agentId,
        model: params.model,
        trigger: params.trigger,
        taskId: params.taskId ?? null,
        err: error,
      },
      'Failed to resolve HybridAI chatbot ID from /bot-management/me fallback',
    );
    return {
      chatbotId: '',
      source: 'missing',
      error: `No chatbot configured. ${formattedError}`,
    };
  }
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
  return resolveDefaultAgentId(getRuntimeConfig());
}

type TraceExportResult = Awaited<
  ReturnType<typeof exportSessionTraceAtifJsonl>
>;

async function exportTraceForSession(
  session: Session,
): Promise<TraceExportResult> {
  return exportSessionTraceAtifJsonl({
    agentId: resolveSessionAgentId(session),
    session,
    messages: memoryService.getRecentMessages(session.id),
    auditEntries: getStructuredAuditForSession(session.id),
    usageTotals: getSessionUsageTotals(session.id),
  });
}

async function exportTraceForSessions(
  sessions: Session[],
): Promise<Exclude<TraceExportResult, null>[]> {
  const exported: Exclude<TraceExportResult, null>[] = [];
  for (
    let index = 0;
    index < sessions.length;
    index += TRACE_EXPORT_ALL_CONCURRENCY
  ) {
    const batch = sessions.slice(index, index + TRACE_EXPORT_ALL_CONCURRENCY);
    const results = await Promise.all(
      batch.map((session) => exportTraceForSession(session)),
    );
    exported.push(
      ...results.filter(
        (result): result is Exclude<TraceExportResult, null> => result != null,
      ),
    );
  }
  return exported;
}

function resolveAgentImageAssetPath(
  agentId: string,
  imageAsset: string | null | undefined,
): string | null {
  const normalized = String(imageAsset || '').trim();
  if (!normalized) return null;
  const workspaceDir = agentWorkspaceDir(agentId);
  const cacheKey = `${workspaceDir}\u0000${normalized}`;
  if (assistantPresentationImagePathCache.has(cacheKey)) {
    return assistantPresentationImagePathCache.get(cacheKey) || null;
  }
  const resolved = resolveWorkspaceRelativePath(workspaceDir, normalized);
  assistantPresentationImagePathCache.set(cacheKey, resolved);
  return resolved;
}

export function getGatewayAssistantPresentationForAgent(
  agentId?: string | null,
): GatewayAssistantPresentation {
  const resolvedAgentId = String(agentId || '').trim() || DEFAULT_AGENT_ID;
  const agent =
    getAgentById(resolvedAgentId) ?? resolveAgentConfig(resolvedAgentId);
  const displayName =
    agent.displayName?.trim() || agent.name?.trim() || resolvedAgentId;
  const imagePath = resolveAgentImageAssetPath(
    resolvedAgentId,
    agent.imageAsset,
  );
  return {
    agentId: resolvedAgentId,
    displayName,
    ...(imagePath
      ? {
          imageUrl: `/api/agent-avatar?agentId=${encodeURIComponent(resolvedAgentId)}`,
        }
      : {}),
  };
}

export function getGatewayAssistantPresentationForSession(
  sessionId: string,
): GatewayAssistantPresentation {
  const session = memoryService.getSessionById(sessionId);
  return getGatewayAssistantPresentationForAgent(
    session ? resolveSessionAgentId(session) : DEFAULT_AGENT_ID,
  );
}

export function extractUsageCostUsd(tokenUsage?: TokenUsageStats): number {
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

function buildHybridAIAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const status = getHybridAIAuthStatus();
  return [
    `Authenticated: ${status.authenticated ? 'yes' : 'no'}`,
    ...(status.authenticated
      ? [`Source: ${status.source}`, `API key: ${status.maskedApiKey}`]
      : []),
    `Config: ${runtimeConfigPath()}`,
    `Base URL: ${config.hybridai.baseUrl}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
    'Billing: unavailable from this status command',
  ];
}

type GatewayAuthStatusProvider =
  | 'hybridai'
  | 'codex'
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
  | 'local'
  | 'msteams';

function normalizeGatewayAuthStatusProvider(
  rawProvider: string | undefined,
): GatewayAuthStatusProvider | null {
  const normalized = String(rawProvider || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    normalized === 'hybridai' ||
    normalized === 'hybrid-ai' ||
    normalized === 'hybrid'
  ) {
    return 'hybridai';
  }
  if (normalized === 'codex' || normalized === 'openai-codex') {
    return 'codex';
  }
  if (normalized === 'openrouter' || normalized === 'or') {
    return 'openrouter';
  }
  if (normalized === 'mistral') {
    return 'mistral';
  }
  if (
    normalized === 'huggingface' ||
    normalized === 'hf' ||
    normalized === 'hugging-face' ||
    normalized === 'huggingface-hub'
  ) {
    return 'huggingface';
  }
  if (normalized === 'local') {
    return 'local';
  }
  if (
    normalized === 'msteams' ||
    normalized === 'teams' ||
    normalized === 'ms-teams'
  ) {
    return 'msteams';
  }
  return null;
}

function maskGatewaySecret(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '***';
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}…${normalized.slice(-1)}`;
  }
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

function resolveRuntimeCredentialStatus(
  storedSecretName: string,
  envValues: Array<string | undefined>,
): {
  value: string;
  source: 'env' | 'runtime-secrets' | null;
} {
  const storedValue = readStoredRuntimeSecret(storedSecretName);
  const envValue =
    envValues
      .map((value) => String(value || '').trim())
      .find((value) => value.length > 0) || '';
  const source = envValue
    ? storedValue && envValue === storedValue
      ? 'runtime-secrets'
      : 'env'
    : storedValue
      ? 'runtime-secrets'
      : null;
  return {
    value: envValue || storedValue || '',
    source,
  };
}

function buildOpenRouterAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const credential = resolveRuntimeCredentialStatus('OPENROUTER_API_KEY', [
    process.env.OPENROUTER_API_KEY,
  ]);
  return [
    `Authenticated: ${credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value
      ? [`API key: ${maskGatewaySecret(credential.value)}`]
      : []),
    `Config: ${runtimeConfigPath()}`,
    `Enabled: ${config.openrouter.enabled ? 'yes' : 'no'}`,
    `Base URL: ${config.openrouter.baseUrl}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
    `Models: ${config.openrouter.models.length > 0 ? config.openrouter.models.join(', ') : '(none configured)'}`,
  ];
}

function buildMistralAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const credential = resolveRuntimeCredentialStatus('MISTRAL_API_KEY', [
    process.env.MISTRAL_API_KEY,
  ]);
  return [
    `Authenticated: ${credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value
      ? [`API key: ${maskGatewaySecret(credential.value)}`]
      : []),
    `Config: ${runtimeConfigPath()}`,
    `Enabled: ${config.mistral.enabled ? 'yes' : 'no'}`,
    `Base URL: ${config.mistral.baseUrl}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
    `Models: ${config.mistral.models.length > 0 ? config.mistral.models.join(', ') : '(none configured)'}`,
  ];
}

function buildHuggingFaceAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const credential = resolveRuntimeCredentialStatus('HF_TOKEN', [
    process.env.HF_TOKEN,
    process.env.HUGGINGFACE_API_KEY,
  ]);
  return [
    `Authenticated: ${credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value
      ? [`API key: ${maskGatewaySecret(credential.value)}`]
      : []),
    `Config: ${runtimeConfigPath()}`,
    `Enabled: ${config.huggingface.enabled ? 'yes' : 'no'}`,
    `Base URL: ${config.huggingface.baseUrl}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
    `Models: ${config.huggingface.models.length > 0 ? config.huggingface.models.join(', ') : '(none configured)'}`,
  ];
}

function buildCodexAuthStatusLines(): string[] {
  const status = getCodexAuthStatus();
  return [
    `Authenticated: ${status.authenticated ? 'yes' : 'no'}`,
    `Relogin required: ${status.reloginRequired ? 'yes' : 'no'}`,
    ...(status.authenticated
      ? [
          `Source: ${status.source}`,
          `Account: ${status.accountId}`,
          `Access token: ${status.maskedAccessToken}`,
          `Expires: ${status.expiresAt ? new Date(status.expiresAt).toISOString() : 'unknown'}`,
        ]
      : []),
    `Config: ${runtimeConfigPath()}`,
  ];
}

function buildLocalAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const lines = [
    `Config: ${runtimeConfigPath()}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
  ];
  for (const [backend, settings] of Object.entries(config.local.backends)) {
    lines.push(
      `${backend}: ${settings.enabled ? 'enabled' : 'disabled'} (${settings.baseUrl})`,
    );
    if (backend === 'vllm') {
      lines.push(`vllm api key: ${settings.apiKey ? 'configured' : 'not set'}`);
    }
  }
  return lines;
}

function buildMSTeamsAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const credential = resolveRuntimeCredentialStatus('MSTEAMS_APP_PASSWORD', [
    process.env.MSTEAMS_APP_PASSWORD,
  ]);
  const appId =
    String(process.env.MSTEAMS_APP_ID || '').trim() || config.msteams.appId;
  const tenantId =
    String(process.env.MSTEAMS_TENANT_ID || '').trim() ||
    config.msteams.tenantId;
  return [
    `Authenticated: ${appId && credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value
      ? [`App password: ${maskGatewaySecret(credential.value)}`]
      : []),
    `Config: ${runtimeConfigPath()}`,
    `Enabled: ${config.msteams.enabled ? 'yes' : 'no'}`,
    `App ID: ${appId || '(not set)'}`,
    `Tenant ID: ${tenantId || '(not set)'}`,
    `Webhook path: ${config.msteams.webhook.path}`,
    `DM policy: ${config.msteams.dmPolicy}`,
    `Group policy: ${config.msteams.groupPolicy}`,
  ];
}

function buildGatewayAuthStatusResponse(provider: GatewayAuthStatusProvider): {
  title: string;
  lines: string[];
} {
  switch (provider) {
    case 'hybridai':
      return {
        title: 'HybridAI Auth Status',
        lines: buildHybridAIAuthStatusLines(),
      };
    case 'codex':
      return {
        title: 'Codex Auth Status',
        lines: buildCodexAuthStatusLines(),
      };
    case 'openrouter':
      return {
        title: 'OpenRouter Auth Status',
        lines: buildOpenRouterAuthStatusLines(),
      };
    case 'mistral':
      return {
        title: 'Mistral Auth Status',
        lines: buildMistralAuthStatusLines(),
      };
    case 'huggingface':
      return {
        title: 'Hugging Face Auth Status',
        lines: buildHuggingFaceAuthStatusLines(),
      };
    case 'local':
      return {
        title: 'Local Auth Status',
        lines: buildLocalAuthStatusLines(),
      };
    case 'msteams':
      return {
        title: 'Microsoft Teams Auth Status',
        lines: buildMSTeamsAuthStatusLines(),
      };
  }
}

function buildProviderEnableCommand(
  provider: 'openrouter' | 'mistral' | 'huggingface',
): string {
  return `config set ${provider}.enabled true`;
}

function buildModelListProviderSetupMessage(
  providerArg: string,
): string | null {
  const provider = normalizeModelCatalogProviderFilter(providerArg);
  const config = getRuntimeConfig();
  switch (provider) {
    case 'hybridai': {
      if (getHybridAIAuthStatus().authenticated) return null;
      return [
        'HybridAI is not authorized.',
        'Authorize it first from a terminal:',
        '  hybridclaw auth login hybridai',
        'Then rerun `model list hybridai`.',
      ].join('\n');
    }
    case 'openai-codex': {
      const status = getCodexAuthStatus();
      if (status.authenticated && !status.reloginRequired) return null;
      return [
        status.reloginRequired
          ? 'Codex authorization expired.'
          : 'Codex is not authorized.',
        'Authorize it first from a terminal:',
        '  hybridclaw auth login codex',
        'Then rerun `model list codex`.',
      ].join('\n');
    }
    case 'openrouter': {
      const authorized = Boolean(readOpenRouterApiKey({ required: false }));
      if (authorized && config.openrouter.enabled) return null;
      return [
        !authorized
          ? 'OpenRouter is not authorized.'
          : 'OpenRouter is disabled.',
        ...(!authorized
          ? [
              'Authorize it first from a terminal:',
              '  hybridclaw auth login openrouter',
            ]
          : []),
        ...(config.openrouter.enabled
          ? []
          : ['Enable it:', `  ${buildProviderEnableCommand('openrouter')}`]),
        'Then rerun `model list openrouter`.',
      ].join('\n');
    }
    case 'mistral': {
      const authorized = Boolean(readMistralApiKey({ required: false }));
      if (authorized && config.mistral.enabled) return null;
      return [
        !authorized ? 'Mistral is not authorized.' : 'Mistral is disabled.',
        ...(!authorized
          ? [
              'Authorize it first from a terminal:',
              '  hybridclaw auth login mistral',
            ]
          : []),
        ...(config.mistral.enabled
          ? []
          : ['Enable it:', `  ${buildProviderEnableCommand('mistral')}`]),
        'Then rerun `model list mistral`.',
      ].join('\n');
    }
    case 'huggingface': {
      const authorized = Boolean(readHuggingFaceApiKey({ required: false }));
      if (authorized && config.huggingface.enabled) return null;
      return [
        !authorized
          ? 'Hugging Face is not authorized.'
          : 'Hugging Face is disabled.',
        ...(!authorized
          ? [
              'Authorize it first from a terminal:',
              '  hybridclaw auth login huggingface',
            ]
          : []),
        ...(config.huggingface.enabled
          ? []
          : ['Enable it:', `  ${buildProviderEnableCommand('huggingface')}`]),
        'Then rerun `model list huggingface`.',
      ].join('\n');
    }
    default:
      return null;
  }
}

export function formatCanonicalContextPrompt(params: {
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

export function formatPluginPromptContext(sections: string[]): string | null {
  const normalized = sections
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join('\n\n');
}

function formatSessionSnippetSummary(params: {
  firstMessage: string | null;
  lastMessage: string | null;
}): string {
  const summary = buildSessionBoundaryPreview({
    firstMessage: params.firstMessage,
    lastMessage: params.lastMessage,
    maxLength: SESSIONS_COMMAND_SNIPPET_MAX_LENGTH,
  });
  return summary ? ` · ${summary}` : '';
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

export function isVersionOnlyQuestion(raw: string): boolean {
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

export function recordSuccessfulTurn(opts: {
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
}): {
  userMessageId: number;
  assistantMessageId: number;
} {
  const storedTurn = memoryService.storeTurn({
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

  return storedTurn;
}

export function buildStoredTurnMessages(params: {
  sessionId: string;
  userId: string;
  username: string | null;
  userContent: string;
  resultText: string;
}): StoredMessage[] {
  const timestamp = new Date().toISOString();
  return [
    {
      id: 0,
      session_id: params.sessionId,
      user_id: params.userId,
      username: params.username,
      role: 'user',
      content: params.userContent,
      created_at: timestamp,
    },
    {
      id: 0,
      session_id: params.sessionId,
      user_id: 'assistant',
      username: null,
      role: 'assistant',
      content: params.resultText,
      created_at: timestamp,
    },
  ];
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

function normalizeUrlPrefix(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('URL prefix is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL prefix: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL prefix protocol: ${parsed.protocol}`);
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const pathname = parsed.pathname || '/';
  parsed.pathname = `${pathname.replace(/\/+$/, '') || ''}/`;
  return parsed.toString();
}

function normalizeSecretRouteHeader(raw: string | undefined): string {
  const header = String(raw || 'Authorization').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(header)) {
    throw new Error(`Invalid header name: ${header}`);
  }
  return header;
}

function normalizeSecretRoutePrefix(raw: string | undefined): string {
  const normalized = String(raw || 'Bearer').trim();
  if (!normalized || normalized.toLowerCase() === 'none') {
    return '';
  }
  return normalized;
}

function formatHttpRequestAuthRule(
  rule: RuntimeHttpRequestAuthRule,
  index: number,
): string {
  const parsedSecret =
    typeof rule.secret === 'string'
      ? rule.secret
      : typeof rule.secret.id === 'string'
        ? `${rule.secret.source}:${rule.secret.id}`
        : '<invalid>';
  const prefix = rule.prefix ? ` ${rule.prefix}` : '';
  return `${index + 1}. ${rule.urlPrefix} -> ${rule.header}:${prefix} ${parsedSecret}`.trim();
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

export function buildTokenUsageAuditPayload(
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

export async function getGatewayStatus(): Promise<GatewayStatus> {
  const [localBackendsResult, hybridaiResult] = await Promise.allSettled([
    localBackendsProbe.get(),
    hybridAIProbe.get(),
  ]);
  const localBackendsMap =
    localBackendsResult.status === 'fulfilled'
      ? localBackendsResult.value
      : new Map();
  const hybridaiHealth: HybridAIHealthResult =
    hybridaiResult.status === 'fulfilled'
      ? hybridaiResult.value
      : { reachable: false, error: 'probe failed', latencyMs: 0 };
  const sandbox = getSandboxDiagnostics();
  const codex = getCodexAuthStatus();
  const localBackends = Object.fromEntries(
    [...localBackendsMap.entries()].map(([backend, status]) => [
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
    hybridaiHealth,
  });
  return {
    status: 'ok',
    webAuthConfigured: Boolean(WEB_API_TOKEN),
    pid: process.pid,
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    sessions: getSessionCount(),
    activeContainers: sandbox.activeSessions,
    defaultAgentId: resolveDefaultAgentId(getRuntimeConfig()),
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

export async function getGatewayAdminOverview(): Promise<GatewayAdminOverview> {
  return {
    status: await getGatewayStatus(),
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

export async function getGatewayAgents(): Promise<GatewayAgentsResponse> {
  const status = await getGatewayStatus();
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

export function getGatewayAdminJobsContext(): GatewayAdminJobsContextResponse {
  const activeSessionIds = new Set(getActiveExecutorSessionIds());
  const sandboxMode = getRuntimeConfig().container.sandboxMode || 'container';
  const sessions = getAllSessions()
    .map((session) =>
      mapSessionCard({
        session,
        activeSessionIds,
        usageBySession: new Map(),
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
    })
    .map((session) => ({
      sessionId: session.sessionId,
      agentId: session.agentId,
      startedAt: session.startedAt,
      lastActive: session.lastActive,
      status: session.status,
      lastAnswer: session.lastAnswer,
      output: session.output,
    }));

  const agentIds = Array.from(
    new Set([
      ...listAgents().map((agent) => agent.id),
      ...sessions.map((session) => session.agentId),
    ]),
  ).sort((left, right) => left.localeCompare(right));

  return {
    agents: agentIds.map((agentId) => {
      const agent = getAgentById(agentId) ?? resolveAgentConfig(agentId);
      return {
        id: agent.id,
        name: agent.name || null,
      };
    }),
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
  const status = await getGatewayStatus();

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

function resolveBootstrapAutostartChannelId(
  sessionId: string,
  channelId?: string | null,
): string {
  const explicit = String(channelId || '').trim();
  if (explicit) return explicit;
  const parsed = parseSessionKey(sessionId);
  return String(parsed?.channelKind || '').trim() || 'web';
}

function normalizeBootstrapAutostartResult(
  output: Awaited<ReturnType<typeof runAgent>>,
): string {
  const normalized = normalizePlaceholderToolReply(
    normalizeSilentMessageSendReply({
      status: output.status,
      result: output.result,
      error: output.error,
      toolsUsed: output.toolsUsed || [],
      toolExecutions: output.toolExecutions || [],
    }),
  );
  return String(normalized.result || '').trim();
}

function resolveBootstrapAutostartContext(params: {
  sessionId: string;
  channelId?: string | null;
  agentId?: string | null;
}): {
  channelId: string;
  session: ReturnType<(typeof memoryService)['getOrCreateSession']>;
  resolved: ReturnType<typeof resolveAgentForRequest>;
  bootstrapFile: 'BOOTSTRAP.md' | 'OPENING.md';
} | null {
  const requestedSessionId = String(params.sessionId || '').trim();
  if (!requestedSessionId) return null;

  const channelId = resolveBootstrapAutostartChannelId(
    requestedSessionId,
    params.channelId,
  );
  const session = memoryService.getOrCreateSession(
    requestedSessionId,
    null,
    channelId,
    params.agentId ?? undefined,
  );
  if (
    session.message_count > 0 ||
    String(session.session_summary || '').trim().length > 0
  ) {
    return null;
  }

  const resolved = resolveAgentForRequest({
    agentId: params.agentId,
    session,
  });
  ensureBootstrapFiles(resolved.agentId);
  const bootstrapFile = resolveStartupBootstrapFile(resolved.agentId);
  if (!bootstrapFile) return null;

  return {
    channelId,
    session,
    resolved,
    bootstrapFile,
  };
}

export async function ensureGatewayBootstrapAutostart(params: {
  sessionId: string;
  channelId?: string | null;
  userId?: string | null;
  username?: string | null;
  agentId?: string | null;
}): Promise<void> {
  const context = resolveBootstrapAutostartContext(params);
  if (!context) return;
  const { channelId, session, resolved, bootstrapFile } = context;
  if (activeBootstrapAutostartSessions.has(session.id)) {
    return;
  }
  activeBootstrapAutostartSessions.add(session.id);

  try {
    if (getMemoryValue(session.id, BOOTSTRAP_AUTOSTART_MARKER_KEY)) {
      return;
    }
    setMemoryValue(session.id, BOOTSTRAP_AUTOSTART_MARKER_KEY, {
      status: 'started',
      fileName: bootstrapFile,
      at: new Date().toISOString(),
    });

    const startedAt = Date.now();
    const runId = makeAuditRunId('bootstrap');
    const normalizedUserId =
      String(params.userId || session.session_key || session.id).trim() ||
      session.id;
    const normalizedUsername =
      String(params.username || 'system').trim() || 'system';
    const sessionContext = buildSessionContext({
      source: {
        channelKind: channelId,
        chatId: channelId,
        chatType: channelId === 'tui' || channelId === 'web' ? 'dm' : 'system',
        userId: normalizedUserId,
        userName: normalizedUsername,
        guildId: null,
      },
      agentId: resolved.agentId,
      sessionId: session.id,
      sessionKey: session.session_key,
      mainSessionKey: session.main_session_key,
    });
    const workspacePath = path.resolve(agentWorkspaceDir(resolved.agentId));
    const enableRag = session.enable_rag === 1;
    const provider = resolveModelProvider(resolved.model);
    const turnIndex = Math.max(1, session.message_count + 1);

    recordAuditEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'session.start',
        userId: normalizedUserId,
        channel: channelId,
        cwd: workspacePath,
        model: resolved.model,
        source: BOOTSTRAP_AUTOSTART_SOURCE,
      },
    });
    recordAuditEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'turn.start',
        turnIndex,
        userInput: buildBootstrapAutostartPrompt(bootstrapFile),
        username: normalizedUsername,
        mediaCount: 0,
        source: BOOTSTRAP_AUTOSTART_SOURCE,
      },
    });

    const chatbotResolution = await resolveGatewayChatbotId({
      model: resolved.model,
      chatbotId: resolved.chatbotId,
      sessionId: session.id,
      channelId,
      agentId: resolved.agentId,
      trigger: 'bootstrap',
    });
    const chatbotId = chatbotResolution.chatbotId;

    if (modelRequiresChatbotId(resolved.model) && !chatbotId) {
      deleteMemoryValue(session.id, BOOTSTRAP_AUTOSTART_MARKER_KEY);
      const error =
        chatbotResolution.error ||
        'No chatbot configured. Set `hybridai.defaultChatbotId` in ~/.hybridclaw/config.json or select a bot for this session.';
      logger.warn(
        {
          sessionId: session.id,
          channelId,
          agentId: resolved.agentId,
          model: resolved.model,
          sessionChatbotId: session.chatbot_id ?? null,
          fallbackSource: chatbotResolution.source,
        },
        'Gateway bootstrap autostart blocked by missing chatbot configuration',
      );
      recordAuditEvent({
        sessionId: session.id,
        runId,
        event: {
          type: 'error',
          errorType: 'configuration',
          message: error,
          recoverable: true,
        },
      });
      recordAuditEvent({
        sessionId: session.id,
        runId,
        event: {
          type: 'turn.end',
          turnIndex,
          finishReason: 'error',
        },
      });
      recordAuditEvent({
        sessionId: session.id,
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
      return;
    }

    const { messages } = buildConversationContext({
      agentId: resolved.agentId,
      history: [],
      currentUserContent: buildBootstrapAutostartPrompt(bootstrapFile),
      extraSafetyText:
        'Bootstrap kickoff turn. Start the conversation proactively with a concise user-facing opening message.',
      runtimeInfo: {
        chatbotId,
        model: resolved.model,
        defaultModel: HYBRIDAI_MODEL,
        channelType: channelId,
        channelId,
        guildId: null,
        sessionContext,
        workspacePath,
      },
    });
    messages.push({
      role: 'user',
      content: buildBootstrapAutostartPrompt(bootstrapFile),
    });

    const { pluginManager } = await tryEnsurePluginManagerInitializedForGateway(
      {
        sessionId: session.id,
        channelId,
        agentId: resolved.agentId,
        surface: 'chat',
      },
    );
    if (pluginManager) {
      await pluginManager.notifySessionStart({
        sessionId: session.id,
        userId: normalizedUserId,
        agentId: resolved.agentId,
        channelId,
      });
      await pluginManager.notifyBeforeAgentStart({
        sessionId: session.id,
        userId: normalizedUserId,
        agentId: resolved.agentId,
        channelId,
        model: resolved.model || undefined,
      });
    }

    recordAuditEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'agent.start',
        provider,
        model: resolved.model,
        scheduledTaskCount: 0,
        promptMessages: messages.length,
        systemPrompt: readSystemPromptMessage(messages),
      },
    });

    const output = await runAgent({
      sessionId: session.id,
      messages,
      chatbotId,
      enableRag,
      model: resolved.model,
      agentId: resolved.agentId,
      channelId,
      ralphMaxIterations: resolveSessionRalphIterations(session),
      fullAutoEnabled: isFullAutoEnabled(session),
      fullAutoNeverApproveTools: FULLAUTO_NEVER_APPROVE_TOOLS,
      scheduledTasks: [],
      pluginTools: pluginManager?.getToolDefinitions() ?? [],
    });
    const resultText =
      output.status === 'success'
        ? normalizeBootstrapAutostartResult(output)
        : '';

    const usagePayload = buildTokenUsageAuditPayload(
      messages,
      output.result,
      output.tokenUsage,
    );
    recordAuditEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'model.usage',
        provider,
        model: resolved.model,
        durationMs: Date.now() - startedAt,
        toolCallCount: (output.toolExecutions || []).length,
        ...usagePayload,
      },
    });
    recordUsageEvent({
      sessionId: session.id,
      agentId: resolved.agentId,
      model: resolved.model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      toolCalls: (output.toolExecutions || []).length,
      costUsd: extractUsageCostUsd(output.tokenUsage),
    });

    if (output.status !== 'success' || !resultText) {
      deleteMemoryValue(session.id, BOOTSTRAP_AUTOSTART_MARKER_KEY);
      recordAuditEvent({
        sessionId: session.id,
        runId,
        event: {
          type: 'turn.end',
          turnIndex,
          finishReason: output.status === 'success' ? 'empty' : 'error',
        },
      });
      recordAuditEvent({
        sessionId: session.id,
        runId,
        event: {
          type: 'session.end',
          reason: output.status === 'success' ? 'empty' : 'error',
          stats: {
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: (output.toolExecutions || []).length,
            durationMs: Date.now() - startedAt,
          },
        },
      });
      return;
    }

    const assistantMessageId = memoryService.storeMessage({
      sessionId: session.id,
      userId: 'assistant',
      username: null,
      role: 'assistant',
      content: resultText,
    });
    appendSessionTranscript(resolved.agentId, {
      sessionId: session.id,
      channelId,
      role: 'assistant',
      userId: 'assistant',
      username: null,
      content: resultText,
    });
    setMemoryValue(session.id, BOOTSTRAP_AUTOSTART_MARKER_KEY, {
      status: 'completed',
      assistantMessageId,
      completedAt: new Date().toISOString(),
    });
    recordAuditEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'completed',
      },
    });
    recordAuditEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'session.end',
        reason: 'normal',
        stats: {
          userMessages: 0,
          assistantMessages: 1,
          toolCalls: (output.toolExecutions || []).length,
          durationMs: Date.now() - startedAt,
        },
      },
    });
  } catch (error) {
    deleteMemoryValue(session.id, BOOTSTRAP_AUTOSTART_MARKER_KEY);
    logger.warn(
      { sessionId: session.id, agentId: resolved.agentId, channelId, error },
      'Failed to run bootstrap autostart turn',
    );
  } finally {
    activeBootstrapAutostartSessions.delete(session.id);
  }
}

export function getGatewayBootstrapAutostartState(params: {
  sessionId: string;
  channelId?: string | null;
  agentId?: string | null;
}): {
  status: 'idle' | 'starting' | 'completed';
  fileName: 'BOOTSTRAP.md' | 'OPENING.md';
} | null {
  const context = resolveBootstrapAutostartContext(params);
  if (!context) return null;
  const { session, bootstrapFile } = context;

  const marker = getMemoryValue(session.id, BOOTSTRAP_AUTOSTART_MARKER_KEY) as {
    status?: unknown;
    fileName?: unknown;
  } | null;
  const markerStatus =
    typeof marker?.status === 'string'
      ? marker.status.trim().toLowerCase()
      : '';

  return {
    status:
      markerStatus === 'started'
        ? 'starting'
        : markerStatus === 'completed'
          ? 'completed'
          : 'idle',
    fileName:
      marker?.fileName === 'BOOTSTRAP.md' || marker?.fileName === 'OPENING.md'
        ? marker.fileName
        : bootstrapFile,
  };
}

export function getGatewayHistory(
  sessionId: string,
  limit = MAX_HISTORY_MESSAGES,
): ConversationHistoryPage {
  const page = memoryService.getConversationHistoryPage(
    sessionId,
    Math.max(1, Math.min(limit, 200)),
  );
  const history = page.history
    .filter((message) => {
      if (message.role !== 'assistant') return true;
      return !isSilentReply(message.content);
    })
    .map((message) => {
      if (message.role !== 'assistant') return message;
      const content = stripSilentToken(message.content);
      return content === message.content
        ? message
        : {
            ...message,
            content,
          };
    })
    .filter((message) => message.content.trim().length > 0)
    .reverse();
  return {
    sessionKey: page.sessionKey,
    mainSessionKey: page.mainSessionKey,
    history,
    branchFamilies: page.branchFamilies,
  };
}

export function getGatewayRecentChatSessions(params: {
  userId: string;
  channelId?: string | null;
  limit?: number;
}): GatewayRecentChatSession[] {
  return getRecentSessionsForUser({
    userId: params.userId,
    channelId: params.channelId || 'web',
    limit: params.limit,
  });
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

export function extractDelegationDepth(sessionId: string): number {
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

export function normalizeDelegationEffect(
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

export function enqueueDelegationFromSideEffect(params: {
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

export async function prepareSessionAutoReset(params: {
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

export async function handleGatewayCommand(
  req: GatewayCommandRequest,
): Promise<GatewayCommandResult> {
  const { pluginManager, pluginInitError } =
    await tryEnsurePluginManagerInitializedForGateway({
      sessionId: req.sessionId,
      channelId: req.channelId,
      surface: 'command',
    });
  const cmd = (req.args[0] || '').toLowerCase();
  const sessionResetPolicy = resolveSessionAutoResetPolicy(req.channelId);
  const expiryEvaluation = await prepareSessionAutoReset({
    sessionId: req.sessionId,
    channelId: req.channelId,
    policy: sessionResetPolicy,
  });
  const autoResetSession = memoryService.resetSessionIfExpired(req.sessionId, {
    policy: sessionResetPolicy,
    expiryEvaluation,
  });
  if (autoResetSession) {
    const previousSessionId = req.sessionId;
    req.sessionId = autoResetSession.id;
    if (pluginManager) {
      await pluginManager.handleSessionReset({
        previousSessionId,
        sessionId: req.sessionId,
        userId: String(req.userId || ''),
        agentId: autoResetSession.agent_id || DEFAULT_AGENT_ID,
        channelId: req.channelId,
        reason: 'auto-reset',
      });
    }
  }
  let session = memoryService.getOrCreateSession(
    req.sessionId,
    req.guildId,
    req.channelId,
    undefined,
    { forceNewCurrent: shouldForceNewTuiSession(req) },
  );
  if (session.id !== req.sessionId) {
    req.sessionId = session.id;
  }
  const attachCommandSessionIdentity = (
    result: GatewayCommandResult,
  ): GatewayCommandResult => ({
    ...result,
    sessionId: req.sessionId,
    sessionKey: session.session_key,
    mainSessionKey: session.main_session_key,
  });

  function isLocalSession(req: GatewayCommandRequest): boolean {
    return (
      req.guildId === null &&
      (req.channelId === 'web' || req.channelId === 'tui')
    );
  }

  function formatRuntimeConfigJson(config: RuntimeConfig): string {
    return JSON.stringify(config, null, 2);
  }

  async function runRuntimeConfigCheck(): Promise<{
    severity: 'ok' | 'warn' | 'error';
    text: string;
  }> {
    const results = await checkConfigFile();
    const summary = summarizeCounts(results);
    const lines = results.map((result) => {
      const symbol =
        result.severity === 'ok' ? '✓' : result.severity === 'warn' ? '⚠' : '✖';
      return `${symbol} ${result.label}  ${result.message}`;
    });
    lines.push('');
    lines.push(
      `${summary.ok} ok · ${summary.warn} warning${summary.warn === 1 ? '' : 's'} · ${summary.error} error${summary.error === 1 ? '' : 's'}`,
    );
    return {
      severity: summary.error > 0 ? 'error' : summary.warn > 0 ? 'warn' : 'ok',
      text: lines.join('\n'),
    };
  }

  async function resolveValidatedRuntimeModelName(
    rawModelName: string,
  ): Promise<
    { ok: true; model: string } | { ok: false; result: GatewayCommandResult }
  > {
    const normalizedModelName = resolveDisplayedModelName(
      normalizeHybridAIModelForRuntime(rawModelName),
    );
    await refreshAvailableModelCatalogs({
      includeHybridAI: resolveModelProvider(normalizedModelName) === 'hybridai',
    });
    const catalogModels = getAvailableModelList();
    if (
      catalogModels.length > 0 &&
      !catalogModels.includes(normalizedModelName)
    ) {
      return {
        ok: false,
        result: badCommand(
          'Unknown Model',
          `\`${rawModelName}\` is not in the available models list.`,
        ),
      };
    }
    const gatewayStatus = await getGatewayStatusForModelSubcommand('set');
    const availableModels = filterModelsForCurrentGatewayState(
      catalogModels,
      gatewayStatus.providerHealth,
    );
    if (
      availableModels.length > 0 &&
      !availableModels.includes(normalizedModelName)
    ) {
      return {
        ok: false,
        result: badCommand(
          'Unknown Model',
          `\`${rawModelName}\` is not in the available models list.`,
        ),
      };
    }
    return { ok: true, model: normalizedModelName };
  }

  const result = await (async (): Promise<GatewayCommandResult> => {
    switch (cmd) {
      case 'help': {
        const helpEntries: Array<{
          command: string;
          description: string;
          scope: 'bare' | 'slash' | 'both';
        }> = [
          {
            command: 'agent',
            description: 'Show current session agent',
            scope: 'bare',
          },
          {
            command: 'agent list',
            description: 'List available agents',
            scope: 'bare',
          },
          {
            command: 'agent switch <id>',
            description: 'Bind this session to an existing agent',
            scope: 'bare',
          },
          {
            command: 'agent create <id> [--model <model>]',
            description: 'Create a new agent',
            scope: 'bare',
          },
          {
            command:
              'agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]',
            description: 'Install a packaged agent from a path or URL',
            scope: 'both',
          },
          {
            command: 'agent model [name]',
            description:
              'Show or set the persistent model for the current agent',
            scope: 'bare',
          },
          {
            command: 'bot list',
            description: 'List available bots',
            scope: 'bare',
          },
          {
            command: 'bot set <id|name>',
            description: 'Set chatbot for this session',
            scope: 'bare',
          },
          {
            command: 'bot clear',
            description: 'Clear the session chatbot and return to auto mode',
            scope: 'bare',
          },
          {
            command: 'bot info',
            description: 'Show current chatbot settings',
            scope: 'bare',
          },
          {
            command: 'concierge [info|on|off]',
            description: 'Show or toggle concierge routing defaults',
            scope: 'both',
          },
          {
            command: 'concierge model [name]',
            description: 'Show or set the concierge decision model',
            scope: 'both',
          },
          {
            command: 'concierge profile <asap|balanced|no_hurry> [model]',
            description: 'Show or set concierge profile model mappings',
            scope: 'both',
          },
          {
            command: 'model list [provider]',
            description: 'List available models',
            scope: 'both',
          },
          {
            command: 'model set <name>',
            description: 'Set model for this session',
            scope: 'both',
          },
          {
            command: 'model clear',
            description: 'Clear the session model override',
            scope: 'both',
          },
          {
            command: 'model default [name]',
            description: 'Show or set default model for new sessions',
            scope: 'both',
          },
          {
            command: 'model info',
            description: 'Show effective, session, agent, and default models',
            scope: 'both',
          },
          {
            command: 'rag [on|off]',
            description: 'Toggle or set RAG mode',
            scope: 'bare',
          },
          {
            command: 'channel mode [off|mention|free]',
            description: 'Set or inspect this Discord channel response mode',
            scope: 'bare',
          },
          {
            command: 'channel policy [open|allowlist|disabled]',
            description: 'Set or inspect guild channel policy',
            scope: 'bare',
          },
          {
            command: 'ralph [on|off|set <n>|info]',
            description: 'Configure Ralph loop (0 off, -1 unlimited)',
            scope: 'bare',
          },
          {
            command: 'fullauto [status|off|on [prompt]|<prompt>]',
            description: 'Enable/inspect/disable session full-auto mode',
            scope: 'bare',
          },
          {
            command: 'show [all|thinking|tools|none]',
            description:
              'Control visible thinking/tool activity for this session',
            scope: 'bare',
          },
          {
            command: 'show <all|thinking|tools|none>',
            description:
              'Control visible thinking/tool activity for this session',
            scope: 'slash',
          },
          {
            command: 'mcp list',
            description: 'List configured MCP servers',
            scope: 'bare',
          },
          {
            command: 'mcp add <name> <json>',
            description: 'Add or update an MCP server config',
            scope: 'bare',
          },
          {
            command: 'mcp remove <name>',
            description: 'Remove an MCP server config',
            scope: 'bare',
          },
          {
            command: 'mcp toggle <name>',
            description: 'Enable or disable an MCP server',
            scope: 'bare',
          },
          {
            command: 'mcp reconnect <name>',
            description:
              'Restart current session runtime so the server reconnects next turn',
            scope: 'bare',
          },
          {
            command: 'plugin list',
            description:
              'List discovered plugins, descriptions, commands, and load status',
            scope: 'both',
          },
          {
            command: 'plugin config <plugin-id> [key] [value|--unset]',
            description: 'Show or change a plugin config override',
            scope: 'both',
          },
          {
            command: 'plugin enable <plugin-id>',
            description: 'Enable a discovered plugin for future turns',
            scope: 'both',
          },
          {
            command: 'plugin disable <plugin-id>',
            description: 'Disable a discovered plugin for future turns',
            scope: 'both',
          },
          {
            command: 'plugin install <path|npm-spec>',
            description: 'Install a plugin from a local TUI/web session',
            scope: 'both',
          },
          {
            command: 'plugin reinstall <path|npm-spec>',
            description:
              'Replace an installed plugin from a local TUI/web session',
            scope: 'both',
          },
          {
            command: 'plugin reload',
            description:
              'Reload all plugins (picks up code changes without gateway restart)',
            scope: 'both',
          },
          {
            command: 'plugin uninstall <plugin-id>',
            description:
              'Remove a home-installed plugin and matching runtime config overrides',
            scope: 'both',
          },
          {
            command: 'auth status hybridai',
            description: 'Show local HybridAI auth/config state',
            scope: 'both',
          },
          {
            command: 'secret set <name> <value>',
            description:
              'Store an encrypted named secret for local gateway use',
            scope: 'both',
          },
          {
            command: 'secret list',
            description:
              'List stored secret names and configured URL auth rules',
            scope: 'both',
          },
          {
            command:
              'secret route add <url-prefix> <secret-name> [header] [prefix|none]',
            description:
              'Auto-inject a secret-backed header for matching outbound HTTP requests',
            scope: 'both',
          },
          {
            command: 'config',
            description: 'Show the local runtime config file',
            scope: 'both',
          },
          {
            command: 'config check',
            description: 'Validate the local runtime config file',
            scope: 'both',
          },
          {
            command: 'config reload',
            description:
              'Hot-reload the local runtime config file and validate it',
            scope: 'both',
          },
          {
            command: 'config set <key> <value>',
            description: 'Set one local runtime config value and validate it',
            scope: 'both',
          },
          {
            command: 'clear',
            description: 'Clear session history',
            scope: 'bare',
          },
          {
            command: 'reset [yes|no]',
            description:
              'Clear history, reset session settings, and remove the current agent workspace',
            scope: 'bare',
          },
          {
            command: 'compact',
            description:
              'Archive older history, summarize it, and retain recent context',
            scope: 'slash',
          },
          {
            command: 'status',
            description:
              'Show runtime status (Discord slash command, private to caller)',
            scope: 'slash',
          },
          {
            command: 'approve [view|yes|session|agent|no] [approval_id]',
            description: 'View/respond to pending approvals privately',
            scope: 'slash',
          },
          {
            command: 'stop',
            description:
              'Abort the current session run and disable full-auto mode',
            scope: 'bare',
          },
          {
            command: 'channel-mode <off|mention|free>',
            description: 'Set this Discord channel response mode',
            scope: 'slash',
          },
          {
            command: 'channel-policy <open|allowlist|disabled>',
            description: 'Set Discord guild channel policy',
            scope: 'slash',
          },
          {
            command: 'sessions',
            description: 'List active sessions',
            scope: 'bare',
          },
          {
            command:
              'usage [summary|daily|monthly|model [daily|monthly] [agentId]]',
            description: 'Usage/cost aggregates',
            scope: 'bare',
          },
          {
            command: 'export session [sessionId]',
            description: 'Export session JSONL snapshot for debugging',
            scope: 'bare',
          },
          {
            command: 'export trace [sessionId|all|--all]',
            description:
              'Export ATIF-compatible debug trace JSONL for a session',
            scope: 'bare',
          },
          {
            command: 'audit [sessionId]',
            description: 'Show recent structured audit events for a session',
            scope: 'bare',
          },
          {
            command: 'skill list',
            description: 'List available skills and availability',
            scope: 'bare',
          },
          {
            command: 'skill inspect <name>|--all',
            description: 'Show observation-based skill health',
            scope: 'bare',
          },
          {
            command: 'skill runs <name>',
            description: 'Show recent execution observations for a skill',
            scope: 'bare',
          },
          {
            command: 'skill learn <name> [--apply|--reject|--rollback]',
            description: 'Stage or manage skill amendments',
            scope: 'bare',
          },
          {
            command: 'skill history <name>',
            description: 'Show amendment history for a skill',
            scope: 'bare',
          },
          {
            command: 'skill sync [--skip-skill-scan] <source>',
            description: 'Reinstall a packaged or community skill',
            scope: 'bare',
          },
          {
            command: 'skill import [--force] [--skip-skill-scan] <source>',
            description:
              'Import a packaged or community skill into ~/.hybridclaw/skills',
            scope: 'bare',
          },
          {
            command: 'schedule add "<cron>" <prompt>',
            description: 'Add cron scheduled task',
            scope: 'bare',
          },
          {
            command: 'schedule add at "<ISO time>" <prompt>',
            description: 'Add one-shot task',
            scope: 'bare',
          },
          {
            command: 'schedule add every <ms> <prompt>',
            description: 'Add interval task',
            scope: 'bare',
          },
          {
            command: 'schedule list',
            description: 'List scheduled tasks',
            scope: 'bare',
          },
          {
            command: 'schedule remove <id>',
            description: 'Remove a task',
            scope: 'bare',
          },
          {
            command: 'schedule toggle <id>',
            description: 'Enable/disable a task',
            scope: 'bare',
          },
        ];
        const help = helpEntries.flatMap(({ command, description, scope }) => {
          const prefixes =
            scope === 'both' ? ['', '/'] : scope === 'slash' ? ['/'] : [''];
          return prefixes.map(
            (prefix) => `\`${prefix}${command}\` — ${description}`,
          );
        });
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

        if (sub === 'install') {
          const usage =
            'agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]';
          let installSource = '';
          let requestedId = '';
          let force = false;
          let skipSkillScan = false;
          let skipExternals = false;
          let skipImportErrors = false;
          let yes = false;

          for (let index = 2; index < req.args.length; index += 1) {
            const arg = String(req.args[index] || '').trim();
            if (!arg) continue;
            if (arg === '--id') {
              const nextValue = String(req.args[index + 1] || '').trim();
              if (!nextValue || nextValue.startsWith('--')) {
                return badCommand(
                  'Usage',
                  `Missing agent id for \`${usage}\`.`,
                );
              }
              requestedId = nextValue;
              index += 1;
              continue;
            }
            if (arg === '--force') {
              force = true;
              continue;
            }
            if (arg === '--skip-skill-scan') {
              skipSkillScan = true;
              continue;
            }
            if (arg === '--skip-externals') {
              skipExternals = true;
              continue;
            }
            if (arg === '--skip-import-errors') {
              skipImportErrors = true;
              continue;
            }
            if (arg === '--yes') {
              yes = true;
              continue;
            }
            if (arg.startsWith('--')) {
              return badCommand(
                'Usage',
                `Unknown option for \`agent install\`: ${arg}. Use \`${usage}\`.`,
              );
            }
            if (!installSource) {
              installSource = arg;
              continue;
            }
            return badCommand(
              'Usage',
              `Unexpected extra arguments for \`${usage}\`.`,
            );
          }

          if (!installSource) {
            return badCommand('Usage', `Missing source for \`${usage}\`.`);
          }
          if (
            !isLocalSession(req) &&
            isLocalFilesystemInstallSource(installSource)
          ) {
            return badCommand(
              'Agent Install Restricted',
              'Remote `agent install` sessions must use `official:`, `github:`, or a direct `.claw` URL. Local filesystem paths are only available from local TUI/web sessions.',
            );
          }

          const { unpackAgent } = await import('../agents/claw-archive.js');
          let resolvedArchive: Awaited<
            ReturnType<typeof resolveInstallArchiveSource>
          > | null = null;
          try {
            resolvedArchive = await resolveInstallArchiveSource(installSource);
            const result = await unpackAgent(resolvedArchive.archivePath, {
              ...(requestedId ? { agentId: requestedId } : {}),
              force,
              skipSkillScan,
              skipExternals,
              skipImportErrors,
              yes,
            });
            const reloadResult =
              result.installedPlugins.length > 0
                ? await reloadPluginRuntime()
                : null;
            const importedSkillsCount = result.importedSkills.length;
            const skippedSkillScans = result.importedSkills.filter(
              (skill) => skill.guardSkipped,
            ).length;
            const failedImportedSkills = result.failedImportedSkills ?? [];
            const lines = [
              `Installed agent \`${result.agentId}\` to \`${result.workspacePath}\`.`,
              `Bundled skills restored: ${result.bundledSkills.length}`,
              ...(importedSkillsCount > 0
                ? [`Skill imports installed: ${importedSkillsCount}`]
                : []),
              ...(skippedSkillScans > 0
                ? [
                    `Skill scanner skipped for ${skippedSkillScans} imported skill${skippedSkillScans === 1 ? '' : 's'} because --skip-skill-scan was set.`,
                  ]
                : []),
              ...(failedImportedSkills.length > 0
                ? [
                    `${failedImportedSkills.length} imported skill${failedImportedSkills.length === 1 ? '' : 's'} failed during install because --skip-import-errors was set:`,
                    ...failedImportedSkills.flatMap((failure) => [
                      `  ${failure.source}: ${failure.error}`,
                      `  Retry: hybridclaw skill import ${failure.source}`,
                    ]),
                  ]
                : []),
              `Bundled plugins installed: ${result.installedPlugins.length}`,
              ...(result.runtimeConfigChanged
                ? [`Updated runtime config at \`${runtimeConfigPath()}\`.`]
                : []),
              ...(result.externalActions.length > 0
                ? [
                    'External references were not installed automatically:',
                    ...result.externalActions.map((action) => `  ${action}`),
                  ]
                : []),
              ...(reloadResult ? [reloadResult.message] : []),
            ];
            return infoCommand('Agent Installed', lines.join('\n'));
          } catch (error) {
            return badCommand(
              'Agent Install Failed',
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            resolvedArchive?.cleanup?.();
          }
        }

        return badCommand(
          'Usage',
          'Usage: `agent|agent list|agent switch <id>|agent model [name]|agent create <id> [--model <model>]|agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]`',
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

        if (sub === 'clear' || sub === 'auto') {
          const previousBotId = session.chatbot_id;
          updateSessionChatbot(session.id, null);
          recordAuditEvent({
            sessionId: session.id,
            runId: makeAuditRunId('cmd'),
            event: {
              type: 'bot.clear',
              source: 'command',
              previousBotId,
              changed: previousBotId !== null,
              userId: boundAuditActorField(req.userId),
              username: boundAuditActorField(req.username),
            },
          });
          return plainCommand(
            'Chatbot cleared for this session. HybridAI account fallback will be used when required.',
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

        return badCommand(
          'Usage',
          'Usage: `bot list|set <id|name>|clear|info`',
        );
      }

      case 'model': {
        const sub = req.args[1]?.toLowerCase();
        const providerFilterArg = sub === 'list' ? req.args[2] : undefined;
        const listModifierArg =
          sub === 'list' ? req.args[3]?.toLowerCase() : undefined;
        const providerFilter = providerFilterArg
          ? normalizeModelCatalogProviderFilter(providerFilterArg)
          : null;
        const expandedModelList =
          listModifierArg === 'more' ||
          listModifierArg === 'all' ||
          listModifierArg === 'full';
        const needsAvailableModels =
          sub === 'list' ||
          sub === 'info' ||
          sub === 'default' ||
          sub === 'set';
        if (needsAvailableModels) {
          await refreshAvailableModelCatalogs({
            includeHybridAI:
              sub !== 'list' ||
              !providerFilterArg ||
              providerFilter === 'hybridai',
          });
        }
        const gatewayStatus = needsAvailableModels
          ? await getGatewayStatusForModelSubcommand(sub)
          : null;
        const availableModels =
          gatewayStatus == null
            ? []
            : filterModelsForCurrentGatewayState(
                getAvailableModelList(),
                gatewayStatus.providerHealth,
              );
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
              'Usage: `model list [hybridai|codex|openrouter|mistral|huggingface|local|ollama|lmstudio|llamacpp|vllm]`',
            );
          }
          if (listModifierArg && !expandedModelList) {
            return badCommand(
              'Usage',
              'Usage: `model list [hybridai|codex|openrouter|mistral|huggingface|local|ollama|lmstudio|llamacpp|vllm]`',
            );
          }
          const listedModels =
            gatewayStatus == null
              ? []
              : filterModelsForCurrentGatewayState(
                  getAvailableModelListWithOptions(providerFilterArg, {
                    expanded: expandedModelList,
                  }),
                  gatewayStatus.providerHealth,
                );
          const current = resolveDisplayedModelName(runtime.model);
          const modelCatalog = listedModels.map((model) => {
            const label = formatModelForDisplay(model);
            return {
              value: model,
              label: model === current ? `${label} (current)` : label,
              isFree: isAvailableModelFree(model),
              ...(isRecommendedModel(model) ? { recommended: true } : {}),
            };
          });
          const list = modelCatalog.map((entry) => entry.label).join('\n');
          if (!list) {
            return infoCommand(
              'Available Models',
              providerFilterArg
                ? (buildModelListProviderSetupMessage(providerFilterArg) ??
                    `No models available for provider \`${providerFilterArg}\`.`)
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
          const normalizedModelName = resolveDisplayedModelName(
            normalizeHybridAIModelForRuntime(modelName),
          );
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
          const normalizedModelName = resolveDisplayedModelName(
            normalizeHybridAIModelForRuntime(modelName),
          );
          if (
            availableModels.length > 0 &&
            !availableModels.includes(normalizedModelName)
          ) {
            return badCommand(
              'Unknown Model',
              `\`${modelName}\` is not in the available models list.`,
            );
          }
          const modelContextWindowTokens =
            resolveKnownModelContextWindow(normalizedModelName);
          updateSessionModel(session.id, normalizedModelName);
          recordAuditEvent({
            sessionId: session.id,
            runId: makeAuditRunId('cmd'),
            event: {
              type: 'model.set',
              source: 'command',
              model: normalizedModelName,
              modelContextWindowTokens,
              userId: boundAuditActorField(req.userId),
              username: boundAuditActorField(req.username),
            },
          });
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
          const currentModel = resolveDisplayedModelName(runtime.model);
          const modelCatalog = availableModels.map((model) => ({
            value: model,
            label:
              model === currentModel
                ? `${formatModelForDisplay(model)} (current)`
                : formatModelForDisplay(model),
            isFree: isAvailableModelFree(model),
            ...(isRecommendedModel(model) ? { recommended: true } : {}),
          }));
          return infoCommand(
            'Model Info',
            [
              `Effective model: ${formatModelForDisplay(runtime.model)}`,
              `Global model: ${formatModelForDisplay(HYBRIDAI_MODEL)}`,
              `Agent model: ${formatConfiguredAgentModel(resolvedAgent)}`,
              `Session model: ${sessionOverride}`,
              '',
              'Available now:',
              modelCatalog.length > 0
                ? modelCatalog.map((entry) => entry.label).join('\n')
                : '(none)',
            ].join('\n'),
            undefined,
            modelCatalog.length > 0 ? { modelCatalog } : undefined,
          );
        }

        return badCommand(
          'Usage',
          'Usage: `model list [provider] [more]|set <name>|clear|default [name]|info`',
        );
      }

      case 'concierge': {
        return await handleConciergeCommand({
          args: req.args,
          badCommand,
          infoCommand: (title, text) => infoCommand(title, text),
          plainCommand,
          resolveValidatedRuntimeModelName,
        });
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

      case 'auth': {
        const sub = (req.args[1] || '').trim().toLowerCase();
        const provider = normalizeGatewayAuthStatusProvider(req.args[2]);
        if (sub === 'status' && provider) {
          if (!isLocalSession(req)) {
            return badCommand(
              'Auth Status Restricted',
              `\`auth status ${provider}\` reads local credential state and is only available from local TUI/web sessions.`,
            );
          }
          const status = buildGatewayAuthStatusResponse(provider);
          return infoCommand(status.title, status.lines.join('\n'));
        }
        return badCommand(
          'Usage',
          'Usage: `auth status <hybridai|codex|openrouter|mistral|huggingface|local|msteams>`',
        );
      }

      case 'secret': {
        if (!isLocalSession(req)) {
          return badCommand(
            'Secret Command Restricted',
            '`secret` reads or writes local encrypted secrets and is only available from local TUI/web sessions.',
          );
        }

        const sub = (req.args[1] || '').trim().toLowerCase();
        if (!sub || sub === 'list') {
          const config = getRuntimeConfig();
          const secretNames = listStoredRuntimeSecretNames();
          const rules = config.tools.httpRequest.authRules;
          const text = [
            `Encrypted store: ${runtimeSecretsPath()}`,
            `Secrets: ${secretNames.length > 0 ? secretNames.join(', ') : '(none)'}`,
            '',
            'HTTP auth routes:',
            ...(rules.length > 0
              ? rules.map((rule, index) =>
                  formatHttpRequestAuthRule(rule, index),
                )
              : ['(none)']),
          ].join('\n');
          return infoCommand('Secrets', text);
        }

        if (sub === 'set') {
          const secretName = String(req.args[2] || '').trim();
          const secretValue = req.args.slice(3).join(' ').trim();
          if (!secretName || !secretValue) {
            return badCommand('Usage', 'Usage: `secret set <name> <value>`');
          }
          if (!isRuntimeSecretName(secretName)) {
            return badCommand(
              'Invalid Secret Name',
              'Secret names must use uppercase letters, digits, and underscores only.',
            );
          }
          if (isReservedNonSecretRuntimeName(secretName)) {
            return badCommand(
              'Reserved Non-Secret Name',
              `\`${secretName}\` is a normal runtime config key and cannot be stored in encrypted secrets.`,
            );
          }
          saveNamedRuntimeSecrets({ [secretName]: secretValue });
          return plainCommand(
            `Stored encrypted secret \`${secretName}\` in \`${runtimeSecretsPath()}\`.`,
          );
        }

        if (sub === 'unset' || sub === 'delete' || sub === 'remove') {
          const secretName = String(req.args[2] || '').trim();
          if (!secretName) {
            return badCommand('Usage', 'Usage: `secret unset <name>`');
          }
          if (!isRuntimeSecretName(secretName)) {
            return badCommand(
              'Invalid Secret Name',
              'Secret names must use uppercase letters, digits, and underscores only.',
            );
          }
          if (isReservedNonSecretRuntimeName(secretName)) {
            return badCommand(
              'Reserved Non-Secret Name',
              `\`${secretName}\` is a normal runtime config key and is not stored in encrypted secrets.`,
            );
          }
          saveNamedRuntimeSecrets({ [secretName]: null });
          return plainCommand(`Removed encrypted secret \`${secretName}\`.`);
        }

        if (sub === 'route') {
          const action = (req.args[2] || '').trim().toLowerCase();
          if (!action || action === 'list') {
            const rules = getRuntimeConfig().tools.httpRequest.authRules;
            return infoCommand(
              'Secret Routes',
              rules.length > 0
                ? rules
                    .map((rule, index) =>
                      formatHttpRequestAuthRule(rule, index),
                    )
                    .join('\n')
                : '(none)',
            );
          }

          if (action === 'add') {
            const rawPrefix = String(req.args[3] || '').trim();
            const secretName = String(req.args[4] || '').trim();
            const rawHeader = String(req.args[5] || '').trim();
            const rawAuthPrefix = String(req.args[6] || '').trim();
            if (!rawPrefix || !secretName) {
              return badCommand(
                'Usage',
                'Usage: `secret route add <url-prefix> <secret-name> [header] [prefix|none]`',
              );
            }
            if (!isRuntimeSecretName(secretName)) {
              return badCommand(
                'Invalid Secret Name',
                'Secret names must use uppercase letters, digits, and underscores only.',
              );
            }
            if (isReservedNonSecretRuntimeName(secretName)) {
              return badCommand(
                'Reserved Non-Secret Name',
                `\`${secretName}\` is a normal runtime config key and cannot be used as an encrypted secret route target.`,
              );
            }
            try {
              const urlPrefix = normalizeUrlPrefix(rawPrefix);
              const header = normalizeSecretRouteHeader(rawHeader);
              const prefix = normalizeSecretRoutePrefix(rawAuthPrefix);
              updateRuntimeConfig((draft) => {
                const nextRule: RuntimeHttpRequestAuthRule = {
                  urlPrefix,
                  header,
                  prefix,
                  secret: { source: 'store', id: secretName },
                };
                draft.tools.httpRequest.authRules =
                  draft.tools.httpRequest.authRules.filter(
                    (rule) =>
                      !(
                        rule.urlPrefix === urlPrefix &&
                        rule.header.toLowerCase() === header.toLowerCase()
                      ),
                  );
                draft.tools.httpRequest.authRules.push(nextRule);
              });
              const authLabel = prefix
                ? `${header}: ${prefix} <secret>`
                : `${header}: <secret>`;
              return plainCommand(
                `Added secret route for \`${urlPrefix}\` using \`${secretName}\` as \`${authLabel}\`.`,
              );
            } catch (error) {
              return badCommand(
                'Secret Route Failed',
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          if (action === 'remove') {
            const rawPrefix = String(req.args[3] || '').trim();
            const rawHeader = String(req.args[4] || '').trim();
            if (!rawPrefix) {
              return badCommand(
                'Usage',
                'Usage: `secret route remove <url-prefix> [header]`',
              );
            }
            try {
              const urlPrefix = normalizeUrlPrefix(rawPrefix);
              const header = rawHeader
                ? normalizeSecretRouteHeader(rawHeader)
                : '';
              let removed = 0;
              updateRuntimeConfig((draft) => {
                const before = draft.tools.httpRequest.authRules.length;
                draft.tools.httpRequest.authRules =
                  draft.tools.httpRequest.authRules.filter((rule) => {
                    if (rule.urlPrefix !== urlPrefix) return true;
                    if (
                      header &&
                      rule.header.toLowerCase() !== header.toLowerCase()
                    ) {
                      return true;
                    }
                    return false;
                  });
                removed = before - draft.tools.httpRequest.authRules.length;
              });
              return plainCommand(
                removed > 0
                  ? `Removed ${removed} secret route${removed === 1 ? '' : 's'} for \`${urlPrefix}\`.`
                  : `No secret routes matched \`${urlPrefix}\`.`,
              );
            } catch (error) {
              return badCommand(
                'Secret Route Failed',
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          return badCommand(
            'Usage',
            'Usage: `secret route list`, `secret route add <url-prefix> <secret-name> [header] [prefix|none]`, or `secret route remove <url-prefix> [header]`',
          );
        }

        if (sub === 'show' || sub === 'status') {
          const secretName = String(req.args[2] || '').trim();
          if (!secretName) {
            return badCommand('Usage', 'Usage: `secret show <name>`');
          }
          if (!isRuntimeSecretName(secretName)) {
            return badCommand(
              'Invalid Secret Name',
              'Secret names must use uppercase letters, digits, and underscores only.',
            );
          }
          const stored = readStoredRuntimeSecret(secretName);
          return infoCommand(
            'Secret Status',
            [`Name: ${secretName}`, `Stored: ${stored ? 'yes' : 'no'}`].join(
              '\n',
            ),
          );
        }

        return badCommand(
          'Usage',
          'Usage: `secret list`, `secret set <name> <value>`, `secret unset <name>`, `secret show <name>`, or `secret route list|add|remove ...`',
        );
      }

      case 'config': {
        if (!isLocalSession(req)) {
          return badCommand(
            'Config Restricted',
            '`config` reads or writes local runtime config and is only available from local TUI/web sessions.',
          );
        }

        const sub = (req.args[1] || '').trim().toLowerCase();
        if (!sub) {
          const currentConfig = getRuntimeConfig();
          return infoCommand(
            'Runtime Config',
            [
              `Active config: ${runtimeConfigPath()}`,
              'Config:',
              formatRuntimeConfigJson(currentConfig),
            ].join('\n'),
          );
        }

        if (sub === 'check') {
          const check = await runRuntimeConfigCheck();
          if (check.severity === 'error') {
            return badCommand('Config Check Failed', check.text);
          }
          return infoCommand(
            check.severity === 'warn'
              ? 'Config Check Warnings'
              : 'Config Check',
            check.text,
          );
        }

        if (sub === 'reload') {
          try {
            const nextConfig = reloadRuntimeConfig('gateway-command');
            const check = await runRuntimeConfigCheck();
            const text = [
              `Path: ${runtimeConfigPath()}`,
              'Config:',
              formatRuntimeConfigJson(nextConfig),
              '',
              'Check:',
              check.text,
            ].join('\n');
            if (check.severity === 'error') {
              return badCommand('Runtime Config Reloaded With Errors', text);
            }
            return infoCommand(
              check.severity === 'warn'
                ? 'Runtime Config Reloaded With Warnings'
                : 'Runtime Config Reloaded',
              text,
            );
          } catch (error) {
            return badCommand(
              'Config Reload Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        if (sub === 'set') {
          const key = String(req.args[2] || '').trim();
          const rawValue = req.args.slice(3).join(' ').trim();
          if (!key || !rawValue) {
            return badCommand(
              'Usage',
              'Usage: `config`, `config check`, `config reload`, or `config set <key> <value>`',
            );
          }
          try {
            const value = parseRuntimeConfigCommandValue(rawValue);
            const nextConfig = updateRuntimeConfig((draft) => {
              setRuntimeConfigValueAtPath(draft, key, value);
            });
            const check = await runRuntimeConfigCheck();
            const text = [
              `Path: ${runtimeConfigPath()}`,
              `Key: ${key}`,
              'Config:',
              formatRuntimeConfigJson(nextConfig),
              '',
              'Check:',
              check.text,
            ].join('\n');
            if (check.severity === 'error') {
              return badCommand('Runtime Config Updated With Errors', text);
            }
            return infoCommand(
              check.severity === 'warn'
                ? 'Runtime Config Updated With Warnings'
                : 'Runtime Config Updated',
              text,
            );
          } catch (error) {
            return badCommand(
              'Config Update Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        return badCommand(
          'Usage',
          'Usage: `config`, `config check`, `config reload`, or `config set <key> <value>`',
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
        return handlePluginGatewayCommand({
          req,
          pluginManager,
          pluginInitError,
        });
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
        const status = await getGatewayStatus();
        const delegationStatus = delegationQueueStatus();
        const commitShort = resolveGitCommitShort();
        const runtime = resolveSessionRuntimeTarget(session);
        const sessionModel = runtime.model;
        if (sessionModel.trim().toLowerCase().startsWith('huggingface/')) {
          await discoverHuggingFaceModels();
        }
        if (sessionModel.trim().toLowerCase().startsWith('openrouter/')) {
          await discoverOpenRouterModels();
        }
        if (sessionModel.trim().toLowerCase().startsWith('mistral/')) {
          await discoverMistralModels();
        }
        const modelContextWindowTokens =
          resolveKnownModelContextWindow(sessionModel);
        const metrics = readSessionStatusSnapshot(session.id, {
          currentModel: sessionModel,
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
        const visibleSessions = sessions.slice(0, 20);
        const boundariesBySessionId = getSessionBoundaryMessagesBySessionIds(
          visibleSessions.map((session) => session.id),
        );
        const list = visibleSessions
          .map((s) => {
            const boundary = boundariesBySessionId.get(s.id) || {
              firstMessage: null,
              lastMessage: null,
            };
            return `${s.id} — ${s.message_count} msgs, last: ${formatDisplayTimestamp(s.last_active)}${formatSessionSnippetSummary(boundary)}`;
          })
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
        if (sub !== 'session' && sub !== 'trace') {
          return badCommand(
            'Usage',
            'Usage: `export session [sessionId]` or `export trace [sessionId|all|--all]`',
          );
        }
        const traceTarget = (req.args[2] || '').trim();
        const exportAllTraces =
          sub === 'trace' &&
          (traceTarget.toLowerCase() === 'all' || traceTarget === '--all');
        const targetSessionId = exportAllTraces
          ? ''
          : (traceTarget || session.id || '').trim();
        if (!exportAllTraces && !targetSessionId) {
          return badCommand(
            'Usage',
            sub === 'trace'
              ? 'Usage: `export trace [sessionId|all|--all]`'
              : 'Usage: `export session [sessionId]`',
          );
        }
        if (exportAllTraces) {
          const targetSessions = getAllSessions({
            limit: TRACE_EXPORT_ALL_SESSION_LIMIT,
            warnLabel: 'gateway export trace all',
          });
          if (targetSessions.length === 0) {
            return plainCommand('No sessions available to export.');
          }
          const exportedTraces = await exportTraceForSessions(targetSessions);
          const exportedPaths = exportedTraces.map((exported) => exported.path);
          const totalSteps = exportedTraces.reduce(
            (sum, exported) => sum + exported.stepCount,
            0,
          );
          if (exportedPaths.length === 0) {
            return badCommand(
              'Export Failed',
              'Failed to write ATIF-compatible trace exports for any session. Check gateway logs for details.',
            );
          }
          const previewLimit = 10;
          const pathLines = exportedPaths
            .slice(0, previewLimit)
            .map((filePath) => `- ${filePath}`);
          if (exportedPaths.length > previewLimit) {
            pathLines.push(
              `- ...and ${exportedPaths.length - previewLimit} more`,
            );
          }
          return infoCommand(
            'Trace Exports Created',
            [
              `Sessions exported: ${exportedPaths.length}/${targetSessions.length}`,
              `Total steps: ${totalSteps}`,
              'Files:',
              ...pathLines,
            ].join('\n'),
          );
        }
        const targetSession = memoryService.getSessionById(targetSessionId);
        if (!targetSession) {
          return badCommand(
            'Not Found',
            `Session \`${targetSessionId}\` was not found.`,
          );
        }
        const messages = memoryService.getRecentMessages(targetSessionId);
        if (sub === 'trace') {
          const exported = await exportTraceForSession(targetSession);
          if (!exported) {
            return badCommand(
              'Export Failed',
              'Failed to write ATIF-compatible trace export JSONL file. Check gateway logs for details.',
            );
          }
          return infoCommand(
            'Trace Exported',
            [
              `File: ${exported.path}`,
              `Trace ID: ${exported.traceId}`,
              `Steps: ${exported.stepCount}`,
              `Messages: ${messages.length}`,
            ].join('\n'),
          );
        }
        const exported = exportSessionSnapshotJsonl({
          agentId: resolveSessionAgentId(targetSession),
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
            'Usage: `skill list|inspect <name>|inspect --all|runs <name>|learn <name> [--apply|--reject|--rollback]|history <name>|sync [--skip-skill-scan] <source>|import [--force] [--skip-skill-scan] <source>`',
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

        if (sub === 'learn') {
          const skillName = String(req.args[2] || '').trim();
          if (!skillName) {
            return badCommand(
              'Usage',
              'Usage: `skill learn <name> [--apply|--reject|--rollback]`',
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

        if (sub === 'import') {
          const { source, force, skipSkillScan } = parseSkillImportArgs(
            req.args.slice(2),
            {
              commandPrefix: 'skill',
              commandName: 'import',
              allowForce: true,
            },
          );

          const { importSkill } = await import('../skills/skills-import.js');
          const result = await importSkill(source, {
            force,
            skipGuard: skipSkillScan,
          });
          const lines = [
            ...buildGuardWarningLines(result),
            `${result.replacedExisting ? 'Replaced' : 'Imported'} ${result.skillName} from ${result.resolvedSource}`,
            `Installed to ${result.skillDir}`,
          ];
          return infoCommand('Skill Import', lines.join('\n'));
        }

        if (sub === 'sync') {
          const { source, skipSkillScan } = parseSkillImportArgs(
            req.args.slice(2),
            {
              commandPrefix: 'skill',
              commandName: 'sync',
              allowForce: false,
            },
          );

          const { importSkill } = await import('../skills/skills-import.js');
          const result = await importSkill(source, {
            force: true,
            skipGuard: skipSkillScan,
          });
          const lines = [
            ...buildGuardWarningLines(result),
            `${result.replacedExisting ? 'Replaced' : 'Imported'} ${result.skillName} from ${result.resolvedSource}`,
            `Installed to ${result.skillDir}`,
          ];
          return infoCommand('Skill Sync', lines.join('\n'));
        }

        return badCommand(
          'Usage',
          'Usage: `skill list|inspect <name>|inspect --all|runs <name>|learn <name> [--apply|--reject|--rollback]|history <name>|sync [--skip-skill-scan] <source>|import [--force] [--skip-skill-scan] <source>`',
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
        const pluginCommandResult = await tryHandlePluginDefinedGatewayCommand({
          command: cmd,
          req,
          pluginManager,
        });
        if (pluginCommandResult) {
          return pluginCommandResult;
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
