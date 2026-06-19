import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { buildMcpServerNamespaces } from '../../container/shared/mcp-tool-namespaces.js';
import {
  currentDateStampInTimezone,
  extractUserTimezone,
} from '../../container/shared/workspace-time.js';
import type { A2AAgentCard } from '../a2a/a2a-json-rpc.js';
import {
  approveIncomingA2APairingRequest,
  declineIncomingA2APairingRequest,
  fetchA2APairingProposal,
  listIncomingA2APairingRequests,
  type StartA2APairingResult,
  startA2APairing,
} from '../a2a/pairing.js';
import {
  type A2AThreadSummary,
  listA2AThreadEnvelopes,
  listA2AThreads,
} from '../a2a/store.js';
import {
  type BuildLocalA2AAgentCardOptions,
  buildLocalA2AAgentCard,
  deleteA2ATrustedPublicKeyPeer,
  ensureA2AInstanceKeypair,
  listA2ATrustedPublicKeyPeers,
  revokeA2ATrustedPublicKeyPeer,
  upsertA2ATrustedPublicKeyPeer,
} from '../a2a/trust-ledger.js';
import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import {
  delegationQueueStatus,
  enqueueDelegation,
} from '../agent/delegation-manager.js';
import {
  getActiveExecutorSessionIds,
  getSandboxDiagnostics,
  stopAllExecutions,
} from '../agent/executor.js';
import type { PromptMode } from '../agent/prompt-hooks.js';
import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import {
  buildToolsSummary,
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
  getRegisteredAgentTeamStructureRevision,
  getStoredAgentConfig,
  listAgents,
  listRegisteredAgentTeamStructureRevisions,
  resolveAgentConfig,
  resolveAgentForRequest,
  resolveAgentModel,
  restoreRegisteredAgentTeamStructureRevision,
  upsertRegisteredAgent,
} from '../agents/agent-registry.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { safeExtractZip } from '../agents/claw-security.js';
import { buildAgentTeamStructureSnapshot } from '../agents/team-structure.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { getObservabilityIngestState } from '../audit/observability-ingest.js';
import { getCodexAuthStatus } from '../auth/codex-auth.js';
import { getHybridAIAuthStatus } from '../auth/hybridai-auth.js';
import {
  type Card as BoardCard,
  type Edge as BoardCardEdge,
  isBlocked as isBoardCardBlocked,
  listCards,
  listEdges,
} from '../board/card-store.js';
import { syncLocalManagedBrowserTenantPolicyFromAdminPolicies } from '../browser/managed-browser-tenant-policy.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import { allowDiscordWebhookInWorkspacePolicy } from '../channels/discord-webhook/policy.js';
import { getDiscordWebhookStatus } from '../channels/discord-webhook/runtime.js';
import {
  DISCORD_WEBHOOK_DEFAULT_TARGET,
  discordWebhookSecretNameForTarget,
  normalizeDiscordWebhookTargetName,
  normalizeDiscordWebhookUrl,
} from '../channels/discord-webhook/target.js';
import {
  deleteLiveAdminEmailMessage,
  fetchLiveAdminEmailFolder,
  fetchLiveAdminEmailMailbox,
  fetchLiveAdminEmailMessage,
} from '../channels/email/admin-mailbox.js';
import {
  getSignalCliAvailability,
  getSignalLinkState,
} from '../channels/signal/pairing.js';
import { allowSlackWebhookInWorkspacePolicy } from '../channels/slack-webhook/policy.js';
import { getSlackWebhookStatus } from '../channels/slack-webhook/runtime.js';
import {
  normalizeSlackWebhookTargetName,
  normalizeSlackWebhookUrl,
  SLACK_WEBHOOK_DEFAULT_TARGET,
  slackWebhookSecretNameForTarget,
} from '../channels/slack-webhook/target.js';
import {
  createTwilioOutboundCall,
  normalizeTwilioPhoneNumber,
  resolveVoiceWebhookPaths,
} from '../channels/voice/twilio-manager.js';
import { getWhatsAppAuthStatus } from '../channels/whatsapp/auth.js';
import { getWhatsAppPairingState } from '../channels/whatsapp/pairing-state.js';
import {
  parseIdArg,
  parseIntegerArg,
  parseLowerArg,
} from '../command-parsing.js';
import { buildLocalSessionSlashHelpEntries } from '../command-registry.js';
import {
  AuxCommandUsageError,
  runAuxCommand,
} from '../commands/aux-command.js';
import { runBtwSideQuestion } from '../commands/btw-command.js';
import { runPolicyCommand } from '../commands/policy-command.js';
import { runSecondOpinionCommand } from '../commands/second-opinion-command.js';
import {
  APP_VERSION,
  DATA_DIR,
  DISCORD_COMMANDS_ONLY,
  DISCORD_FREE_RESPONSE_CHANNELS,
  DISCORD_GROUP_POLICY,
  DISCORD_GUILDS,
  DISCORD_TOKEN,
  EMAIL_PASSWORD,
  FULLAUTO_NEVER_APPROVE_TOOLS,
  GATEWAY_API_TOKEN,
  GATEWAY_BASE_URL,
  GATEWAY_CLIENT_BASE_URL,
  HUGGINGFACE_API_KEY,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
  IMESSAGE_PASSWORD,
  MISTRAL_API_KEY,
  MissingRequiredEnvVarError,
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
  MSTEAMS_TENANT_ID,
  OPENROUTER_API_KEY,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_DELEGATION_MAX_DEPTH,
  PROACTIVE_DELEGATION_MODEL,
  PROACTIVE_RALPH_MAX_ITERATIONS,
  refreshRuntimeSecretsFromEnv,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  TELEGRAM_BOT_TOKEN,
  THREEMA_GATEWAY_SECRET,
  TWILIO_AUTH_TOKEN,
  WEB_API_TOKEN,
} from '../config/config.js';
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  isGoogleApisUrlPrefix,
  isGoogleOAuthSecretRef,
  isGoogleOAuthSpecifier,
  makeGoogleOAuthSecretRef,
  normalizeHttpRequestAuthRuleUrlPrefix,
  type RuntimeAuxiliaryModelPolicyConfig,
  type RuntimeConfig,
  type RuntimeHttpRequestAuthRule,
  type RuntimeHttpRequestAuthRuleSecret,
  reloadRuntimeConfig,
  resolveDefaultAgentId,
  runtimeConfigPath,
  saveRuntimeConfig,
  setRuntimeConfigDiscordWebhookSecretInput,
  setRuntimeConfigSlackWebhookSecretInput,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import {
  formatRuntimeConfigValue,
  getRuntimeConfigValueAtPath,
  parseRuntimeConfigCommandValue,
  setRuntimeConfigValueAtPath,
} from '../config/runtime-config-edit.js';
import {
  readStoredRuntimeEnv,
  readStoredRuntimeEnvValue,
  runtimeEnvPath,
  saveNamedRuntimeEnv,
  validateRuntimeEnvName,
} from '../config/runtime-env.js';
import { checkConfigFile } from '../doctor/checks/config.js';
import { summarizeCounts } from '../doctor/utils.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { handleGoalCommand } from '../goals/goal-command.js';
import { pauseActiveGoalForSession } from '../goals/goal-runtime.js';
import { resolveContainerImageStatus } from '../infra/container-setup.js';
import { stopSessionHostProcess } from '../infra/host-runner.js';
import { resolveInstallRoot } from '../infra/install-root.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import {
  clearMcpOAuth,
  completeMcpOAuthFlow,
  getMcpOAuthStatus,
  type McpOAuthStartResult,
  type McpOAuthStatus,
  startMcpOAuthFlow,
} from '../mcp/mcp-oauth.js';
import { MCP_SERVER_NAME_RE, supportsMcpOAuth } from '../mcp/server-config.js';
import { isAudioMediaItem } from '../media/audio-transcription.js';
import { summarizeMediaFilenames } from '../media/media-summary.js';
import {
  type CloudMemoryContextFile,
  loadCloudMemoryContextFiles,
} from '../memory/cloud-memory.js';
import { NoCompactableMessagesError } from '../memory/compaction.js';
import { runMemoryConsolidation } from '../memory/consolidation-runner.js';
import {
  countStructuredAuditEntries,
  createFreshSessionInstance,
  deleteMemoryValue,
  deleteSessionData,
  enqueueProactiveMessage,
  getAllSessions,
  getFullAutoSessionCount,
  getMemoryValue,
  getQueuedProactiveMessageCount,
  getRecentMessages,
  getRecentSessionsForChannel,
  getRecentSessionsForUser,
  getRecentStructuredAuditForSession,
  getResponseRatingsForMessages,
  getSessionBoundaryMessagesBySessionIds,
  getSessionCount,
  getSessionFileChangeCounts,
  getSessionMessageCounts,
  getSessionToolCallBreakdown,
  getSessionUsageTotals,
  getSessionUsageTotalsSince,
  getStatisticsTotals,
  getStructuredAuditForSession,
  getUsageTotals,
  listMessageTrendByDay,
  listSemanticMemoriesForSession,
  listSessionTrendByDay,
  listStatsByChannel,
  listStructuredAuditEntries,
  listUsageByAgent,
  listUsageByAgentRollups,
  listUsageByModel,
  listUsageBySession,
  listUsageDailyBreakdown,
  recordRequestLog,
  setMemoryValue,
  updateSessionAgent,
  updateSessionChatbot,
  updateSessionModel,
  updateSessionRag,
  updateSessionShowMode,
} from '../memory/db.js';
import {
  createJob,
  deleteJob,
  getAllJobs,
  setJobEnabled,
} from '../memory/jobs.js';
import { memoryService } from '../memory/memory-service.js';
import {
  ensurePluginManagerInitialized,
  listLoadedPluginCommands,
} from '../plugins/plugin-manager.js';
import {
  applyPolicyPreset,
  listPolicyPresetSummaries,
  type PolicyPresetSummary,
} from '../policy/policy-presets.js';
import {
  addPolicyRule,
  deletePolicyRule,
  readPolicyState,
  setLanHttpAccessMode,
  setPolicyDefault,
  updatePolicyRule,
} from '../policy/policy-store.js';
import { loadPolicyFullAutoNeverApprove } from '../policy/remote-policy-authority.js';
import {
  allowHttpSecretRouteInWorkspacePolicy,
  captureHttpSecretRoutePolicySnapshot,
  removeHttpSecretRouteFromWorkspacePolicy,
  restoreHttpSecretRoutePolicySnapshot,
} from '../policy/secret-route-policy.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { discoverCodexModels } from '../providers/codex-discovery.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import { discoverHuggingFaceModels } from '../providers/huggingface-discovery.js';
import {
  fetchHybridAIAccountChatbotId,
  fetchHybridAIBots,
  HybridAIBotFetchError,
} from '../providers/hybridai-bots.js';
import { getLocalModelInfo } from '../providers/local-discovery.js';
import {
  discoverMistralModels,
  resolveDiscoveredMistralModelCanonicalName,
} from '../providers/mistral-discovery.js';
import {
  getAvailableModelList,
  getModelCatalogMetadata,
  isAvailableModelFree,
  normalizeModelCatalogProviderFilter,
  refreshAvailableModelCatalogs,
  refreshModelCatalogMetadata,
} from '../providers/model-catalog.js';
import {
  formatHybridAIModelForCatalog,
  formatModelCountSuffix,
  formatModelForDisplay,
  HYBRIDAI_MODEL_PREFIX,
  NON_HYBRID_PROVIDER_PREFIXES,
  normalizeHybridAIModelForRuntime,
  stripHybridAIModelPrefix,
} from '../providers/model-names.js';
import { discoverOpenRouterModels } from '../providers/openrouter-discovery.js';
import { isRuntimeProviderId } from '../providers/provider-ids.js';
import { isRecommendedModel } from '../providers/recommended-models.js';
import {
  normalizeAuxiliaryProviderModel,
  resolveDefaultAuxiliaryModelForProvider,
} from '../providers/task-routing.js';
import { getSchedulerStatus, rearmScheduler } from '../scheduler/scheduler.js';
import { redactSecrets } from '../security/redact.js';
import {
  isReservedNonSecretRuntimeName,
  isRuntimeSecretName,
  listStoredRuntimeSecretNames,
  normalizeRuntimeSecretInputValue,
  readStoredRuntimeSecret,
  readStoredRuntimeSecrets,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { isSecretRefInput } from '../security/secret-refs.js';
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
  type AuditTurnTraceSelector,
  formatAuditTurnTrace,
} from '../session/session-turn-trace.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import {
  formatAgentAssignmentHints,
  getAgentScoreboard,
  getObservedAgentSkillCount,
} from '../skills/agent-scoreboard.js';
import {
  type BlockedSkillCatalogEntry,
  loadSkillCatalog,
  loadSkillCatalogs,
  resolveManagedCommunitySkillsDir,
  type SkillCatalogEntry,
  SkillGuardUnblockInputError,
  unblockGuardedSkill,
} from '../skills/skills.js';
import {
  guardSkillDirectory,
  type SkillGuardFinding,
} from '../skills/skills-guard.js';
import type { ChatMessage } from '../types/api.js';
import type { StructuredAuditEntry } from '../types/audit.js';
import type { ContainerOutput, MediaContextItem } from '../types/container.js';
import type {
  ArtifactMetadata,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import type { MemoryCitation, SemanticMemoryEntry } from '../types/memory.js';
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
import { buildMediaGenerationUsageEvents } from '../usage/media-generation-usage.js';
import {
  extractExplicitUsageCostUsd,
  resolveUsageCostUsdAfterMetadataRefresh,
} from '../usage/model-cost.js';
import { enqueueTokenUsage } from '../usage/token-usage-buffer.js';
import { isApprovalHistoryMessage } from '../utils/approval-text.js';
import {
  dedupeStrings,
  normalizeOptionalTrimmedUniqueStringArray,
} from '../utils/normalized-strings.js';
import { sleep } from '../utils/sleep.js';
import { formatDurationMs } from '../utils/text-format.js';
import {
  ensureBootstrapFiles,
  resetWorkspace,
  resolveStartupBootstrapFile,
  WORKSPACE_BOOTSTRAP_FILES,
} from '../workspace.js';
import {
  resolveAgentAddressing,
  setActiveThreadAgentId,
} from './agent-addressing.js';
import {
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from './chat-result.js';
import { buildContextUsageSnapshot } from './context-usage.js';
import { getCoworkerLivenessSummary } from './coworker-liveness.js';
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
import {
  buildGatewayHybridAIProviderEntry,
  type GatewayHealthOptions,
  invalidateGatewayProviderHealth,
  resolveGatewayHybridAIHealth,
  resolveGatewayLocalBackendsHealth,
} from './gateway-health-service.js';
import { GATEWAY_LOG_REQUESTS_ENV } from './gateway-lifecycle.js';
import { tryEnsurePluginManagerInitializedForGateway } from './gateway-plugin-runtime.js';
import {
  handlePluginGatewayCommand,
  reloadPluginRuntime,
  tryHandlePluginDefinedGatewayCommand,
} from './gateway-plugin-service.js';
import { diagnoseProviderForModels } from './gateway-provider-service.js';
import { interruptGatewaySessionExecution } from './gateway-request-runtime.js';
import { getGatewayLifecycleStatus } from './gateway-restart.js';
import {
  readDelegateSessionStatusSnapshot,
  readSessionStatusSnapshot,
  type SessionStatusSnapshot,
} from './gateway-session-status.js';
import {
  formatDisplayTimestamp,
  formatRelativeTime,
  parseTimestamp,
} from './gateway-time.js';
import {
  getGatewayAdminTunnelStatus,
  reconnectGatewayAdminTunnel,
} from './gateway-tunnel-service.js';
import {
  type GatewayAdminA2AInboxResponse,
  type GatewayAdminA2APairingDecisionRequest,
  type GatewayAdminA2APairingPreviewResponse,
  type GatewayAdminA2APairingStartRequest,
  type GatewayAdminA2APairingStartResponse,
  type GatewayAdminA2AThreadMessage,
  type GatewayAdminA2AThreadSummary,
  type GatewayAdminA2ATrustPeer,
  type GatewayAdminA2ATrustResponse,
  type GatewayAdminA2ATrustUpsertRequest,
  type GatewayAdminAgent,
  type GatewayAdminAgentMarkdownFile,
  type GatewayAdminAgentMarkdownFileResponse,
  type GatewayAdminAgentMarkdownRevision,
  type GatewayAdminAgentMarkdownRevisionResponse,
  type GatewayAdminAgentScoreboardResponse,
  type GatewayAdminAgentsResponse,
  type GatewayAdminApprovalAgent,
  type GatewayAdminApprovalsResponse,
  type GatewayAdminAuditResponse,
  type GatewayAdminChannelsResponse,
  type GatewayAdminChannelUpsertRequest,
  type GatewayAdminConfigResponse,
  type GatewayAdminDeleteSessionResult,
  type GatewayAdminDiscordWebhookTargetRequest,
  type GatewayAdminEmailDeleteResponse,
  type GatewayAdminEmailFolderResponse,
  type GatewayAdminEmailMailboxResponse,
  type GatewayAdminEmailMessageResponse,
  type GatewayAdminHybridAIBotsResponse,
  type GatewayAdminJobCard,
  type GatewayAdminJobCardEdge,
  type GatewayAdminJobsContextResponse,
  type GatewayAdminLanHttpAccessMode,
  type GatewayAdminMcpOAuthStatusResponse,
  type GatewayAdminMcpResponse,
  type GatewayAdminModelsResponse,
  type GatewayAdminModelUsageRow,
  type GatewayAdminOverview,
  type GatewayAdminPendingApproval,
  type GatewayAdminPolicyPresetSummary,
  type GatewayAdminPolicyRule,
  type GatewayAdminPolicyState,
  type GatewayAdminSession,
  type GatewayAdminSkill,
  type GatewayAdminSkillsResponse,
  type GatewayAdminSlackWebhookTargetRequest,
  type GatewayAdminStatisticsChannelRow,
  type GatewayAdminStatisticsResponse,
  type GatewayAdminStatisticsTrendDay,
  type GatewayAdminSuspendedSession,
  type GatewayAdminTeamStructureResponse,
  type GatewayAdminTeamStructureRevision,
  type GatewayAdminTeamStructureRevisionResponse,
  type GatewayAdminToolCatalogEntry,
  type GatewayAdminToolsResponse,
  type GatewayAdminUsageSummary,
  type GatewayAgentListResponse,
  type GatewayAgentsResponse,
  type GatewayAssistantPresentation,
  type GatewayChatRequest,
  type GatewayChatResult,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayHistorySummary,
  type GatewayModelProviderKey,
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
import { initializeGoalContinuationRunner } from './goal-continuation-runner.js';
import { listSuspendedSessions } from './interactive-escalation.js';
import { listPendingApprovals } from './pending-approvals.js';
import { isDiscordChannelId } from './proactive-delivery.js';
import {
  buildGatewayProviderHealth,
  getGatewayAdminProviderStatus,
} from './provider-status.js';
import { buildResetConfirmationComponents } from './reset-confirmation.js';
import {
  describeSessionShowMode,
  isSessionShowMode,
  normalizeSessionShowMode,
} from './show-mode.js';
import { handleSkillCommand } from './skill-commands.js';

export { reconnectGatewayAdminTunnel };

initializeGoalContinuationRunner();

const BOT_CACHE_TTL = 300_000; // 5 minutes
const TRACE_EXPORT_ALL_SESSION_LIMIT = 1_000;
const TRACE_EXPORT_ALL_CONCURRENCY = 4;
const GATEWAY_PROCESS_STARTED_AT = new Date().toISOString();
const MAX_HISTORY_MESSAGES = 40;
const BOOTSTRAP_AUTOSTART_MARKER_KEY = 'gateway.bootstrap_autostart.v1';
const BOOTSTRAP_AUTOSTART_SOURCE = 'gateway.bootstrap';
const BOOTSTRAP_PRELUDE_MAX_TOKENS = 48;
const BOOTSTRAP_PRELUDE_TIMEOUT_MS = 1500;
const activeBootstrapAutostartSessions = new Set<string>();
const assistantPresentationImagePathCache = new Map<string, string | null>();
const ADMIN_AGENT_MARKDOWN_MAX_BYTES = 200_000;
const ADMIN_AGENT_MARKDOWN_MAX_REVISIONS = 50;
const ADMIN_AGENT_MARKDOWN_REVISIONS_DIRNAME = 'markdown-revisions';
const ADMIN_AGENT_LOCAL_MARKDOWN_FILES = [
  ...WORKSPACE_BOOTSTRAP_FILES,
  'CV.md',
] as const;
const ADMIN_AGENT_SHARED_MEMORY_FILES = [
  {
    name: 'Instance Memory.md',
    displayName: 'Instance Memory',
    scope: 'installation',
    cloudPath: '/MEMORY.md',
  },
  {
    name: 'Organization Memory.md',
    displayName: 'Organization Memory',
    scope: 'company',
    cloudPath: '/MEMORY.md',
  },
] as const;
const ADMIN_AGENT_MARKDOWN_FILES = [
  ...ADMIN_AGENT_LOCAL_MARKDOWN_FILES,
  ...ADMIN_AGENT_SHARED_MEMORY_FILES.map((file) => file.name),
] as const;
const ADMIN_AGENT_MARKDOWN_FILE_SET = new Set<string>(
  ADMIN_AGENT_MARKDOWN_FILES,
);
const ADMIN_AGENT_LOCAL_MARKDOWN_FILE_SET = new Set<string>(
  ADMIN_AGENT_LOCAL_MARKDOWN_FILES,
);
const ADMIN_AGENT_SHARED_MEMORY_FILE_BY_NAME = new Map<
  string,
  (typeof ADMIN_AGENT_SHARED_MEMORY_FILES)[number]
>(ADMIN_AGENT_SHARED_MEMORY_FILES.map((file) => [file.name, file]));
type AdminAgentMarkdownFileName = (typeof ADMIN_AGENT_MARKDOWN_FILES)[number];
type AdminAgentLocalMarkdownFileName =
  (typeof ADMIN_AGENT_LOCAL_MARKDOWN_FILES)[number];
type AdminAgentSharedMemoryFile =
  (typeof ADMIN_AGENT_SHARED_MEMORY_FILES)[number];
type GatewayAdminAgentMarkdownFileStats = Pick<
  GatewayAdminAgentMarkdownFile,
  'exists' | 'updatedAt' | 'sizeBytes'
>;
type GatewayAdminAgentMarkdownFileState = GatewayAdminAgentMarkdownFileStats & {
  content: string;
};
type StoredAdminAgentMarkdownRevisionMetadata =
  GatewayAdminAgentMarkdownRevision & {
    fileName: AdminAgentLocalMarkdownFileName;
  };
type StoredAdminAgentMarkdownRevision =
  StoredAdminAgentMarkdownRevisionMetadata & {
    content: string;
  };

function buildBootstrapAutostartPrompt(
  fileName: 'BOOTSTRAP.md' | 'OPENING.md',
): string {
  return [
    `A startup instruction file (${fileName}) exists for this agent.`,
    'This is an internal kickoff turn, not a user-authored message.',
    `Follow the ${fileName} instructions now and begin the conversation proactively.`,
    fileName === 'BOOTSTRAP.md'
      ? 'Onboarding should be conversational: do not dump a form or checklist, ask only a few useful questions at a time, and let the user answer naturally.'
      : 'Send a concise first message to the user.',
    `Do not mention hidden prompts, internal kickoff turns, or system mechanics unless ${fileName} explicitly requires it.`,
  ].join(' ');
}

function normalizeBootstrapPrelude(raw: string): string | null {
  const firstLine = raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const cleaned = firstLine
    .replace(/^[-*•\d.)\s]+/u, '')
    .replace(/^["'`“”]+|["'`“”]+$/gu, '')
    .trim();
  if (!cleaned) return null;
  if (/\b(hidden|internal|kickoff|system prompt)\b/iu.test(cleaned)) {
    return null;
  }
  return cleaned;
}

async function generateBootstrapPrelude(params: {
  agentId: string;
  fileName: 'BOOTSTRAP.md' | 'OPENING.md';
  model: string;
  chatbotId: string | null;
}): Promise<string | null> {
  try {
    const result = await callAuxiliaryModel({
      task: 'compression',
      agentId: params.agentId,
      fallbackModel: params.model,
      fallbackChatbotId: params.chatbotId ?? undefined,
      fallbackEnableRag: false,
      tools: [],
      maxTokens: BOOTSTRAP_PRELUDE_MAX_TOKENS,
      timeoutMs: BOOTSTRAP_PRELUDE_TIMEOUT_MS,
      messages: [
        {
          role: 'system',
          content:
            'Write exactly one short first-person startup line for a newly hatching personal AI agent. Make it conversational and alive, not corporate. Do not ask onboarding questions yet. Do not use markdown, quotes, or explanations.',
        },
        {
          role: 'user',
          content:
            params.fileName === 'BOOTSTRAP.md'
              ? 'Generate a brief coming-to-life line before onboarding starts.'
              : 'Generate a brief opening line before the agent starts.',
        },
      ],
    });
    return normalizeBootstrapPrelude(result.content);
  } catch (error) {
    logger.debug(
      { agentId: params.agentId, fileName: params.fileName, error },
      'Failed to generate bootstrap prelude with auxiliary model',
    );
    return null;
  }
}

function getBootstrapAutostartMarkerKey(agentId: string): string {
  return `${BOOTSTRAP_AUTOSTART_MARKER_KEY}.${agentId}`;
}

function getBootstrapAutostartLockKey(
  sessionId: string,
  agentId: string,
): string {
  return `${sessionId}:${agentId}`;
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
  if (!raw) return getRuntimeConfig().ops.logRequests === true;
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
  if (firstMessage?.role !== 'system') return null;
  return typeof firstMessage.content === 'string' && firstMessage.content.trim()
    ? firstMessage.content
    : null;
}

export function readDynamicContextMessage(
  messages: ChatMessage[],
): string | null {
  const dynamicContextMessage = messages.find(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.trimStart().startsWith('<context>'),
  );
  if (!dynamicContextMessage) return null;
  const content = sanitizeRequestLogValue(dynamicContextMessage.content);
  return typeof content === 'string' && content.trim() ? content : null;
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
  'browser_secret_type',
  'browser_upload',
  'browser_press',
  'browser_scroll',
  'browser_back',
  'browser_screenshot',
  'browser_pdf',
  'browser_vision',
  'vision_analyze',
  'audio_transcribe',
  'image_generate',
  'video_generate',
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
const MAX_QUEUED_DELEGATION_MESSAGES = 500;
const DELEGATION_STREAM_DELTA_FLUSH_CHARS = 96;
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
  toolExecutions?: ToolExecution[];
  tokenCount?: number;
  result?: string;
  error?: string;
  artifacts?: ArtifactMetadata[];
}

interface DelegationCompletionEntry {
  title: string;
  run: DelegationRunResult;
}

interface DelegationStatusEntry {
  title: string;
  model: string;
  status: 'queued' | 'running' | DelegationRunStatus;
  toolUses: number;
  tokenCount?: number;
  currentTool?: string;
  currentToolDetail?: string;
  lastTool?: string;
  lastToolDetail?: string;
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
  onToolProgress?: (event: ToolProgressEvent) => void;
}

function resolveTurnRuntimeAuditLabel(
  model: string,
  output: Pick<ContainerOutput, 'codexRuntime'> | undefined,
): 'codex' | 'hybridclaw' {
  return resolveModelProvider(model) === 'openai-codex' &&
    output?.codexRuntime === 'app-server'
    ? 'codex'
    : 'hybridclaw';
}

async function persistDelegationAttempt(params: {
  sessionId: string;
  model: string;
  chatbotId: string;
  messages: ChatMessage[];
  durationMs: number;
  output?: Awaited<ReturnType<typeof runAgent>>;
  error?: string;
}): Promise<void> {
  const runId = makeAuditRunId('delegate');
  const toolExecutions = params.output?.toolExecutions || [];
  const toolCallCount = toolExecutions.length;
  emitToolExecutionAuditEvents({
    sessionId: params.sessionId,
    runId,
    toolExecutions,
  });
  if (params.output?.tokenUsage) {
    const usagePayload = buildTokenUsageAuditPayload(
      params.messages,
      params.output.result,
      params.output.tokenUsage,
    );
    recordAuditEvent({
      sessionId: params.sessionId,
      runId,
      event: {
        type: 'model.usage',
        provider: resolveModelProvider(params.model),
        model: params.model,
        runtime: resolveTurnRuntimeAuditLabel(params.model, params.output),
        codexRuntime: params.output.codexRuntime || null,
        durationMs: params.durationMs,
        toolCallCount,
        ...usagePayload,
      },
    });
    enqueueTokenUsage({
      sessionId: params.sessionId,
      agentId: 'delegate',
      model: params.model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      toolCalls: toolCallCount,
      costUsd: await resolveUsageCostUsdAfterMetadataRefresh({
        model: params.model,
        tokenUsage: params.output.tokenUsage,
        usage: usagePayload,
      }),
      auditRunId: runId,
    });
    for (const event of buildMediaGenerationUsageEvents({
      sessionId: params.sessionId,
      agentId: 'delegate',
      auditRunId: runId,
      toolExecutions,
    })) {
      enqueueTokenUsage(event);
    }
  }
  maybeRecordGatewayRequestLog({
    sessionId: params.sessionId,
    model: params.model,
    chatbotId: params.chatbotId,
    messages: params.messages,
    status: params.output?.status === 'success' ? 'success' : 'error',
    response:
      params.output?.status === 'success'
        ? (params.output.result ?? null)
        : null,
    error:
      params.output?.status === 'success'
        ? null
        : params.output?.error || params.error || null,
    toolExecutions,
    toolsUsed: params.output?.toolsUsed || [],
    durationMs: params.durationMs,
  });
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
    source === 'msteams' ||
    source === 'voice'
  ) {
    return source;
  }
  const inferredChannelType = resolveSessionResetChannelKind(req.channelId);
  if (
    inferredChannelType === 'discord' ||
    inferredChannelType === 'imessage' ||
    inferredChannelType === 'whatsapp' ||
    inferredChannelType === 'email' ||
    inferredChannelType === 'voice'
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
  GatewayAdminStatisticsResponse,
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

function getGatewayAdminAgentConfig(agentId: string): AgentConfig {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    throw new Error('Agent id is required.');
  }
  const agent = getAgentById(normalizedAgentId);
  if (!agent) {
    throw new Error(`Agent "${normalizedAgentId}" was not found.`);
  }
  return agent;
}

function normalizeGatewayAdminAgentMarkdownFileName(
  value: string,
): AdminAgentMarkdownFileName {
  const normalized = value.trim();
  if (!ADMIN_AGENT_MARKDOWN_FILE_SET.has(normalized)) {
    throw new Error(
      `Unsupported markdown file "${normalized}". Allowed files: ${ADMIN_AGENT_MARKDOWN_FILES.join(', ')}`,
    );
  }
  return normalized as AdminAgentMarkdownFileName;
}

function isGatewayAdminLocalMarkdownFileName(
  fileName: AdminAgentMarkdownFileName,
): fileName is AdminAgentLocalMarkdownFileName {
  return ADMIN_AGENT_LOCAL_MARKDOWN_FILE_SET.has(fileName);
}

function normalizeGatewayAdminAgentLocalMarkdownFileName(
  value: string,
): AdminAgentLocalMarkdownFileName {
  const fileName = normalizeGatewayAdminAgentMarkdownFileName(value);
  if (!isGatewayAdminLocalMarkdownFileName(fileName)) {
    throw new Error(`Shared markdown file "${fileName}" is read-only.`);
  }
  return fileName;
}

function getGatewayAdminSharedMemoryFileSpec(
  fileName: AdminAgentMarkdownFileName,
): AdminAgentSharedMemoryFile | null {
  return ADMIN_AGENT_SHARED_MEMORY_FILE_BY_NAME.get(fileName) || null;
}

function resolveGatewayAdminAgentMarkdownFile(params: {
  agentId: string;
  fileName: string;
}): {
  agent: AgentConfig;
  resolvedAgent: AgentConfig;
  fileName: AdminAgentMarkdownFileName;
  sharedMemoryFile: AdminAgentSharedMemoryFile | null;
  workspacePath: string;
  filePath: string;
} {
  const agent = getGatewayAdminAgentConfig(params.agentId);
  const fileName = normalizeGatewayAdminAgentMarkdownFileName(params.fileName);
  const sharedMemoryFile = getGatewayAdminSharedMemoryFileSpec(fileName);
  const resolvedAgent = resolveAgentConfig(agent.id);
  const workspacePath = path.resolve(agentWorkspaceDir(resolvedAgent.id));
  const filePath = sharedMemoryFile
    ? `cloud-memory://${sharedMemoryFile.scope}${sharedMemoryFile.cloudPath}`
    : path.join(workspacePath, fileName);
  return {
    agent,
    resolvedAgent,
    fileName,
    sharedMemoryFile,
    workspacePath,
    filePath,
  };
}

function getGatewayAdminAgentMarkdownFileStats(
  filePath: string,
): GatewayAdminAgentMarkdownFileStats {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error('Not a regular file.');
    }
    return {
      exists: true,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return {
        exists: false,
        updatedAt: null,
        sizeBytes: null,
      };
    }
    throw error;
  }
}

function getGatewayAdminSharedMemoryFile(
  agentId: string,
  spec: AdminAgentSharedMemoryFile,
): CloudMemoryContextFile | null {
  return (
    loadCloudMemoryContextFiles(agentId).find(
      (file) => file.scope === spec.scope && file.name === spec.cloudPath,
    ) || null
  );
}

function getGatewayAdminSharedMemoryFileStats(
  agentId: string,
  spec: AdminAgentSharedMemoryFile,
): GatewayAdminAgentMarkdownFileStats {
  const file = getGatewayAdminSharedMemoryFile(agentId, spec);
  if (!file) {
    return {
      exists: false,
      updatedAt: null,
      sizeBytes: null,
    };
  }
  return {
    exists: true,
    updatedAt: null,
    sizeBytes: Buffer.byteLength(file.content, 'utf-8'),
  };
}

function mapGatewayAdminAgentMarkdownFile(params: {
  agentId: string;
  workspacePath: string;
  fileName: AdminAgentMarkdownFileName;
  stats?: GatewayAdminAgentMarkdownFileStats;
}): GatewayAdminAgentMarkdownFile {
  const sharedMemoryFile = getGatewayAdminSharedMemoryFileSpec(params.fileName);
  if (sharedMemoryFile) {
    const stats =
      params.stats ??
      getGatewayAdminSharedMemoryFileStats(params.agentId, sharedMemoryFile);
    return {
      name: sharedMemoryFile.name,
      displayName: sharedMemoryFile.displayName,
      path: `cloud-memory://${sharedMemoryFile.scope}${sharedMemoryFile.cloudPath}`,
      scope: sharedMemoryFile.scope,
      cloudPath: sharedMemoryFile.cloudPath,
      readOnly: true,
      exists: stats.exists,
      updatedAt: stats.updatedAt,
      sizeBytes: stats.sizeBytes,
    };
  }
  const filePath = path.join(params.workspacePath, params.fileName);
  const stats = params.stats ?? getGatewayAdminAgentMarkdownFileStats(filePath);
  return {
    name: params.fileName,
    path: filePath,
    exists: stats.exists,
    updatedAt: stats.updatedAt,
    sizeBytes: stats.sizeBytes,
  };
}

function getGatewayAdminAgentMarkdownFilePresenceStats(
  workspacePath: string,
): Record<AdminAgentLocalMarkdownFileName, GatewayAdminAgentMarkdownFileStats> {
  const entriesByName = new Map<string, fs.Dirent>();
  try {
    for (const entry of fs.readdirSync(workspacePath, {
      withFileTypes: true,
    })) {
      entriesByName.set(entry.name, entry);
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      throw error;
    }
  }

  return ADMIN_AGENT_LOCAL_MARKDOWN_FILES.reduce(
    (statsByName, fileName) => {
      const entry = entriesByName.get(fileName);
      statsByName[fileName] = {
        exists: entry?.isFile() ?? false,
        updatedAt: null,
        sizeBytes: null,
      };
      return statsByName;
    },
    {} as Record<
      AdminAgentLocalMarkdownFileName,
      GatewayAdminAgentMarkdownFileStats
    >,
  );
}

function mapGatewayAdminAgent(
  agent: AgentConfig,
  options?: {
    resolvedAgent?: AgentConfig;
    workspacePath?: string;
    markdownFileStats?: Partial<
      Record<
        AdminAgentLocalMarkdownFileName,
        GatewayAdminAgentMarkdownFileStats
      >
    >;
    markdownFileOverrides?: Partial<
      Record<AdminAgentMarkdownFileName, GatewayAdminAgentMarkdownFile>
    >;
  },
): GatewayAdminAgent {
  const resolved = options?.resolvedAgent ?? resolveAgentConfig(agent.id);
  const workspacePath =
    options?.workspacePath ?? path.resolve(agentWorkspaceDir(resolved.id));
  return {
    id: resolved.id,
    name: resolved.name || null,
    emptyChatHeader: resolved.emptyChatHeader || null,
    model: resolveAgentModel(resolved) || null,
    skills: Array.isArray(resolved.skills) ? [...resolved.skills] : null,
    chatbotId: resolved.chatbotId || null,
    enableRag:
      typeof resolved.enableRag === 'boolean' ? resolved.enableRag : null,
    ...(resolved.proxy
      ? { proxy: mapGatewayAdminAgentProxyConfig(resolved.proxy) }
      : {}),
    role: resolved.role || null,
    reportsTo: resolved.reportsTo || null,
    delegatesTo: Array.isArray(resolved.delegatesTo)
      ? [...resolved.delegatesTo]
      : null,
    peers: Array.isArray(resolved.peers) ? [...resolved.peers] : null,
    workspace: resolved.workspace || null,
    workspacePath,
    markdownFiles: ADMIN_AGENT_MARKDOWN_FILES.map(
      (fileName) =>
        options?.markdownFileOverrides?.[fileName] ||
        mapGatewayAdminAgentMarkdownFile({
          agentId: resolved.id,
          workspacePath,
          fileName,
          stats: isGatewayAdminLocalMarkdownFileName(fileName)
            ? options?.markdownFileStats?.[fileName]
            : undefined,
        }),
    ),
  };
}

function mapGatewayAdminAgentProxyConfig(
  proxy: AgentConfig['proxy'],
): GatewayAdminAgent['proxy'] {
  if (!proxy) return null;
  if (proxy.apiKey.source !== 'store') return null;
  return {
    kind: 'hybridai',
    baseUrl: proxy.baseUrl,
    chatbotId: proxy.chatbotId,
    apiKey: {
      source: 'store',
      id: proxy.apiKey.id,
    },
    ...(proxy.conversationScope
      ? { conversationScope: proxy.conversationScope }
      : {}),
  };
}

function readGatewayAdminAgentMarkdownFileState(
  filePath: string,
  stats = getGatewayAdminAgentMarkdownFileStats(filePath),
): GatewayAdminAgentMarkdownFileState {
  if (!stats.exists) {
    return {
      ...stats,
      content: '',
    };
  }
  if (
    typeof stats.sizeBytes === 'number' &&
    stats.sizeBytes > ADMIN_AGENT_MARKDOWN_MAX_BYTES
  ) {
    throw new Error(
      `Markdown file is too large to edit in the admin console (${stats.sizeBytes} bytes, limit ${ADMIN_AGENT_MARKDOWN_MAX_BYTES}).`,
    );
  }
  return {
    ...stats,
    content: fs.readFileSync(filePath, 'utf-8'),
  };
}

function readGatewayAdminSharedMemoryFileState(
  agentId: string,
  spec: AdminAgentSharedMemoryFile,
): GatewayAdminAgentMarkdownFileState {
  const file = getGatewayAdminSharedMemoryFile(agentId, spec);
  if (!file) {
    return {
      exists: false,
      updatedAt: null,
      sizeBytes: null,
      content: '',
    };
  }
  return {
    exists: true,
    updatedAt: null,
    sizeBytes: Buffer.byteLength(file.content, 'utf-8'),
    content: file.content,
  };
}

function getGatewayAdminAgentMarkdownContentSize(content: string): number {
  return Buffer.byteLength(content, 'utf-8');
}

function assertGatewayAdminAgentMarkdownContentSize(
  content: string,
  errorPrefix = 'Markdown content',
): number {
  const sizeBytes = getGatewayAdminAgentMarkdownContentSize(content);
  if (sizeBytes > ADMIN_AGENT_MARKDOWN_MAX_BYTES) {
    throw new Error(
      `${errorPrefix} exceeds the ${ADMIN_AGENT_MARKDOWN_MAX_BYTES}-byte admin editor limit.`,
    );
  }
  return sizeBytes;
}

function writeGatewayAdminAgentMarkdownFileContent(
  filePath: string,
  content: string,
  options?: {
    sizeBytes?: number;
  },
): GatewayAdminAgentMarkdownFileStats {
  if (typeof options?.sizeBytes !== 'number') {
    assertGatewayAdminAgentMarkdownContentSize(content);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath);
  return getGatewayAdminAgentMarkdownFileStats(filePath);
}

function buildGatewayAdminAgentMarkdownFileResponse(params: {
  resolved: ReturnType<typeof resolveGatewayAdminAgentMarkdownFile>;
  fileState?: GatewayAdminAgentMarkdownFileState;
  revisions?: GatewayAdminAgentMarkdownRevision[];
}): GatewayAdminAgentMarkdownFileResponse {
  const fileState =
    params.fileState ??
    (params.resolved.sharedMemoryFile
      ? readGatewayAdminSharedMemoryFileState(
          params.resolved.resolvedAgent.id,
          params.resolved.sharedMemoryFile,
        )
      : readGatewayAdminAgentMarkdownFileState(params.resolved.filePath));
  const mappedFile = mapGatewayAdminAgentMarkdownFile({
    agentId: params.resolved.resolvedAgent.id,
    workspacePath: params.resolved.workspacePath,
    fileName: params.resolved.fileName,
    stats: fileState,
  });
  const markdownFileOverrides: Partial<
    Record<AdminAgentMarkdownFileName, GatewayAdminAgentMarkdownFile>
  > = {
    [params.resolved.fileName]: mappedFile,
  };
  const markdownFileStats = getGatewayAdminAgentMarkdownFilePresenceStats(
    params.resolved.workspacePath,
  );
  return {
    agent: mapGatewayAdminAgent(params.resolved.agent, {
      resolvedAgent: params.resolved.resolvedAgent,
      workspacePath: params.resolved.workspacePath,
      markdownFileStats,
      markdownFileOverrides,
    }),
    file: {
      ...mappedFile,
      content: fileState.content,
      revisions:
        params.revisions ??
        (params.resolved.sharedMemoryFile
          ? []
          : listGatewayAdminAgentMarkdownRevisions({
              workspacePath: params.resolved.workspacePath,
              fileName: params.resolved
                .fileName as AdminAgentLocalMarkdownFileName,
            })),
    },
  };
}

function getGatewayAdminAgentMarkdownRevisionDir(params: {
  workspacePath: string;
  fileName: AdminAgentLocalMarkdownFileName;
}): string {
  return path.join(
    path.dirname(params.workspacePath),
    ADMIN_AGENT_MARKDOWN_REVISIONS_DIRNAME,
    params.fileName,
  );
}

function buildGatewayAdminAgentMarkdownRevision(params: {
  fileName: AdminAgentLocalMarkdownFileName;
  content: string;
  source: GatewayAdminAgentMarkdownRevision['source'];
}): StoredAdminAgentMarkdownRevision {
  const now = new Date();
  const sizeBytes = assertGatewayAdminAgentMarkdownContentSize(
    params.content,
    'Markdown revision content',
  );
  return {
    id: randomUUID(),
    fileName: params.fileName,
    createdAt: now.toISOString(),
    sizeBytes,
    sha256: createHash('sha256').update(params.content).digest('hex'),
    source: params.source,
    content: params.content,
  };
}

function buildGatewayAdminAgentMarkdownRevisionEntryName(
  revision: Pick<StoredAdminAgentMarkdownRevision, 'createdAt' | 'id'>,
): string {
  const createdAtMs = Date.parse(revision.createdAt);
  const timestampPrefix = Number.isFinite(createdAtMs)
    ? createdAtMs.toString(36)
    : '0';
  return `${timestampPrefix}-${revision.id}.json`;
}

function getGatewayAdminAgentMarkdownRevisionContentPath(
  revisionPath: string,
): string {
  return `${revisionPath.slice(0, -'.json'.length)}.md`;
}

function writeGatewayAdminAgentMarkdownRevision(params: {
  workspacePath: string;
  fileName: AdminAgentLocalMarkdownFileName;
  content: string;
  source: GatewayAdminAgentMarkdownRevision['source'];
}): GatewayAdminAgentMarkdownRevision {
  const revision = buildGatewayAdminAgentMarkdownRevision(params);
  const revisionDir = getGatewayAdminAgentMarkdownRevisionDir(params);
  fs.mkdirSync(revisionDir, { recursive: true });
  const revisionPath = path.join(
    revisionDir,
    buildGatewayAdminAgentMarkdownRevisionEntryName(revision),
  );
  const contentPath =
    getGatewayAdminAgentMarkdownRevisionContentPath(revisionPath);
  const metadata: StoredAdminAgentMarkdownRevisionMetadata = {
    id: revision.id,
    fileName: revision.fileName,
    createdAt: revision.createdAt,
    sizeBytes: revision.sizeBytes,
    sha256: revision.sha256,
    source: revision.source,
  };
  const tempContentPath = `${contentPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tempContentPath, revision.content, 'utf-8');
  fs.renameSync(tempContentPath, contentPath);
  const tempMetadataPath = `${revisionPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(
    tempMetadataPath,
    JSON.stringify(metadata, null, 2),
    'utf-8',
  );
  fs.renameSync(tempMetadataPath, revisionPath);
  trimGatewayAdminAgentMarkdownRevisions(params);
  return metadata;
}

function readGatewayAdminAgentMarkdownRevisionMetadataRecord(
  revisionPath: string,
): StoredAdminAgentMarkdownRevisionMetadata | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(revisionPath, 'utf-8'),
    ) as Partial<StoredAdminAgentMarkdownRevisionMetadata>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.fileName !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.sizeBytes !== 'number' ||
      typeof parsed.sha256 !== 'string' ||
      (parsed.source !== 'save' && parsed.source !== 'restore')
    ) {
      return null;
    }
    return {
      id: parsed.id,
      fileName: normalizeGatewayAdminAgentLocalMarkdownFileName(
        parsed.fileName,
      ),
      createdAt: parsed.createdAt,
      sizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256,
      source: parsed.source,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return null;
    }
    logger.warn({ revisionPath, error }, 'Failed to read markdown revision');
    return null;
  }
}

function readGatewayAdminAgentMarkdownRevisionRecord(
  revisionPath: string,
): StoredAdminAgentMarkdownRevision | null {
  const metadata =
    readGatewayAdminAgentMarkdownRevisionMetadataRecord(revisionPath);
  if (!metadata) {
    return null;
  }
  const contentPath =
    getGatewayAdminAgentMarkdownRevisionContentPath(revisionPath);
  try {
    return {
      ...metadata,
      content: fs.readFileSync(contentPath, 'utf-8'),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.warn({ contentPath, error }, 'Failed to read markdown revision');
      return null;
    }
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(revisionPath, 'utf-8'),
    ) as Partial<StoredAdminAgentMarkdownRevision>;
    if (typeof parsed.content !== 'string') {
      return null;
    }
    return {
      ...metadata,
      content: parsed.content,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return null;
    }
    logger.warn({ revisionPath, error }, 'Failed to read markdown revision');
    return null;
  }
}

function getGatewayAdminAgentMarkdownRevisionEntryTimestamp(
  entry: string,
): number {
  const [revisionId] = entry.split('.json', 1);
  const [encodedTimestamp] = revisionId.split('-', 1);
  const timestamp = Number.parseInt(encodedTimestamp, 36);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function compareGatewayAdminAgentMarkdownRevisionEntries(
  left: string,
  right: string,
): number {
  const byTimestamp =
    getGatewayAdminAgentMarkdownRevisionEntryTimestamp(right) -
    getGatewayAdminAgentMarkdownRevisionEntryTimestamp(left);
  if (Number.isFinite(byTimestamp) && byTimestamp !== 0) {
    return byTimestamp;
  }
  return right.localeCompare(left);
}

function listGatewayAdminAgentMarkdownRevisionEntries(params: {
  workspacePath: string;
  fileName: AdminAgentLocalMarkdownFileName;
}): { revisionDir: string; entries: string[] } {
  const revisionDir = getGatewayAdminAgentMarkdownRevisionDir(params);
  let entries: string[];
  try {
    entries = fs.readdirSync(revisionDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return {
        revisionDir,
        entries: [],
      };
    }
    throw error;
  }
  return {
    revisionDir,
    entries: entries
      .filter((entry) => entry.endsWith('.json'))
      .sort(compareGatewayAdminAgentMarkdownRevisionEntries),
  };
}

function trimGatewayAdminAgentMarkdownRevisions(params: {
  workspacePath: string;
  fileName: AdminAgentLocalMarkdownFileName;
}): void {
  const { revisionDir, entries } =
    listGatewayAdminAgentMarkdownRevisionEntries(params);
  for (const entry of entries.slice(ADMIN_AGENT_MARKDOWN_MAX_REVISIONS)) {
    const revisionPath = path.join(revisionDir, entry);
    const contentPath =
      getGatewayAdminAgentMarkdownRevisionContentPath(revisionPath);
    for (const targetPath of [revisionPath, contentPath]) {
      try {
        fs.unlinkSync(targetPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
          continue;
        }
        logger.warn(
          { revisionDir, entry, targetPath, error },
          'Failed to trim markdown revision',
        );
      }
    }
  }
}

function listGatewayAdminAgentMarkdownRevisions(params: {
  workspacePath: string;
  fileName: AdminAgentLocalMarkdownFileName;
}): GatewayAdminAgentMarkdownRevision[] {
  const { revisionDir, entries } =
    listGatewayAdminAgentMarkdownRevisionEntries(params);
  const revisions: Array<
    StoredAdminAgentMarkdownRevisionMetadata & { createdAtMs: number }
  > = [];
  for (const entry of entries) {
    if (revisions.length >= ADMIN_AGENT_MARKDOWN_MAX_REVISIONS) {
      break;
    }
    const record = readGatewayAdminAgentMarkdownRevisionMetadataRecord(
      path.join(revisionDir, entry),
    );
    if (!record || record.fileName !== params.fileName) {
      continue;
    }
    revisions.push({
      ...record,
      createdAtMs: Date.parse(record.createdAt),
    });
  }
  return revisions
    .sort((left, right) => {
      const byCreatedAt = right.createdAtMs - left.createdAtMs;
      if (Number.isFinite(byCreatedAt) && byCreatedAt !== 0) {
        return byCreatedAt;
      }
      return right.id.localeCompare(left.id);
    })
    .map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      source: entry.source,
    }));
}

function normalizeGatewayAdminAgentMarkdownRevisionId(value: string): string {
  const revisionId = value.trim();
  if (!revisionId) {
    throw new Error('Revision id is required.');
  }
  if (!/^[A-Za-z0-9-]+$/.test(revisionId)) {
    throw new Error('Revision id is invalid.');
  }
  return revisionId;
}

function getGatewayAdminAgentMarkdownRevisionRecord(params: {
  workspacePath: string;
  fileName: AdminAgentLocalMarkdownFileName;
  revisionId: string;
}): StoredAdminAgentMarkdownRevision {
  const revisionId = normalizeGatewayAdminAgentMarkdownRevisionId(
    params.revisionId,
  );
  const { revisionDir, entries } =
    listGatewayAdminAgentMarkdownRevisionEntries(params);
  const revisionEntry = entries.find(
    (entry) =>
      entry === `${revisionId}.json` || entry.endsWith(`-${revisionId}.json`),
  );
  if (!revisionEntry) {
    throw new Error(`Revision "${revisionId}" was not found.`);
  }
  const revisionPath = path.join(revisionDir, revisionEntry);
  const record = readGatewayAdminAgentMarkdownRevisionRecord(revisionPath);
  if (!record || record.fileName !== params.fileName) {
    throw new Error(`Revision "${revisionId}" was not found.`);
  }
  return record;
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

async function getGatewayStatusForModelSubcommand(
  subcommand: string | undefined,
): Promise<GatewayStatus> {
  if (subcommand === 'list' || subcommand === 'info') {
    // These commands are expected to reflect the current live provider state,
    // not a recently cached health snapshot.
    invalidateGatewayProviderHealth();
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
  return getModelCatalogMetadata(model).contextWindow;
}

function resolveDisplayedModelName(model: string): string {
  const normalized = String(model || '').trim();
  if (!normalized) return normalized;
  if (normalized.toLowerCase().startsWith('mistral/')) {
    return resolveDiscoveredMistralModelCanonicalName(normalized);
  }
  return normalized;
}

function resolveRequestedCatalogModelName(
  rawModelName: string,
  availableModels: string[],
): string {
  const requested = resolveDisplayedModelName(
    String(rawModelName || '').trim(),
  );
  if (!requested) return requested;
  if (availableModels.includes(requested)) {
    return requested;
  }

  const legacyHybridAIModel = resolveDisplayedModelName(
    normalizeHybridAIModelForRuntime(requested),
  );
  if (availableModels.includes(legacyHybridAIModel)) {
    return legacyHybridAIModel;
  }

  const hybridAICatalogModel = resolveDisplayedModelName(
    formatHybridAIModelForCatalog(legacyHybridAIModel),
  );
  if (availableModels.includes(hybridAICatalogModel)) {
    return hybridAICatalogModel;
  }

  const matchingHybridAIModels = availableModels.filter((model) => {
    const normalized = String(model || '')
      .trim()
      .toLowerCase();
    if (!normalized.startsWith('hybridai/')) return false;
    const upstreamModel = stripHybridAIModelPrefix(model);
    return (
      resolveDisplayedModelName(upstreamModel) === legacyHybridAIModel ||
      resolveDisplayedModelName(upstreamModel.split('/').at(-1) || '') ===
        legacyHybridAIModel
    );
  });
  if (matchingHybridAIModels.length === 1) {
    return matchingHybridAIModels[0];
  }

  return requested;
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
    taskCount: getAllJobs({
      kind: 'scheduled_task',
      sessionId: session.id,
    }).length,
    createdAt: session.created_at,
    lastActive: session.last_active,
  };
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

function parseTurnTraceSelectorFlag(args: readonly unknown[]): {
  selector: AuditTurnTraceSelector | null;
  error: string | null;
} {
  const selector: AuditTurnTraceSelector = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = parseLowerArg(args, index);
    if (!arg) continue;
    if (arg === '--last' || arg === '--latest') {
      selector.latest = true;
      continue;
    }
    if (arg === '--turn') {
      const turnIndex = parseIntegerArg(args, index + 1);
      if (!turnIndex || turnIndex < 1) {
        return {
          selector: null,
          error: 'Expected a positive turn number after `--turn`.',
        };
      }
      selector.turnIndex = turnIndex;
      index += 1;
      continue;
    }
    if (arg === '--run') {
      const runId = parseIdArg(args, index + 1);
      if (!runId) {
        return { selector: null, error: 'Expected a run id after `--run`.' };
      }
      selector.runId = runId;
      index += 1;
      continue;
    }
    return {
      selector: null,
      error: `Unknown trace selector option \`${parseIdArg(args, index)}\`.`,
    };
  }

  const selectedSelectorCount = [
    selector.latest,
    selector.runId,
    selector.turnIndex != null,
  ].filter(Boolean).length;
  if (selectedSelectorCount > 1) {
    return {
      selector: null,
      error: 'Use only one of `--last`, `--turn`, or `--run`.',
    };
  }
  return {
    selector:
      selector.latest || selector.runId || selector.turnIndex != null
        ? selector
        : null,
    error: null,
  };
}

function parseAuditTraceCommand(
  args: readonly unknown[],
  currentSessionId: string,
): {
  targetSessionId: string;
  selector: AuditTurnTraceSelector | null;
  error: string | null;
  recentOnly: boolean;
} {
  const first = parseLowerArg(args, 1);
  if (!first) {
    return {
      targetSessionId: currentSessionId,
      selector: null,
      error: null,
      recentOnly: true,
    };
  }
  if (first === 'last') {
    return {
      targetSessionId: currentSessionId,
      selector: { latest: true },
      error: null,
      recentOnly: false,
    };
  }
  if (first === 'turn') {
    const turnIndex = parseIntegerArg(args, 2);
    return {
      targetSessionId: currentSessionId,
      selector: turnIndex && turnIndex > 0 ? { turnIndex } : null,
      error: turnIndex && turnIndex > 0 ? null : 'Usage: `audit turn <n>`',
      recentOnly: false,
    };
  }
  if (first === 'run') {
    const runId = parseIdArg(args, 2);
    return {
      targetSessionId: currentSessionId,
      selector: runId ? { runId } : null,
      error: runId ? null : 'Usage: `audit run <runId>`',
      recentOnly: false,
    };
  }

  const targetSessionId = parseIdArg(args, 1) || currentSessionId;
  const parsed = parseTurnTraceSelectorFlag(args.slice(2));
  return {
    targetSessionId,
    selector: parsed.selector,
    error: parsed.error,
    recentOnly: !parsed.selector && !parsed.error,
  };
}

function parseExportTraceTarget(
  args: readonly unknown[],
  currentSessionId: string,
): {
  targetSessionId: string;
  exportAll: boolean;
  selector: AuditTurnTraceSelector | null;
  error: string | null;
} {
  const first = parseIdArg(args, 2);
  const firstLower = first.toLowerCase();
  if (firstLower === 'all' || firstLower === '--all') {
    const parsed = parseTurnTraceSelectorFlag(args.slice(3));
    if (parsed.selector) {
      return {
        targetSessionId: '',
        exportAll: false,
        selector: null,
        error: '`export trace all` does not support turn selectors.',
      };
    }
    return {
      targetSessionId: '',
      exportAll: true,
      selector: null,
      error: parsed.error,
    };
  }

  const hasLeadingSelector =
    first === '--last' ||
    first === '--latest' ||
    first === '--turn' ||
    first === '--run';
  const targetSessionId = hasLeadingSelector
    ? currentSessionId
    : first || currentSessionId;
  const selectorArgs = hasLeadingSelector ? args.slice(2) : args.slice(3);
  const parsed = parseTurnTraceSelectorFlag(selectorArgs);
  return {
    targetSessionId,
    exportAll: false,
    selector: parsed.selector,
    error: parsed.error,
  };
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

function formatThroughput(throughput: number): string {
  const rounded =
    throughput >= 100
      ? Math.round(throughput)
      : Math.round(throughput * 10) / 10;
  return String(rounded);
}

function formatTokensPerSecond(value: number | null): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value))
    return 'n/a tok/s';
  return `${formatThroughput(value)} tok/s`;
}

function formatPerformanceTokensPerSecond(
  value: number | null,
  stddev: number | null,
): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return 'n/a';
  }
  const stddevLabel =
    stddev != null && Number.isFinite(stddev)
      ? formatThroughput(Math.max(0, stddev))
      : 'n/a';
  return `${formatTokensPerSecond(value)} (± ${stddevLabel})`;
}

function isLocalModelProvider(model: string | null | undefined): boolean {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  const provider = normalized.split('/', 1)[0] || '';
  return (
    provider === 'ollama' ||
    provider === 'lmstudio' ||
    provider === 'llamacpp' ||
    provider === 'vllm'
  );
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

function resolveModelCostLabel(params: {
  model: string;
  promptTokens: number;
  completionTokens: number;
}): string | null {
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  if (pricing.input == null && pricing.output == null) return null;
  const inputCost =
    pricing.input == null ? 0 : params.promptTokens * pricing.input;
  const outputCost =
    pricing.output == null ? 0 : params.completionTokens * pricing.output;
  return formatUsd(inputCost + outputCost);
}

function resolveSessionAgentId(session: { agent_id: string }): string {
  const sessionAgent = session.agent_id?.trim();
  if (sessionAgent) return sessionAgent;
  return resolveDefaultAgentId(getRuntimeConfig());
}

const MEMORY_INSPECT_FILE_PREVIEW_MAX_CHARS = 280;
const MEMORY_INSPECT_MESSAGE_PREVIEW_MAX_CHARS = 140;
const MEMORY_INSPECT_SEMANTIC_PREVIEW_MAX_CHARS = 180;
const MEMORY_INSPECT_RECENT_MESSAGE_LIMIT = 4;
const MEMORY_INSPECT_RECENT_SEMANTIC_LIMIT = 3;
const MEMORY_INSPECT_CANONICAL_WINDOW = 12;
const MEMORY_INSPECT_CANONICAL_PREVIEW_LIMIT = 3;

function formatInspectionTimestamp(raw: string | null | undefined): string {
  const value = String(raw || '').trim();
  if (!value) return 'none';
  return `${formatDisplayTimestamp(value)} (${formatRelativeTime(value)})`;
}

function readInspectionFilePreview(filePath: string): {
  exists: boolean;
  chars: number;
  preview: string | null;
} {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        exists: false,
        chars: 0,
        preview: null,
      };
    }
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    return {
      exists: true,
      chars: content.length,
      preview: content
        ? abbreviateForUser(content, MEMORY_INSPECT_FILE_PREVIEW_MAX_CHARS)
        : '(empty)',
    };
  } catch {
    return {
      exists: false,
      chars: 0,
      preview: null,
    };
  }
}

function formatMemoryInspectMessage(message: {
  role: string;
  content: string;
}): string {
  return `- ${String(message.role || 'unknown')
    .trim()
    .toLowerCase()}: ${abbreviateForUser(
    String(message.content || ''),
    MEMORY_INSPECT_MESSAGE_PREVIEW_MAX_CHARS,
  )}`;
}

function formatMemoryInspectSemanticEntry(entry: {
  id: number;
  source: string;
  scope: string;
  confidence: number;
  content: string;
}): string {
  return `- [${entry.id}] ${entry.source}/${entry.scope} ${Math.round(
    Math.max(0, Math.min(1, entry.confidence)) * 100,
  )}%: ${abbreviateForUser(
    entry.content,
    MEMORY_INSPECT_SEMANTIC_PREVIEW_MAX_CHARS,
  )}`;
}

function formatMemoryInspectCanonicalEntry(entry: {
  role: string;
  content: string;
  session_id: string;
}): string {
  return `- ${String(entry.role || 'unknown')
    .trim()
    .toLowerCase()} [${entry.session_id}]: ${abbreviateForUser(
    entry.content,
    MEMORY_INSPECT_MESSAGE_PREVIEW_MAX_CHARS,
  )}`;
}

function resolveWorkspaceTodayMemoryNote(workspacePath: string): {
  timezone: string | null;
  fileName: string;
  filePath: string;
} {
  const userPath = path.join(workspacePath, 'USER.md');
  let timezone: string | null = null;
  try {
    if (fs.existsSync(userPath)) {
      timezone =
        extractUserTimezone(fs.readFileSync(userPath, 'utf-8')) || null;
    }
  } catch {
    timezone = null;
  }
  const dateStamp = currentDateStampInTimezone(timezone || undefined);
  const fileName = `memory/${dateStamp}.md`;
  return {
    timezone,
    fileName,
    filePath: path.join(workspacePath, fileName),
  };
}

function buildMemoryInspectReport(params: { session: Session }): string {
  const targetSession = params.session;
  const agentId = resolveSessionAgentId(targetSession);
  const workspacePath = path.resolve(agentWorkspaceDir(agentId));
  const memoryFilePath = path.join(workspacePath, 'MEMORY.md');
  const memoryFile = readInspectionFilePreview(memoryFilePath);
  const todayNote = resolveWorkspaceTodayMemoryNote(workspacePath);
  const todayNotePreview = readInspectionFilePreview(todayNote.filePath);
  const transcriptPath = path.join(
    workspacePath,
    '.session-transcripts',
    `${targetSession.id}.jsonl`,
  );
  const recentMessages = memoryService.getRecentMessages(
    targetSession.id,
    MEMORY_INSPECT_RECENT_MESSAGE_LIMIT,
  );
  const summaryText = String(targetSession.session_summary || '').trim();
  const recentSemantic = listSemanticMemoriesForSession(
    targetSession.id,
    MEMORY_INSPECT_RECENT_SEMANTIC_LIMIT,
  );
  const canonicalScope = resolveCanonicalContextScope(targetSession);
  const canonicalContext = canonicalScope
    ? memoryService.getCanonicalContext({
        agentId,
        userId: canonicalScope,
        windowSize: MEMORY_INSPECT_CANONICAL_WINDOW,
        excludeSessionId: targetSession.id,
      })
    : { summary: null, recent_messages: [] };
  const canonicalPreview = canonicalContext.recent_messages.slice(
    -MEMORY_INSPECT_CANONICAL_PREVIEW_LIMIT,
  );

  return [
    `Session: ${targetSession.id}`,
    `Agent: ${agentId}`,
    `Workspace: ${workspacePath}`,
    `Session key: ${targetSession.session_key || '(none)'}`,
    `Main session key: ${targetSession.main_session_key || '(none)'}`,
    '',
    '1. Workspace memory file (`MEMORY.md`)',
    `Present: ${memoryFile.exists ? 'yes' : 'no'}`,
    `Path: ${memoryFilePath}`,
    `Chars: ${memoryFile.exists ? formatCompactNumber(memoryFile.chars) : '0'}`,
    `Preview: ${memoryFile.preview || '(missing)'}`,
    '',
    `2. Workspace daily note for today (\`${todayNote.fileName}\`)`,
    `Present: ${todayNotePreview.exists ? 'yes' : 'no'}`,
    `Timezone: ${todayNote.timezone || 'local default'}`,
    `Path: ${todayNote.filePath}`,
    `Chars: ${todayNotePreview.exists ? formatCompactNumber(todayNotePreview.chars) : '0'}`,
    `Preview: ${todayNotePreview.preview || '(missing)'}`,
    '',
    '3. Raw session history',
    `Active messages: ${formatCompactNumber(targetSession.message_count)}`,
    `Transcript mirror: ${fs.existsSync(transcriptPath) ? transcriptPath : '(missing)'}`,
    `Recent tail (${recentMessages.length}):`,
    ...(recentMessages.length > 0
      ? recentMessages.map(formatMemoryInspectMessage)
      : ['- (none)']),
    '',
    '4. Compacted session summary',
    `Stored: ${summaryText ? 'yes' : 'no'}`,
    `Compactions: ${formatCompactNumber(targetSession.compaction_count)}`,
    `Summary updated: ${formatInspectionTimestamp(targetSession.summary_updated_at)}`,
    `Last memory flush: ${formatInspectionTimestamp(targetSession.memory_flush_at)}`,
    `Preview: ${
      summaryText
        ? abbreviateForUser(summaryText, MEMORY_INSPECT_FILE_PREVIEW_MAX_CHARS)
        : '(none)'
    }`,
    '',
    '5. Semantic memory store',
    'Prompt behavior: query-matched only; stored rows are not injected wholesale.',
    `Recent stored entries (${recentSemantic.length} shown):`,
    ...(recentSemantic.length > 0
      ? recentSemantic.map(formatMemoryInspectSemanticEntry)
      : ['- (none)']),
    '',
    '6. Canonical cross-channel memory',
    `Scope: ${canonicalScope || '(none)'}`,
    `Prompt-time summary present: ${canonicalContext.summary ? 'yes' : 'no'}`,
    `Summary preview: ${
      canonicalContext.summary
        ? abbreviateForUser(
            canonicalContext.summary,
            MEMORY_INSPECT_FILE_PREVIEW_MAX_CHARS,
          )
        : '(none)'
    }`,
    `Prompt-time recent messages from other sessions: ${formatCompactNumber(
      canonicalContext.recent_messages.length,
    )}`,
    ...(canonicalPreview.length > 0
      ? canonicalPreview.map(formatMemoryInspectCanonicalEntry)
      : ['- (none)']),
  ].join('\n');
}

function formatMemoryQueryCitation(
  citation: MemoryCitation,
  memory: SemanticMemoryEntry | undefined,
): string {
  return `- ${citation.ref} -> memory ${citation.memoryId} (${Math.round(
    Math.max(0, Math.min(1, citation.confidence)) * 100,
  )}%): ${abbreviateForUser(
    memory?.content || citation.content,
    MEMORY_INSPECT_SEMANTIC_PREVIEW_MAX_CHARS,
  )}`;
}

function buildMemoryQueryReport(params: {
  session: Session;
  query: string;
}): string {
  const targetSession = params.session;
  const query = params.query.trim();
  const promptContext = memoryService.buildPromptMemoryContext({
    session: targetSession,
    query,
    touchSemanticRecall: false,
  });
  const summaryText = String(targetSession.session_summary || '').trim();
  const summaryIncluded = summaryText
    ? Boolean(promptContext.promptSummary?.includes(summaryText))
    : false;
  const promptSummary =
    promptContext.promptSummary || '(nothing would be attached)';

  return [
    `Session: ${targetSession.id}`,
    `Query: ${query}`,
    'Mode: read-only diagnostic (matches prompt assembly without updating semantic recall access metadata)',
    `Stored session summary: ${summaryText ? 'yes' : 'no'}`,
    `Summary included: ${summaryText ? (summaryIncluded ? 'yes' : 'no') : 'n/a'}`,
    `Summary confidence: ${
      promptContext.summaryConfidence == null
        ? 'n/a'
        : `${Math.round(Math.max(0, Math.min(1, promptContext.summaryConfidence)) * 100)}%`
    }`,
    `Semantic matches attached: ${formatCompactNumber(
      promptContext.semanticMemories.length,
    )}`,
    `Semantic prompt hard cap: ${formatCompactNumber(
      getRuntimeConfig().memory.semanticPromptHardCap,
    )}`,
    '',
    'Matched semantic memories:',
    ...(promptContext.citationIndex.length > 0
      ? promptContext.citationIndex.map((citation, index) =>
          formatMemoryQueryCitation(
            citation,
            promptContext.semanticMemories[index],
          ),
        )
      : ['- (none)']),
    '',
    'Exact attached block:',
    promptSummary,
  ].join('\n');
}

type TraceExportResult = Awaited<
  ReturnType<typeof exportSessionTraceAtifJsonl>
>;

async function exportTraceForSession(
  session: Session,
  selector?: AuditTurnTraceSelector | null,
): Promise<TraceExportResult> {
  return exportSessionTraceAtifJsonl({
    agentId: resolveSessionAgentId(session),
    session,
    messages: memoryService.getRecentMessages(session.id),
    auditEntries: getStructuredAuditForSession(session.id),
    usageTotals: getSessionUsageTotals(session.id),
    selector,
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

export function getGatewayAssistantPresentationForMessageAgent(
  agentId?: string | null,
): GatewayAssistantPresentation | undefined {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) {
    return undefined;
  }
  return getGatewayAssistantPresentationForAgent(normalizedAgentId);
}

export function extractUsageCostUsd(tokenUsage?: TokenUsageStats): number {
  return extractExplicitUsageCostUsd(tokenUsage) ?? 0;
}

function buildHybridAIAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const status = getHybridAIAuthStatus();
  return [
    `Authenticated: ${status.authenticated ? 'yes' : 'no'}`,
    ...(status.authenticated
      ? [`Source: ${status.source}`, 'API key: configured']
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

function resolveRuntimeCredentialStatus(
  storedSecretName: string,
  envValues: Array<string | undefined>,
  storedValue?: string,
): {
  value: string;
  source: 'env' | 'runtime-secrets' | null;
} {
  const resolvedStoredValue =
    typeof storedValue === 'string'
      ? storedValue.trim()
      : readStoredRuntimeSecret(storedSecretName);
  const envValue =
    envValues
      .map((value) => String(value || '').trim())
      .find((value) => value.length > 0) || '';
  const source = envValue
    ? resolvedStoredValue && envValue === resolvedStoredValue
      ? 'runtime-secrets'
      : 'env'
    : resolvedStoredValue
      ? 'runtime-secrets'
      : null;
  return {
    value: envValue || resolvedStoredValue || '',
    source,
  };
}

function resolveGatewayPasswordStatus(params: {
  storedSecretName: string;
  envValues: Array<string | undefined>;
  configValue: string;
  storedValue?: string;
}): NonNullable<GatewayStatus['email']> {
  const credential = resolveRuntimeCredentialStatus(
    params.storedSecretName,
    params.envValues,
    params.storedValue,
  );
  if (credential.source) {
    return {
      passwordConfigured: Boolean(credential.value),
      passwordSource: credential.source,
    };
  }

  const configValue = String(params.configValue || '').trim();
  return {
    passwordConfigured: Boolean(configValue),
    passwordSource: configValue ? 'config' : null,
  };
}

function resolveGatewayVoiceAuthStatus(params: {
  envValues: Array<string | undefined>;
  configValue: string;
  storedValue?: string;
}): Pick<
  NonNullable<GatewayStatus['voice']>,
  'authTokenConfigured' | 'authTokenSource'
> {
  const credential = resolveRuntimeCredentialStatus(
    'TWILIO_AUTH_TOKEN',
    params.envValues,
    params.storedValue,
  );
  if (credential.source) {
    return {
      authTokenConfigured: Boolean(credential.value),
      authTokenSource: credential.source,
    };
  }

  const configValue = String(params.configValue || '').trim();
  return {
    authTokenConfigured: Boolean(configValue),
    authTokenSource: configValue ? 'config' : null,
  };
}

function resolveGatewayTokenStatus(params: {
  storedSecretName: string;
  envValues: Array<string | undefined>;
  configValue: string;
  storedValue?: string;
}): NonNullable<GatewayStatus['telegram']> {
  const credential = resolveRuntimeCredentialStatus(
    params.storedSecretName,
    params.envValues,
    params.storedValue,
  );
  if (credential.source) {
    return {
      tokenConfigured: Boolean(credential.value),
      tokenSource: credential.source,
    };
  }

  const configValue = String(params.configValue || '').trim();
  return {
    tokenConfigured: Boolean(configValue),
    tokenSource: configValue ? 'config' : null,
  };
}

function buildOpenRouterAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const credential = resolveRuntimeCredentialStatus('OPENROUTER_API_KEY', [
    OPENROUTER_API_KEY,
  ]);
  return [
    `Authenticated: ${credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value ? ['API key: configured'] : []),
    `Config: ${runtimeConfigPath()}`,
    `Enabled: ${config.openrouter.enabled ? 'yes' : 'no'}`,
    `Base URL: ${config.openrouter.baseUrl}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
    'Catalog: auto-discovered',
  ];
}

function buildMistralAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const credential = resolveRuntimeCredentialStatus('MISTRAL_API_KEY', [
    MISTRAL_API_KEY,
  ]);
  return [
    `Authenticated: ${credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value ? ['API key: configured'] : []),
    `Config: ${runtimeConfigPath()}`,
    `Enabled: ${config.mistral.enabled ? 'yes' : 'no'}`,
    `Base URL: ${config.mistral.baseUrl}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
    'Catalog: auto-discovered',
  ];
}

function buildHuggingFaceAuthStatusLines(): string[] {
  const config = getRuntimeConfig();
  const credential = resolveRuntimeCredentialStatus('HF_TOKEN', [
    HUGGINGFACE_API_KEY,
  ]);
  return [
    `Authenticated: ${credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value ? ['API key: configured'] : []),
    `Config: ${runtimeConfigPath()}`,
    `Enabled: ${config.huggingface.enabled ? 'yes' : 'no'}`,
    `Base URL: ${config.huggingface.baseUrl}`,
    `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
    'Catalog: auto-discovered',
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
          'Access token: configured',
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
    MSTEAMS_APP_PASSWORD,
  ]);
  const appId = MSTEAMS_APP_ID;
  const tenantId = MSTEAMS_TENANT_ID;
  return [
    `Authenticated: ${appId && credential.value ? 'yes' : 'no'}`,
    ...(credential.source ? [`Source: ${credential.source}`] : []),
    ...(credential.value ? ['App password: configured'] : []),
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
  promptMode?: PromptMode;
  runId: string;
  turnIndex: number;
  userId: string;
  username: string | null;
  canonicalScopeId: string;
  userContent: string;
  resultText: string;
  artifacts?: ArtifactMetadata[] | null;
  toolCallCount: number;
  startedAt: number;
  replaceBuiltInMemory?: boolean;
}): {
  userMessageId: number;
  assistantMessageId: number;
} {
  const storedTurn =
    opts.replaceBuiltInMemory === true
      ? {
          userMessageId: memoryService.storeMessage({
            sessionId: opts.sessionId,
            userId: opts.userId,
            username: opts.username,
            role: 'user',
            content: opts.userContent,
          }),
          assistantMessageId: memoryService.storeMessage({
            sessionId: opts.sessionId,
            userId: 'assistant',
            username: null,
            role: 'assistant',
            content: opts.resultText,
            agentId: opts.agentId,
            artifacts: opts.artifacts,
          }),
        }
      : memoryService.storeTurn({
          sessionId: opts.sessionId,
          user: {
            userId: opts.userId,
            username: opts.username,
            content: opts.userContent,
          },
          assistant: {
            userId: 'assistant',
            username: null,
            agentId: opts.agentId,
            content: opts.resultText,
            artifacts: opts.artifacts,
          },
        });
  if (opts.replaceBuiltInMemory !== true) {
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

  if (opts.replaceBuiltInMemory !== true) {
    void maybeCompactSession({
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      chatbotId: opts.chatbotId,
      enableRag: opts.enableRag,
      model: opts.model,
      channelId: opts.channelId,
      promptMode: opts.promptMode,
    }).catch((err) => {
      logger.warn(
        { sessionId: opts.sessionId, err },
        'Background session compaction failed',
      );
    });
  }

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

const SESSION_PRUNE_USAGE =
  'Usage: `sessions prune --older-than <duration> [--dry-run|--confirm]`';
const SESSION_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_PRUNE_SAMPLE_LIMIT = 20;

interface SessionPruneOptions {
  olderThanMs: number;
  olderThanLabel: string;
  confirm: boolean;
}

interface SessionPrunePlan {
  candidates: Array<{
    session: Session;
    lastActiveMs: number;
  }>;
  cutoffMs: number;
  invalidTimestampSkipped: number;
  protectedSkipped: number;
}

function normalizeSessionPruneDuration(
  raw: string,
): { label: string; ms: number } | null {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const match = /^(\d+)(h|hour|hours|d|day|days|w|week|weeks)$/.exec(
    normalized,
  );
  if (!match) return null;

  const count = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const unit = match[2];
  if (unit === 'h' || unit === 'hour' || unit === 'hours') {
    return { label: `${count}h`, ms: count * 60 * 60 * 1000 };
  }
  if (unit === 'd' || unit === 'day' || unit === 'days') {
    return { label: `${count}d`, ms: count * 24 * 60 * 60 * 1000 };
  }
  return { label: `${count}w`, ms: count * 7 * 24 * 60 * 60 * 1000 };
}

function parseSessionPruneOptions(
  args: string[],
): { options: SessionPruneOptions } | { error: string } {
  let olderThan: { label: string; ms: number } | null = null;
  let confirm = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim();
    if (!arg) continue;

    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    let olderThanRaw: string | null = null;
    if (arg.startsWith('--older-than=')) {
      olderThanRaw = arg.slice('--older-than='.length);
    } else if (arg === '--older-than') {
      const next = String(args[index + 1] || '').trim();
      const afterNext = String(args[index + 2] || '').trim();
      if (next && /^\d+$/.test(next) && /^[a-zA-Z]+$/.test(afterNext)) {
        olderThanRaw = `${next}${afterNext}`;
        index += 2;
      } else {
        olderThanRaw = next;
        index += 1;
      }
    }

    if (olderThanRaw != null) {
      const parsed = normalizeSessionPruneDuration(olderThanRaw);
      if (!parsed) {
        return {
          error:
            'Invalid `--older-than` value. Use a duration like `90d`, `12w`, or `48h`.',
        };
      }
      olderThan = parsed;
      continue;
    }

    return { error: `Unknown sessions prune option: ${arg}` };
  }

  if (!olderThan) {
    return { error: 'Missing required `--older-than <duration>` option.' };
  }
  if (olderThan.ms < SESSION_PRUNE_MIN_AGE_MS) {
    return { error: '`--older-than` must be at least 24h.' };
  }
  if (confirm && dryRun) {
    return { error: 'Use either `--dry-run` or `--confirm`, not both.' };
  }

  return {
    options: {
      olderThanMs: olderThan.ms,
      olderThanLabel: olderThan.label,
      confirm,
    },
  };
}

function getSessionPruneProtectionReason(
  session: Session,
  params: {
    activeSessionIds: Set<string>;
    currentSessionId: string;
  },
): string | null {
  if (session.id === params.currentSessionId) return 'current session';
  if (params.activeSessionIds.has(session.id)) return 'active sandbox session';
  if (session.full_auto_enabled) return 'full-auto session';
  if (
    session.id.startsWith('scheduler:') ||
    session.channel_id === 'scheduler'
  ) {
    return 'scheduler session';
  }
  return null;
}

function buildSessionPrunePlan(params: {
  activeSessionIds: Set<string>;
  currentSessionId: string;
  nowMs: number;
  olderThanMs: number;
  sessions: Session[];
}): SessionPrunePlan {
  const cutoffMs = params.nowMs - params.olderThanMs;
  const candidates: SessionPrunePlan['candidates'] = [];
  let invalidTimestampSkipped = 0;
  let protectedSkipped = 0;

  for (const session of params.sessions) {
    const lastActiveMs = parseTimestamp(session.last_active)?.getTime();
    if (!Number.isFinite(lastActiveMs)) {
      invalidTimestampSkipped += 1;
      continue;
    }
    if ((lastActiveMs as number) > cutoffMs) continue;

    if (
      getSessionPruneProtectionReason(session, {
        activeSessionIds: params.activeSessionIds,
        currentSessionId: params.currentSessionId,
      })
    ) {
      protectedSkipped += 1;
      continue;
    }

    candidates.push({
      session,
      lastActiveMs: lastActiveMs as number,
    });
  }

  candidates.sort((left, right) => {
    const byLastActive = left.lastActiveMs - right.lastActiveMs;
    if (byLastActive !== 0) return byLastActive;
    return left.session.id.localeCompare(right.session.id);
  });

  return {
    candidates,
    cutoffMs,
    invalidTimestampSkipped,
    protectedSkipped,
  };
}

function formatSessionPruneSample(plan: SessionPrunePlan): string[] {
  if (plan.candidates.length === 0) return [];
  const shown = plan.candidates.slice(0, SESSION_PRUNE_SAMPLE_LIMIT);
  return [
    '',
    'Oldest matched sessions:',
    ...shown.map(
      ({ session }) =>
        `- ${session.id} — ${formatCompactNumber(session.message_count)} msgs, last: ${formatDisplayTimestamp(session.last_active)}`,
    ),
    ...(plan.candidates.length > shown.length
      ? [
          `...and ${formatCompactNumber(plan.candidates.length - shown.length)} more.`,
        ]
      : []),
  ];
}

function formatSessionPrunePlanLines(
  plan: SessionPrunePlan,
  options: SessionPruneOptions,
): string[] {
  return [
    `Older than: ${options.olderThanLabel}`,
    `Cutoff: before ${formatDisplayTimestamp(new Date(plan.cutoffMs).toISOString())}`,
    `Matched: ${formatCompactNumber(plan.candidates.length)} session${plan.candidates.length === 1 ? '' : 's'}`,
    ...(plan.protectedSkipped > 0
      ? [
          `Protected skipped: ${formatCompactNumber(plan.protectedSkipped)} active/current/full-auto/scheduler session${plan.protectedSkipped === 1 ? '' : 's'}`,
        ]
      : []),
    ...(plan.invalidTimestampSkipped > 0
      ? [
          `Invalid timestamps skipped: ${formatCompactNumber(plan.invalidTimestampSkipped)}`,
        ]
      : []),
  ];
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

function normalizeSecretRouteSecret(
  raw: string,
): RuntimeHttpRequestAuthRuleSecret {
  const value = String(raw || '').trim();
  if (isGoogleOAuthSpecifier(value)) {
    return makeGoogleOAuthSecretRef();
  }
  return { source: 'store', id: value };
}

function isStoreSecretRouteSecret(
  secret: RuntimeHttpRequestAuthRuleSecret,
): secret is { source: 'store'; id: string } {
  return (
    typeof secret === 'object' &&
    secret !== null &&
    !Array.isArray(secret) &&
    secret.source === 'store'
  );
}

function formatRouteSecretLabel(
  secret: RuntimeHttpRequestAuthRuleSecret,
): string {
  if (typeof secret === 'string') return secret;
  if (isGoogleOAuthSecretRef(secret)) return 'google-oauth';
  return `${secret.source}:${secret.id}`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = String(hostname || '')
    .trim()
    .toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function resolveVoiceCommandWebhookUrl(webhookBasePath: string): {
  url?: string;
  error?: string;
} {
  const baseUrl = String(GATEWAY_BASE_URL || '').trim();
  if (!baseUrl) {
    return {
      error:
        'Set `ops.gatewayBaseUrl` to a public URL before using `voice call`.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {
      error: `Configured \`ops.gatewayBaseUrl\` is invalid: ${baseUrl}`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      error: 'Configured `ops.gatewayBaseUrl` must use `http` or `https`.',
    };
  }

  if (isLoopbackHostname(parsed.hostname)) {
    return {
      error:
        'Set `ops.gatewayBaseUrl` to a public tunnel or hostname before using `voice call`; Twilio cannot reach localhost webhooks.',
    };
  }

  const paths = resolveVoiceWebhookPaths(webhookBasePath);
  const normalizedBaseUrl = parsed.toString().replace(/\/+$/, '');
  return {
    url: `${normalizedBaseUrl}${paths.webhookPath}`,
  };
}

function formatHttpRequestAuthRule(
  rule: RuntimeHttpRequestAuthRule,
  index: number,
): string {
  const parsedSecret =
    typeof rule.secret === 'string'
      ? rule.secret
      : isGoogleOAuthSecretRef(rule.secret)
        ? 'google-oauth'
        : typeof rule.secret.id === 'string'
          ? `${rule.secret.source}:${rule.secret.id}`
          : '<invalid>';
  const prefix = rule.prefix ? ` ${rule.prefix}` : '';
  return `${index + 1}. ${rule.urlPrefix} -> ${rule.header}:${prefix} ${parsedSecret}`.trim();
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

function formatAuxiliaryModelPolicy(
  policy: RuntimeAuxiliaryModelPolicyConfig,
): string {
  if (policy.provider === 'disabled') return 'disabled';

  const configuredModel = policy.model.trim();
  const formattedMaxTokens =
    policy.maxTokens > 0
      ? ` (max ${formatCompactNumber(policy.maxTokens)})`
      : '';

  if (!configuredModel) {
    const label =
      policy.provider === 'auto' ? 'auto' : `${policy.provider} default`;
    return `${label}${formattedMaxTokens}`;
  }

  if (policy.provider === 'auto') {
    return `${formatModelForDisplay(configuredModel)}${formattedMaxTokens}`;
  }

  try {
    return `${formatModelForDisplay(
      normalizeAuxiliaryProviderModel({
        provider: policy.provider,
        model: configuredModel,
      }),
    )}${formattedMaxTokens}`;
  } catch {
    return `${formatModelForDisplay(configuredModel)}${formattedMaxTokens}`;
  }
}

function formatAuxiliaryModelLines(config: RuntimeConfig): string[] {
  const configuredAuxiliaryModels = Object.entries(
    config.auxiliaryModels,
  ).filter(([, policy]) => {
    return policy.provider !== 'auto' || policy.model.trim() !== '';
  });

  if (configuredAuxiliaryModels.length === 0) {
    return ['Aux models: auto'];
  }

  return [
    'Aux models:',
    ...configuredAuxiliaryModels.map(([task, policy]) => {
      return `- ${task}: ${formatAuxiliaryModelPolicy(policy)}`;
    }),
  ];
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

export function parseMcpServerConfig(rawJson: string): {
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

  const rawAuth = String(record.auth ?? '')
    .trim()
    .toLowerCase();
  if (rawAuth && rawAuth !== 'none' && rawAuth !== 'oauth') {
    return { error: 'MCP server `auth` must be `oauth` when set.' };
  }
  if (rawAuth === 'oauth' && !supportsMcpOAuth(transport)) {
    return {
      error: 'OAuth is only supported for `http` and `sse` MCP servers.',
    };
  }

  const config = parsed as McpServerConfig;
  config.transport = transport;
  if (rawAuth === 'oauth') {
    config.auth = 'oauth';
  } else {
    delete config.auth;
  }
  return { config };
}

function describeMcpServerAuth(status: McpOAuthStatus): string {
  if (status.method !== 'oauth') return '';
  if (status.state === 'connected') return ' · oauth: connected';
  if (status.state === 'expired') return ' · oauth: expired';
  return ' · oauth: login required';
}

function mcpOAuthNeedsLogin(status: McpOAuthStatus): boolean {
  return status.method === 'oauth' && status.state !== 'connected';
}

function summarizeMcpServer(config: McpServerConfig): string {
  const enabled = config.enabled === false ? 'disabled' : 'enabled';
  const target =
    config.transport === 'stdio'
      ? [config.command, ...(config.args || [])].filter(Boolean).join(' ')
      : config.url || '(missing url)';
  return `${enabled} · ${config.transport} · ${target || '(missing command)'}`;
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
): Record<string, boolean | number | unknown[]> {
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
    ...(tokenUsage?.performanceSamples?.length
      ? { performanceSamples: tokenUsage.performanceSamples }
      : {}),
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

type GatewayBuildDiagnostics = NonNullable<GatewayStatus['build']>;
type GatewayBuildFileDiagnostics = GatewayBuildDiagnostics['files'][number];

const GATEWAY_BUILD_FILE_PAIRS: Array<{
  name: string;
  sourcePath: string;
  buildPath: string;
}> = [
  {
    name: 'cli',
    sourcePath: 'src/cli.ts',
    buildPath: 'dist/cli.js',
  },
  {
    name: 'gateway-service',
    sourcePath: 'src/gateway/gateway-service.ts',
    buildPath: 'dist/gateway/gateway-service.js',
  },
  {
    name: 'gateway-http-proxy',
    sourcePath: 'src/gateway/gateway-http-proxy.ts',
    buildPath: 'dist/gateway/gateway-http-proxy.js',
  },
  {
    name: 'container-tools',
    sourcePath: 'container/src/tools.ts',
    buildPath: 'container/dist/tools.js',
  },
];

function readFileModifiedAt(
  filePath: string,
): { timeMs: number; iso: string } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      timeMs: stat.mtimeMs,
      iso: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function getBuildFileStatus(
  packageRoot: string,
  filePair: (typeof GATEWAY_BUILD_FILE_PAIRS)[number],
): GatewayBuildFileDiagnostics {
  const sourcePath = path.join(packageRoot, filePair.sourcePath);
  const buildPath = path.join(packageRoot, filePair.buildPath);
  const sourceModified = readFileModifiedAt(sourcePath);
  const buildModified = readFileModifiedAt(buildPath);
  let status: GatewayBuildFileDiagnostics['status'] = 'ok';
  if (!sourceModified) {
    status = 'missing_source';
  } else if (!buildModified) {
    status = 'missing_build';
  } else if (sourceModified.timeMs > buildModified.timeMs + 1000) {
    status = 'source_newer';
  }

  return {
    name: filePair.name,
    sourcePath,
    sourceModifiedAt: sourceModified?.iso ?? null,
    buildPath,
    buildModifiedAt: buildModified?.iso ?? null,
    status,
  };
}

function readGitValue(packageRoot: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd: packageRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1000,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function isStaleBuildStatus(status: GatewayBuildFileDiagnostics['status']) {
  return status === 'source_newer' || status === 'missing_build';
}

function getGatewayBuildDiagnostics(): GatewayBuildDiagnostics {
  const packageRoot = resolveInstallRoot();
  const files = GATEWAY_BUILD_FILE_PAIRS.map((filePair) =>
    getBuildFileStatus(packageRoot, filePair),
  );
  const gitBranch = readGitValue(packageRoot, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);

  return {
    version: APP_VERSION,
    gitCommit: readGitValue(packageRoot, ['rev-parse', '--verify', 'HEAD']),
    gitBranch: gitBranch === 'HEAD' ? null : gitBranch,
    packageRoot,
    entrypoint: process.argv[1] || null,
    cwd: process.cwd(),
    execPath: process.execPath,
    nodeVersion: process.version,
    pid: process.pid,
    ppid: process.ppid,
    startedAt: GATEWAY_PROCESS_STARTED_AT,
    staleBuild: files.some((file) => isStaleBuildStatus(file.status)),
    files,
  };
}

export async function getGatewayStatus(
  options: GatewayHealthOptions = {},
): Promise<GatewayStatus> {
  const codex = getCodexAuthStatus();
  const hybridai = getHybridAIAuthStatus();
  const refreshProviderHealth = options.refreshProviderHealth ?? true;
  const [
    localBackendsResult,
    hybridaiResult,
    whatsappAuthResult,
    codexDiscoveryResult,
  ] = await Promise.allSettled([
    resolveGatewayLocalBackendsHealth(options),
    resolveGatewayHybridAIHealth(options),
    getWhatsAppAuthStatus(),
    // Warm the Codex model cache for provider counts; the status payload
    // reads discovered names after all probes settle.
    refreshProviderHealth && codex.authenticated && !codex.reloginRequired
      ? discoverCodexModels()
      : Promise.resolve([]),
  ]);
  if (codexDiscoveryResult.status === 'rejected') {
    logger.debug(
      { err: codexDiscoveryResult.reason },
      'Codex model cache warmup failed during gateway status',
    );
  }
  const runtimeConfig = getRuntimeConfig();
  const storedSecrets = readStoredRuntimeSecrets();
  const localBackendsMap =
    localBackendsResult.status === 'fulfilled'
      ? localBackendsResult.value
      : new Map();
  const hybridaiHealth = buildGatewayHybridAIProviderEntry(
    hybridaiResult.status === 'fulfilled'
      ? hybridaiResult.value
      : {
          reachable: false,
          error: 'probe failed',
          latencyMs: 0,
        },
  );
  const whatsappAuth =
    whatsappAuthResult.status === 'fulfilled'
      ? whatsappAuthResult.value
      : { linked: false, jid: null };
  const whatsappPairing = getWhatsAppPairingState();
  const signalPairing = getSignalLinkState();
  const signalCli = getSignalCliAvailability();
  const sandbox = getSandboxDiagnostics();
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
  const includeCoworkerLiveness = options.includeCoworkerLiveness ?? true;
  const coworkerLiveness = includeCoworkerLiveness
    ? await getCoworkerLivenessSummary()
    : undefined;
  const discordCredential = resolveRuntimeCredentialStatus(
    'DISCORD_TOKEN',
    [DISCORD_TOKEN],
    storedSecrets.DISCORD_TOKEN,
  );
  const discord = {
    tokenConfigured: Boolean(discordCredential.value),
    tokenSource: discordCredential.source,
  } as NonNullable<GatewayStatus['discord']>;
  const slackBotCredential = resolveRuntimeCredentialStatus(
    'SLACK_BOT_TOKEN',
    [SLACK_BOT_TOKEN],
    storedSecrets.SLACK_BOT_TOKEN,
  );
  const slackAppCredential = resolveRuntimeCredentialStatus(
    'SLACK_APP_TOKEN',
    [SLACK_APP_TOKEN],
    storedSecrets.SLACK_APP_TOKEN,
  );
  const slack = {
    botTokenConfigured: Boolean(slackBotCredential.value),
    botTokenSource: slackBotCredential.source,
    appTokenConfigured: Boolean(slackAppCredential.value),
    appTokenSource: slackAppCredential.source,
  } as NonNullable<GatewayStatus['slack']>;
  const discordWebhookRuntimeStatus = getDiscordWebhookStatus();
  const discordWebhook = {
    targetCount: discordWebhookRuntimeStatus.targets.length,
    defaultTargetConfigured: Boolean(
      runtimeConfig.discordWebhook.webhooks.default?.webhookUrl,
    ),
    lastReachabilityResults:
      discordWebhookRuntimeStatus.lastReachabilityResults,
    lastSendResults: discordWebhookRuntimeStatus.lastSendResults,
  } as NonNullable<GatewayStatus['discordWebhook']>;
  const slackWebhookRuntimeStatus = getSlackWebhookStatus();
  const slackWebhook = {
    targetCount: slackWebhookRuntimeStatus.targets.length,
    defaultTargetConfigured: Boolean(
      runtimeConfig.slackWebhook.webhooks.default?.webhookUrl,
    ),
    lastReachabilityResults: slackWebhookRuntimeStatus.lastReachabilityResults,
    lastSendResults: slackWebhookRuntimeStatus.lastSendResults,
  } as NonNullable<GatewayStatus['slackWebhook']>;
  const telegram = resolveGatewayTokenStatus({
    storedSecretName: 'TELEGRAM_BOT_TOKEN',
    envValues: [TELEGRAM_BOT_TOKEN],
    configValue: runtimeConfig.telegram.botToken,
    storedValue: storedSecrets.TELEGRAM_BOT_TOKEN,
  });
  const threemaCredential = resolveRuntimeCredentialStatus(
    'THREEMA_GATEWAY_SECRET',
    [THREEMA_GATEWAY_SECRET],
    storedSecrets.THREEMA_GATEWAY_SECRET,
  );
  const threemaConfigSecret = String(runtimeConfig.threema.secret || '').trim();
  const threema = {
    secretConfigured: Boolean(threemaCredential.value || threemaConfigSecret),
    secretSource:
      threemaCredential.source || (threemaConfigSecret ? 'config' : null),
  } as NonNullable<GatewayStatus['threema']>;
  const email = resolveGatewayPasswordStatus({
    storedSecretName: 'EMAIL_PASSWORD',
    envValues: [EMAIL_PASSWORD],
    configValue: runtimeConfig.email.password,
    storedValue: storedSecrets.EMAIL_PASSWORD,
  });
  const imessage = resolveGatewayPasswordStatus({
    storedSecretName: 'IMESSAGE_PASSWORD',
    envValues: [IMESSAGE_PASSWORD],
    configValue: runtimeConfig.imessage.password,
    storedValue: storedSecrets.IMESSAGE_PASSWORD,
  });
  const voiceAuth = resolveGatewayVoiceAuthStatus({
    envValues: [TWILIO_AUTH_TOKEN],
    configValue: runtimeConfig.voice.twilio.authToken,
    storedValue: storedSecrets.TWILIO_AUTH_TOKEN,
  });
  return {
    status: 'ok',
    webAuthConfigured: Boolean(WEB_API_TOKEN),
    pid: process.pid,
    lifecycle: getGatewayLifecycleStatus(),
    version: APP_VERSION,
    build: getGatewayBuildDiagnostics(),
    uptime: Math.floor(process.uptime()),
    sessions: getSessionCount(),
    activeContainers: sandbox.activeSessions,
    defaultAgentId: resolveDefaultAgentId(runtimeConfig),
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
    hybridai: {
      apiKeyConfigured: hybridai.authenticated,
      apiKeySource: hybridai.source,
    },
    sandbox,
    observability: getObservabilityIngestState(),
    scheduler: {
      jobs: getSchedulerStatus(),
    },
    discord,
    discordWebhook,
    signal: {
      enabled: runtimeConfig.signal.enabled,
      daemonUrlConfigured: Boolean(runtimeConfig.signal.daemonUrl.trim()),
      accountConfigured: Boolean(runtimeConfig.signal.account.trim()),
      pairingStatus: signalPairing.status,
      pairingQrText: signalPairing.pairingQrText,
      pairingUri: signalPairing.pairingUri,
      pairingUpdatedAt: signalPairing.updatedAt,
      pairingError: signalPairing.error,
      cliAvailable: signalCli.available,
      cliPath: signalCli.path,
      cliVersion: signalCli.version,
      cliError: signalCli.error,
    },
    threema,
    slack,
    slackWebhook,
    telegram,
    email,
    emailEnabled: runtimeConfig.email.enabled === true,
    imessage,
    voice: {
      enabled: runtimeConfig.voice.enabled,
      accountSidConfigured: Boolean(
        runtimeConfig.voice.twilio.accountSid.trim(),
      ),
      fromNumberConfigured: Boolean(
        runtimeConfig.voice.twilio.fromNumber.trim(),
      ),
      authTokenConfigured: voiceAuth.authTokenConfigured,
      authTokenSource: voiceAuth.authTokenSource,
      webhookPath: runtimeConfig.voice.webhookPath,
      maxConcurrentCalls: runtimeConfig.voice.maxConcurrentCalls,
    },
    whatsapp: {
      ...whatsappAuth,
      pairingQrText: whatsappPairing.pairingQrText,
      pairingUpdatedAt: whatsappPairing.updatedAt,
      pairingError: whatsappPairing.error,
    },
    providerHealth,
    localBackends,
    ...(coworkerLiveness ? { coworkerLiveness } : {}),
    pluginCommands: listLoadedPluginCommands(),
  };
}

export async function getGatewayAdminOverview(): Promise<GatewayAdminOverview> {
  return {
    status: await getGatewayStatus(),
    configPath: runtimeConfigPath(),
    tunnel: getGatewayAdminTunnelStatus(),
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

const STATISTICS_MIN_DAYS = 1;
const STATISTICS_MAX_DAYS = 90;
const STATISTICS_DEFAULT_DAYS = 30;

function normalizeStatisticsDays(raw: number | string | undefined): number {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number.parseInt(raw, 10)
        : STATISTICS_DEFAULT_DAYS;
  if (!Number.isFinite(parsed)) {
    return STATISTICS_DEFAULT_DAYS;
  }
  return Math.max(
    STATISTICS_MIN_DAYS,
    Math.min(STATISTICS_MAX_DAYS, Math.floor(parsed)),
  );
}

function toIsoDate(daysOffsetFromToday: number): string {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() + daysOffsetFromToday);
  return now.toISOString().slice(0, 10);
}

export function getGatewayAdminStatistics(params?: {
  days?: number | string;
}): GatewayAdminStatisticsResponse {
  const days = normalizeStatisticsDays(params?.days);
  const startDate = toIsoDate(-(days - 1));
  const endDate = toIsoDate(0);

  const messageTrend = listMessageTrendByDay({ days });
  const sessionTrend = listSessionTrendByDay({ days });
  const usageTrend = listUsageDailyBreakdown({ days });
  const channelRows = listStatsByChannel({ days });
  const totals = getStatisticsTotals({ days });

  const trendByDay = new Map<string, GatewayAdminStatisticsTrendDay>();
  // Seed every UTC calendar day in [startDate, endDate] with zeros so the
  // response always covers `rangeDays` contiguous days, even when no
  // activity was recorded.
  for (let offset = 0; offset < days; offset += 1) {
    const date = toIsoDate(-(days - 1 - offset));
    trendByDay.set(date, {
      date,
      newSessions: 0,
      activeSessions: 0,
      userMessages: 0,
      assistantMessages: 0,
      totalMessages: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      callCount: 0,
      toolCalls: 0,
      costUsd: 0,
    });
  }

  // SQLite may emit timestamps from the rolling-window helpers that fall
  // just before startDate (when a query window is wider than the response
  // window). Drop those; they're outside the documented range.
  const upsertDay = (
    day: string,
    apply: (target: GatewayAdminStatisticsTrendDay) => void,
  ): void => {
    if (!day || day < startDate || day > endDate) return;
    const target = trendByDay.get(day);
    if (target) apply(target);
  };

  for (const row of messageTrend) {
    upsertDay(row.day, (day) => {
      day.userMessages = row.user_messages;
      day.assistantMessages = row.assistant_messages;
      day.totalMessages = row.total_messages;
    });
  }
  for (const row of sessionTrend) {
    upsertDay(row.day, (day) => {
      day.newSessions = row.new_sessions;
      day.activeSessions = row.active_sessions;
    });
  }
  for (const row of usageTrend) {
    upsertDay(row.day, (day) => {
      day.inputTokens = row.total_input_tokens;
      day.outputTokens = row.total_output_tokens;
      day.totalTokens = row.total_tokens;
      day.callCount = row.call_count;
      day.toolCalls = row.total_tool_calls;
      day.costUsd = row.total_cost_usd;
    });
  }

  const trend = Array.from(trendByDay.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  const usageTotals = trend.reduce(
    (acc, day) => {
      acc.totalInputTokens += day.inputTokens;
      acc.totalOutputTokens += day.outputTokens;
      acc.totalTokens += day.totalTokens;
      acc.totalCostUsd += day.costUsd;
      acc.callCount += day.callCount;
      acc.totalToolCalls += day.toolCalls;
      return acc;
    },
    {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      callCount: 0,
      totalToolCalls: 0,
    },
  );

  const channels: GatewayAdminStatisticsChannelRow[] = channelRows.map(
    (row) => ({
      channelId: row.channel_id || '(unknown)',
      sessionCount: row.session_count,
      userMessages: row.user_messages,
      assistantMessages: row.assistant_messages,
      totalMessages: row.total_messages,
    }),
  );

  return {
    rangeDays: days,
    startDate,
    endDate,
    totals: {
      newSessions: totals.new_sessions,
      activeSessions: totals.active_sessions,
      totalMessages: totals.total_messages,
      userMessages: totals.user_messages,
      assistantMessages: totals.assistant_messages,
      ...usageTotals,
    },
    trend,
    channels,
  };
}

export function getGatewayAdminAgents(): GatewayAdminAgentsResponse {
  return {
    agents: listAgents().map((agent) => {
      const resolved = resolveAgentConfig(agent.id);
      const workspacePath = path.resolve(agentWorkspaceDir(resolved.id));
      return mapGatewayAdminAgent(agent, {
        resolvedAgent: resolved,
        workspacePath,
        markdownFileStats:
          getGatewayAdminAgentMarkdownFilePresenceStats(workspacePath),
      });
    }),
  };
}

export async function getGatewayAdminHybridAIBots(options?: {
  baseUrl?: string;
}): Promise<GatewayAdminHybridAIBotsResponse> {
  const bots = await fetchHybridAIBots({
    baseUrl: options?.baseUrl,
    cacheTtlMs: BOT_CACHE_TTL,
  });
  return {
    bots: bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      ...(bot.description ? { description: bot.description } : {}),
      ...(bot.model ? { model: bot.model } : {}),
    })),
  };
}

function mapGatewayAdminTeamStructureRevision(
  revision: ReturnType<
    typeof listRegisteredAgentTeamStructureRevisions
  >[number],
): GatewayAdminTeamStructureRevision {
  return {
    id: revision.id,
    createdAt: revision.createdAt,
    actor: revision.actor,
    route: revision.route,
    source: revision.source,
    md5: revision.md5,
    sizeBytes: revision.byteLength,
    replacedByMd5: revision.replacedByMd5,
    changeCount: revision.changeCount,
    diff: revision.diff,
  };
}

export function getGatewayAdminTeamStructure(): GatewayAdminTeamStructureResponse {
  return {
    snapshot: buildAgentTeamStructureSnapshot(listAgents()),
    revisions: listRegisteredAgentTeamStructureRevisions().map(
      mapGatewayAdminTeamStructureRevision,
    ),
  };
}

export function getGatewayAdminTeamStructureRevision(
  revisionId: number,
): GatewayAdminTeamStructureRevisionResponse {
  const revision = getRegisteredAgentTeamStructureRevision(revisionId);
  return {
    revision: mapGatewayAdminTeamStructureRevision(revision),
  };
}

export function restoreGatewayAdminTeamStructureRevision(
  revisionId: number,
): GatewayAdminTeamStructureResponse {
  restoreRegisteredAgentTeamStructureRevision(revisionId);
  return getGatewayAdminTeamStructure();
}

export function getGatewayAdminAgentMarkdownFile(
  agentId: string,
  fileName: string,
): GatewayAdminAgentMarkdownFileResponse {
  const resolved = resolveGatewayAdminAgentMarkdownFile({ agentId, fileName });
  return buildGatewayAdminAgentMarkdownFileResponse({ resolved });
}

export function getGatewayAdminAgentMarkdownRevision(params: {
  agentId: string;
  fileName: string;
  revisionId: string;
}): GatewayAdminAgentMarkdownRevisionResponse {
  const resolved = resolveGatewayAdminAgentMarkdownFile(params);
  if (resolved.sharedMemoryFile) {
    throw new Error(
      `Shared markdown file "${resolved.fileName}" does not have local revisions.`,
    );
  }
  const fileName = normalizeGatewayAdminAgentLocalMarkdownFileName(
    resolved.fileName,
  );
  const revision = getGatewayAdminAgentMarkdownRevisionRecord({
    workspacePath: resolved.workspacePath,
    fileName,
    revisionId: params.revisionId,
  });
  return {
    agent: mapGatewayAdminAgent(resolved.agent, {
      resolvedAgent: resolved.resolvedAgent,
      workspacePath: resolved.workspacePath,
      markdownFileStats: getGatewayAdminAgentMarkdownFilePresenceStats(
        resolved.workspacePath,
      ),
    }),
    fileName: resolved.fileName,
    revision: {
      id: revision.id,
      createdAt: revision.createdAt,
      sizeBytes: revision.sizeBytes,
      sha256: revision.sha256,
      source: revision.source,
      content: revision.content,
    },
  };
}

export function saveGatewayAdminAgentMarkdownFile(params: {
  agentId: string;
  fileName: string;
  content: string;
}): GatewayAdminAgentMarkdownFileResponse {
  const nextSizeBytes = assertGatewayAdminAgentMarkdownContentSize(
    params.content,
  );
  const resolved = resolveGatewayAdminAgentMarkdownFile(params);
  if (resolved.sharedMemoryFile) {
    throw new Error(
      `Shared markdown file "${resolved.fileName}" is read-only.`,
    );
  }
  const fileName = normalizeGatewayAdminAgentLocalMarkdownFileName(
    resolved.fileName,
  );
  const currentState = readGatewayAdminAgentMarkdownFileState(
    resolved.filePath,
  );
  if (currentState.exists && currentState.content === params.content) {
    return buildGatewayAdminAgentMarkdownFileResponse({
      resolved,
      fileState: currentState,
    });
  }
  if (currentState.exists) {
    writeGatewayAdminAgentMarkdownRevision({
      workspacePath: resolved.workspacePath,
      fileName,
      content: currentState.content,
      source: 'save',
    });
  }
  const nextStats = writeGatewayAdminAgentMarkdownFileContent(
    resolved.filePath,
    params.content,
    {
      sizeBytes: nextSizeBytes,
    },
  );
  return buildGatewayAdminAgentMarkdownFileResponse({
    resolved,
    fileState: {
      ...nextStats,
      content: params.content,
    },
  });
}

export function restoreGatewayAdminAgentMarkdownRevision(params: {
  agentId: string;
  fileName: string;
  revisionId: string;
}): GatewayAdminAgentMarkdownFileResponse {
  const resolved = resolveGatewayAdminAgentMarkdownFile(params);
  if (resolved.sharedMemoryFile) {
    throw new Error(
      `Shared markdown file "${resolved.fileName}" is read-only.`,
    );
  }
  const fileName = normalizeGatewayAdminAgentLocalMarkdownFileName(
    resolved.fileName,
  );
  const revision = getGatewayAdminAgentMarkdownRevisionRecord({
    workspacePath: resolved.workspacePath,
    fileName,
    revisionId: params.revisionId,
  });
  const nextSizeBytes = assertGatewayAdminAgentMarkdownContentSize(
    revision.content,
    'Markdown revision content',
  );
  const currentState = readGatewayAdminAgentMarkdownFileState(
    resolved.filePath,
  );
  if (currentState.exists && currentState.content === revision.content) {
    return buildGatewayAdminAgentMarkdownFileResponse({
      resolved,
      fileState: currentState,
    });
  }
  if (currentState.exists) {
    writeGatewayAdminAgentMarkdownRevision({
      workspacePath: resolved.workspacePath,
      fileName,
      content: currentState.content,
      source: 'restore',
    });
  }
  const nextStats = writeGatewayAdminAgentMarkdownFileContent(
    resolved.filePath,
    revision.content,
    {
      sizeBytes: nextSizeBytes,
    },
  );
  return buildGatewayAdminAgentMarkdownFileResponse({
    resolved,
    fileState: {
      ...nextStats,
      content: revision.content,
    },
  });
}

type GatewayAdminAgentOrgChartParams = {
  role?: string | null;
  reportsTo?: string | null;
  delegatesTo?: string[] | null;
  peers?: string[] | null;
};

function buildGatewayAdminAgentOrgChartPatch(
  params: GatewayAdminAgentOrgChartParams,
): Partial<Pick<AgentConfig, 'role' | 'reportsTo' | 'delegatesTo' | 'peers'>> {
  return {
    ...(params.role !== undefined
      ? { role: params.role?.trim() || undefined }
      : {}),
    ...(params.reportsTo !== undefined
      ? { reportsTo: params.reportsTo?.trim() || undefined }
      : {}),
    ...(params.delegatesTo !== undefined
      ? {
          delegatesTo:
            params.delegatesTo == null
              ? undefined
              : normalizeOptionalTrimmedUniqueStringArray(params.delegatesTo),
        }
      : {}),
    ...(params.peers !== undefined
      ? {
          peers:
            params.peers == null
              ? undefined
              : normalizeOptionalTrimmedUniqueStringArray(params.peers),
        }
      : {}),
  };
}

export function createGatewayAdminAgent(params: {
  id: string;
  name?: string | null;
  model?: string | null;
  skills?: string[] | null;
  chatbotId?: string | null;
  enableRag?: boolean | null;
  proxy?: AgentConfig['proxy'] | null;
  role?: string | null;
  reportsTo?: string | null;
  delegatesTo?: string[] | null;
  peers?: string[] | null;
  workspace?: string | null;
}): { agent: ReturnType<typeof mapGatewayAdminAgent> } {
  const saved = upsertRegisteredAgent({
    id: params.id,
    ...(params.name?.trim() ? { name: params.name.trim() } : {}),
    ...(params.model?.trim() ? { model: params.model.trim() } : {}),
    ...(params.skills !== undefined
      ? { skills: params.skills == null ? undefined : [...params.skills] }
      : {}),
    ...(params.chatbotId?.trim() ? { chatbotId: params.chatbotId.trim() } : {}),
    ...(typeof params.enableRag === 'boolean'
      ? { enableRag: params.enableRag }
      : {}),
    ...(params.proxy !== undefined ? { proxy: params.proxy ?? undefined } : {}),
    ...buildGatewayAdminAgentOrgChartPatch(params),
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
    skills?: string[] | null;
    chatbotId?: string | null;
    enableRag?: boolean | null;
    proxy?: AgentConfig['proxy'] | null;
    role?: string | null;
    reportsTo?: string | null;
    delegatesTo?: string[] | null;
    peers?: string[] | null;
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
    ...(params.skills !== undefined
      ? { skills: params.skills == null ? undefined : [...params.skills] }
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
    ...(params.proxy !== undefined ? { proxy: params.proxy ?? undefined } : {}),
    ...buildGatewayAdminAgentOrgChartPatch(params),
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
  const livenessSummary = status.coworkerLiveness;
  const livenessByAgent = new Map(
    (livenessSummary?.probes ?? []).map(
      (probe) => [probe.agentId, probe] as const,
    ),
  );
  const usageByAgent = new Map(
    listUsageByAgentRollups().map((row) => [row.agent_id, row] as const),
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
    .map((agentId) => {
      const usage = usageByAgent.get(agentId);
      return mapLogicalAgentCard({
        agent: getAgentById(agentId) ?? resolveAgentConfig(agentId),
        sessions: sessionsByAgent.get(agentId) ?? [],
        usage,
        monthlySpendUsd: usage?.monthly_cost_usd,
        liveness: livenessByAgent.get(agentId),
      });
    })
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
    liveness: livenessSummary,
    agents,
    sessions,
  };
}

export function getGatewayAdminJobsContext(): GatewayAdminJobsContextResponse {
  const activeSessionIds = new Set(getActiveExecutorSessionIds());
  const sandboxMode = getRuntimeConfig().container.sandboxMode || 'container';
  const allSessions = getAllSessions();
  const cards = listCards().map(mapGatewayAdminJobCard);
  const sessions = allSessions
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
      output: collectRecentAssistantOutputs(session.sessionId),
      sessionId: session.sessionId,
      agentId: session.agentId,
      startedAt: session.startedAt,
      lastActive: session.lastActive,
      status: session.status,
      lastAnswer: session.lastAnswer,
    }));
  const sessionAgentIds = new Map(
    allSessions.map((session) => [
      session.id,
      resolveAgentForRequest({ session }).agentId,
    ]),
  );
  const suspendedSessions = listSuspendedSessions();

  const agentIds = Array.from(
    new Set([
      ...listAgents().map((agent) => agent.id),
      ...cards
        .map((card) => (card.owner.type === 'agent' ? card.owner.id : null))
        .filter((agentId): agentId is string => Boolean(agentId)),
      ...sessions.map((session) => session.agentId),
      ...suspendedSessions
        .map(
          (session) =>
            session.agentId || sessionAgentIds.get(session.sessionId),
        )
        .filter((agentId): agentId is string => Boolean(agentId)),
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
    cards,
    sessions,
    suspendedSessions: suspendedSessions.map((session) =>
      mapGatewayAdminSuspendedSession(session, sessionAgentIds),
    ),
  };
}

function mapGatewayAdminJobCard(card: BoardCard): GatewayAdminJobCard {
  let owner: GatewayAdminJobCard['owner'];
  if ('agentId' in card.owner && card.owner.agentId) {
    owner = { type: 'agent', id: card.owner.agentId };
  } else if ('userId' in card.owner && card.owner.userId) {
    owner = { type: 'user', id: card.owner.userId };
  } else {
    throw new Error(`Board card ${card.id} has an invalid owner.`);
  }
  return {
    id: card.id,
    title: card.title,
    body: card.body,
    owner,
    column: card.column,
    status: card.status,
    source: card.source,
    parent: card.parent,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    blocked: isBoardCardBlocked(card.id),
    edges: listEdges(card.id).map(mapGatewayAdminJobCardEdge),
  };
}

function mapGatewayAdminJobCardEdge(
  edge: BoardCardEdge,
): GatewayAdminJobCardEdge {
  return {
    id: edge.id,
    fromCardId: edge.fromCardId,
    toCardId: edge.toCardId,
    kind: edge.kind,
    createdAt: edge.createdAt,
  };
}

function collectRecentAssistantOutputs(
  sessionId: string,
  limit = 12,
): string[] {
  const outputs: string[] = [];
  const seen = new Set<string>();
  const messages = getRecentMessages(sessionId, limit);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message.role || '').toLowerCase() !== 'assistant') continue;
    const content = String(message.content || '').trim();
    if (!content || seen.has(content)) continue;
    seen.add(content);
    outputs.unshift(content);
  }

  return outputs;
}

export function getGatewayAdminSessions(): GatewayAdminSession[] {
  return getAllSessions().map(mapAdminSession);
}

function resolveGatewayAdminEmailPassword(
  runtimeConfig: RuntimeConfig,
): string {
  const credential = resolveRuntimeCredentialStatus('EMAIL_PASSWORD', [
    EMAIL_PASSWORD,
  ]);
  return credential.value || String(runtimeConfig.email.password || '').trim();
}

function assertGatewayAdminEmailMailboxConfigured(
  runtimeConfig: RuntimeConfig,
): {
  config: RuntimeConfig['email'];
  password: string;
} {
  if (!runtimeConfig.email.enabled) {
    throw new Error('Email channel is not enabled.');
  }
  if (!runtimeConfig.email.address.trim()) {
    throw new Error('Email address is not configured.');
  }
  if (!runtimeConfig.email.imapHost.trim()) {
    throw new Error('Email IMAP host is not configured.');
  }
  const password = resolveGatewayAdminEmailPassword(runtimeConfig);
  if (!password) {
    throw new Error('Email password is not configured.');
  }
  return {
    config: runtimeConfig.email,
    password,
  };
}

export async function getGatewayAdminEmailMailbox(): Promise<GatewayAdminEmailMailboxResponse> {
  const runtimeConfig = getRuntimeConfig();
  if (!runtimeConfig.email.enabled) {
    return {
      enabled: false,
      address: runtimeConfig.email.address,
      folders: [],
      defaultFolder: null,
    };
  }
  const { config, password } =
    assertGatewayAdminEmailMailboxConfigured(runtimeConfig);
  const mailbox = await fetchLiveAdminEmailMailbox(config, password);

  return {
    enabled: true,
    address: mailbox.address,
    folders: mailbox.folders,
    defaultFolder: mailbox.defaultFolder,
  };
}

export async function getGatewayAdminEmailFolder(params: {
  folder: string;
  limit?: number;
  offset?: number;
}): Promise<GatewayAdminEmailFolderResponse> {
  const runtimeConfig = getRuntimeConfig();
  const { config, password } =
    assertGatewayAdminEmailMailboxConfigured(runtimeConfig);
  return fetchLiveAdminEmailFolder(config, password, params);
}

export async function getGatewayAdminEmailMessage(params: {
  folder: string;
  uid: number;
}): Promise<GatewayAdminEmailMessageResponse> {
  const runtimeConfig = getRuntimeConfig();
  const { config, password } =
    assertGatewayAdminEmailMailboxConfigured(runtimeConfig);
  return fetchLiveAdminEmailMessage(config, password, params);
}

export async function deleteGatewayAdminEmailMessage(params: {
  folder: string;
  uid: number;
}): Promise<GatewayAdminEmailDeleteResponse> {
  const runtimeConfig = getRuntimeConfig();
  const { config, password } =
    assertGatewayAdminEmailMailboxConfigured(runtimeConfig);
  return deleteLiveAdminEmailMessage(config, password, params);
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
    slack: {
      enabled: runtimeConfig.slack.enabled,
      groupPolicy: runtimeConfig.slack.groupPolicy,
      dmPolicy: runtimeConfig.slack.dmPolicy,
      defaultRequireMention: runtimeConfig.slack.requireMention,
      defaultReplyStyle: runtimeConfig.slack.replyStyle,
    },
    slackWebhook: {
      enabled: runtimeConfig.slackWebhook.enabled,
      targetCount: Object.keys(runtimeConfig.slackWebhook.webhooks).length,
      defaultTargetConfigured: Boolean(
        runtimeConfig.slackWebhook.webhooks.default?.webhookUrl,
      ),
    },
    discordWebhook: {
      enabled: runtimeConfig.discordWebhook.enabled,
      targetCount: Object.keys(runtimeConfig.discordWebhook.webhooks).length,
      defaultTargetConfigured: Boolean(
        runtimeConfig.discordWebhook.webhooks.default?.webhookUrl,
      ),
    },
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

function redactGatewayAdminConfigSecrets(config: RuntimeConfig): RuntimeConfig {
  const redacted = structuredClone(config);
  for (const webhook of Object.values(redacted.slackWebhook.webhooks)) {
    webhook.webhookUrl = '';
  }
  for (const webhook of Object.values(redacted.discordWebhook.webhooks)) {
    webhook.webhookUrl = '';
  }
  preserveGatewayAdminEmailAccountPasswordRefs(redacted);
  return redacted;
}

function preserveGatewayAdminEmailAccountPasswordRefs(config: RuntimeConfig) {
  const source = getRuntimeConfigSourceSnapshot();
  const sourceEmail =
    source.email &&
    typeof source.email === 'object' &&
    !Array.isArray(source.email)
      ? (source.email as Record<string, unknown>)
      : null;
  const sourceAccounts = Array.isArray(sourceEmail?.accounts)
    ? sourceEmail.accounts
    : [];
  for (let index = 0; index < sourceAccounts.length; index += 1) {
    const sourceAccount = sourceAccounts[index];
    const password =
      sourceAccount &&
      typeof sourceAccount === 'object' &&
      !Array.isArray(sourceAccount)
        ? (sourceAccount as Record<string, unknown>).password
        : null;
    if (!isSecretRefInput(password)) continue;
    const account = config.email.accounts[index];
    if (!account) continue;
    account.password = { source: 'store', id: password.id };
  }
}

export function getGatewayAdminConfig(): GatewayAdminConfigResponse {
  return {
    path: runtimeConfigPath(),
    config: redactGatewayAdminConfigSecrets(getRuntimeConfig()),
  };
}

export function saveGatewayAdminConfig(
  next: RuntimeConfig,
): GatewayAdminConfigResponse {
  const current = getRuntimeConfig();
  for (const [target, currentWebhook] of Object.entries(
    current.slackWebhook.webhooks,
  )) {
    const incoming = next.slackWebhook.webhooks[target];
    if (incoming && !String(incoming.webhookUrl || '').trim()) {
      incoming.webhookUrl = currentWebhook.webhookUrl;
    }
  }
  for (const [target, currentWebhook] of Object.entries(
    current.discordWebhook.webhooks,
  )) {
    const incoming = next.discordWebhook.webhooks[target];
    if (incoming && !String(incoming.webhookUrl || '').trim()) {
      incoming.webhookUrl = currentWebhook.webhookUrl;
    }
  }
  return {
    path: runtimeConfigPath(),
    config: redactGatewayAdminConfigSecrets(saveRuntimeConfig(next)),
  };
}

export function saveGatewayAdminDiscordWebhookTarget(
  input: GatewayAdminDiscordWebhookTargetRequest,
): GatewayAdminConfigResponse {
  const target = normalizeDiscordWebhookTargetName(input.target);
  if (!target) {
    throw new Error(
      'Invalid Discord webhook target. Use letters, numbers, dots, dashes, or underscores.',
    );
  }

  const webhookUrl = String(input.webhookUrl || '').trim();
  const current = getRuntimeConfig();
  const existing = current.discordWebhook.webhooks[target];
  if (!webhookUrl && !existing?.webhookUrl) {
    throw new Error('Discord webhook URL is required for a new target.');
  }
  if (
    target !== DISCORD_WEBHOOK_DEFAULT_TARGET &&
    !current.discordWebhook.webhooks[DISCORD_WEBHOOK_DEFAULT_TARGET]?.webhookUrl
  ) {
    throw new Error('Configure the default Discord webhook target first.');
  }

  let policyMessageHost: string | null = null;
  if (webhookUrl) {
    const normalizedUrl = normalizeDiscordWebhookUrl(
      webhookUrl,
      `discordWebhook.webhooks.${target}.webhook_url`,
    );
    const secretName = discordWebhookSecretNameForTarget(target);
    saveNamedRuntimeSecrets({ [secretName]: normalizedUrl });
    refreshRuntimeSecretsFromEnv();
    setRuntimeConfigDiscordWebhookSecretInput(
      target,
      {
        source: 'store',
        id: secretName,
      },
      {
        route: 'admin.discord-webhook.target-secret-ref',
        source: 'user',
      },
    );
    const policy = allowDiscordWebhookInWorkspacePolicy({
      workspacePath: agentWorkspaceDir(DEFAULT_AGENT_ID),
      webhookUrl: normalizedUrl,
    });
    policyMessageHost = policy.rule.host;
  }

  const saved = updateRuntimeConfig(
    (draft) => {
      draft.discordWebhook.enabled =
        target === DISCORD_WEBHOOK_DEFAULT_TARGET
          ? true
          : draft.discordWebhook.enabled;
      const nextTarget = draft.discordWebhook.webhooks[target] ?? {
        webhookUrl: existing?.webhookUrl || '',
        defaultUsername: '',
        defaultAvatarUrl: '',
      };
      draft.discordWebhook.webhooks[target] = {
        ...nextTarget,
        defaultUsername:
          input.defaultUsername !== undefined
            ? String(input.defaultUsername || '').trim()
            : nextTarget.defaultUsername,
        defaultAvatarUrl:
          input.defaultAvatarUrl !== undefined
            ? String(input.defaultAvatarUrl || '').trim()
            : nextTarget.defaultAvatarUrl,
      };
    },
    {
      route: `admin.discord-webhook.target:${target}`,
      source: 'user',
    },
  );

  if (policyMessageHost) {
    logger.info(
      { target, host: policyMessageHost },
      'Discord webhook network policy grant verified',
    );
  }

  return {
    path: runtimeConfigPath(),
    config: redactGatewayAdminConfigSecrets(saved),
  };
}

export function saveGatewayAdminSlackWebhookTarget(
  input: GatewayAdminSlackWebhookTargetRequest,
): GatewayAdminConfigResponse {
  const target = normalizeSlackWebhookTargetName(input.target);
  if (!target) {
    throw new Error(
      'Invalid Slack webhook target. Use letters, numbers, dots, dashes, or underscores.',
    );
  }

  const webhookUrl = String(input.webhookUrl || '').trim();
  const current = getRuntimeConfig();
  const existing = current.slackWebhook.webhooks[target];
  if (!webhookUrl && !existing?.webhookUrl) {
    throw new Error('Slack webhook URL is required for a new target.');
  }
  if (
    target !== SLACK_WEBHOOK_DEFAULT_TARGET &&
    !current.slackWebhook.webhooks[SLACK_WEBHOOK_DEFAULT_TARGET]?.webhookUrl
  ) {
    throw new Error('Configure the default Slack webhook target first.');
  }

  let policyMessageHost: string | null = null;
  if (webhookUrl) {
    const normalizedUrl = normalizeSlackWebhookUrl(
      webhookUrl,
      `slackWebhook.webhooks.${target}.webhook_url`,
    );
    const secretName = slackWebhookSecretNameForTarget(target);
    saveNamedRuntimeSecrets({ [secretName]: normalizedUrl });
    refreshRuntimeSecretsFromEnv();
    setRuntimeConfigSlackWebhookSecretInput(
      target,
      {
        source: 'store',
        id: secretName,
      },
      {
        route: 'admin.slack-webhook.target-secret-ref',
        source: 'user',
      },
    );
    const policy = allowSlackWebhookInWorkspacePolicy({
      workspacePath: agentWorkspaceDir(DEFAULT_AGENT_ID),
      webhookUrl: normalizedUrl,
    });
    policyMessageHost = policy.rule.host;
  }

  const saved = updateRuntimeConfig(
    (draft) => {
      draft.slackWebhook.enabled =
        target === SLACK_WEBHOOK_DEFAULT_TARGET
          ? true
          : draft.slackWebhook.enabled;
      const nextTarget = draft.slackWebhook.webhooks[target] ?? {
        webhookUrl: existing?.webhookUrl || '',
        defaultUsername: '',
        defaultIconEmoji: '',
        defaultIconUrl: '',
      };
      draft.slackWebhook.webhooks[target] = {
        ...nextTarget,
        defaultUsername:
          input.defaultUsername !== undefined
            ? String(input.defaultUsername || '').trim()
            : nextTarget.defaultUsername,
        defaultIconEmoji:
          input.defaultIconEmoji !== undefined
            ? String(input.defaultIconEmoji || '').trim()
            : nextTarget.defaultIconEmoji,
        defaultIconUrl:
          input.defaultIconUrl !== undefined
            ? String(input.defaultIconUrl || '').trim()
            : nextTarget.defaultIconUrl,
      };
    },
    {
      route: `admin.slack-webhook.target:${target}`,
      source: 'user',
    },
  );

  if (policyMessageHost) {
    logger.info(
      { target, host: policyMessageHost },
      'Slack webhook network policy grant verified',
    );
  }

  return {
    path: runtimeConfigPath(),
    config: redactGatewayAdminConfigSecrets(saved),
  };
}

function mapA2ATrustPeer(
  peer: ReturnType<typeof listA2ATrustedPublicKeyPeers>[number],
): GatewayAdminA2ATrustPeer {
  return {
    peerId: peer.peerId,
    agentCardUrl: peer.agentCardUrl,
    deliveryUrl: peer.deliveryUrl,
    publicKeyFingerprint: peer.publicKeyFingerprint,
    publicKeyJwk: peer.publicKeyJwk,
    status: peer.status,
    trustedAt: peer.trustedAt,
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
    lastSeenAt: peer.lastSeenAt,
    revokedAt: peer.revokedAt || null,
    revokedReason: peer.revokedReason || null,
    lastMismatchAt: peer.lastMismatchAt || null,
    lastMismatchFingerprint: peer.lastMismatchFingerprint || null,
  };
}

export function getGatewayAdminA2ATrust(): GatewayAdminA2ATrustResponse {
  const identity = ensureA2AInstanceKeypair();
  return {
    identity: {
      instanceId: identity.instanceId,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      publicKeyJwk: identity.publicKeyJwk,
    },
    peers: listA2ATrustedPublicKeyPeers().map(mapA2ATrustPeer),
    pairingRequests: listIncomingA2APairingRequests(),
  };
}

export function revokeGatewayAdminA2ATrustPeer(params: {
  peerId: string;
  reason?: string;
  actor?: string;
}): GatewayAdminA2ATrustResponse {
  revokeA2ATrustedPublicKeyPeer(params.peerId, {
    reason: params.reason,
    actor: params.actor,
  });
  return getGatewayAdminA2ATrust();
}

function normalizeA2AStringInput(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GatewayRequestError(400, `Expected string \`${label}\`.`);
  }
  return value.trim();
}

function normalizeOptionalA2AStringInput(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayRequestError(400, `Expected string \`${label}\`.`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function upsertGatewayAdminA2ATrustPeer(
  input: GatewayAdminA2ATrustUpsertRequest,
  actor?: string,
): GatewayAdminA2ATrustResponse {
  upsertA2ATrustedPublicKeyPeer({
    peerId: normalizeA2AStringInput(input.peerId, 'peerId'),
    agentCardUrl: normalizeOptionalA2AStringInput(
      input.agentCardUrl,
      'agentCardUrl',
    ),
    deliveryUrl: normalizeOptionalA2AStringInput(
      input.deliveryUrl,
      'deliveryUrl',
    ),
    publicKeyFingerprint: normalizeOptionalA2AStringInput(
      input.publicKeyFingerprint,
      'publicKeyFingerprint',
    ),
    publicKeyJwk: input.publicKeyJwk,
    reason: normalizeOptionalA2AStringInput(input.reason, 'reason'),
    actor,
  });
  return getGatewayAdminA2ATrust();
}

export function deleteGatewayAdminA2ATrustPeer(params: {
  peerId: string;
  actor?: string;
}): GatewayAdminA2ATrustResponse {
  deleteA2ATrustedPublicKeyPeer(params.peerId, { actor: params.actor });
  return getGatewayAdminA2ATrust();
}

function normalizeOptionalA2ABooleanInput(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new GatewayRequestError(400, `Expected boolean \`${label}\`.`);
  }
  return value;
}

function resolveGatewayA2APublicBaseUrl(): string | null {
  const tunnelStatus = getGatewayAdminTunnelStatus();
  return (
    tunnelStatus.publicUrl ||
    getRuntimeConfig().deployment.public_url.trim() ||
    null
  );
}

function mapA2APairingStartResponse(
  result: StartA2APairingResult,
): GatewayAdminA2APairingStartResponse {
  const trust = getGatewayAdminA2ATrust();
  return {
    ...trust,
    proposal: {
      peerId: result.proposal.peerId,
      agentCardUrl: result.proposal.agentCardUrl,
      deliveryUrl: result.proposal.deliveryUrl,
      publicKeyFingerprint: result.proposal.publicKeyFingerprint,
      name: result.proposal.name,
    },
    remoteNotification: result.remoteNotification,
  };
}

function resolvePairingTargetInput(input: GatewayAdminA2APairingStartRequest): {
  peerUrl?: string;
  canonicalId?: string;
} {
  const peerUrl = normalizeOptionalA2AStringInput(input.peerUrl, 'peerUrl');
  const canonicalId =
    normalizeOptionalA2AStringInput(input.canonicalId, 'canonicalId') ||
    normalizeOptionalA2AStringInput(
      input.canonicalInstanceId,
      'canonicalInstanceId',
    );
  if (!peerUrl && !canonicalId) {
    throw new GatewayRequestError(
      400,
      'Expected `peerUrl`, `canonicalId`, or `canonicalInstanceId`.',
    );
  }
  return { peerUrl, canonicalId };
}

export async function startGatewayAdminA2APairing(
  input: GatewayAdminA2APairingStartRequest,
  actor?: string,
): Promise<GatewayAdminA2APairingStartResponse> {
  const { peerUrl, canonicalId } = resolvePairingTargetInput(input);
  const notifyPeer =
    normalizeOptionalA2ABooleanInput(input.notifyPeer, 'notifyPeer') ?? true;
  const result = await startA2APairing({
    peerUrl,
    canonicalId,
    reason: normalizeOptionalA2AStringInput(input.reason, 'reason'),
    notifyPeer,
    actor,
    localBaseUrl: notifyPeer ? resolveGatewayA2APublicBaseUrl() : null,
  });
  return mapA2APairingStartResponse(result);
}

export async function previewGatewayAdminA2APairing(
  input: GatewayAdminA2APairingStartRequest,
): Promise<GatewayAdminA2APairingPreviewResponse> {
  const { peerUrl, canonicalId } = resolvePairingTargetInput(input);
  const proposal = await fetchA2APairingProposal({ peerUrl, canonicalId });
  return {
    proposal: {
      peerId: proposal.peerId,
      agentCardUrl: proposal.agentCardUrl,
      deliveryUrl: proposal.deliveryUrl,
      publicKeyFingerprint: proposal.publicKeyFingerprint,
      publicKeyJwk: proposal.publicKeyJwk,
      name: proposal.name,
    },
  };
}

export function approveGatewayAdminA2APairingRequest(
  input: GatewayAdminA2APairingDecisionRequest,
  actor?: string,
): GatewayAdminA2ATrustResponse {
  approveIncomingA2APairingRequest({
    requestId: normalizeA2AStringInput(input.requestId, 'requestId'),
    reason: normalizeOptionalA2AStringInput(input.reason, 'reason'),
    actor,
  });
  return getGatewayAdminA2ATrust();
}

export function declineGatewayAdminA2APairingRequest(
  input: GatewayAdminA2APairingDecisionRequest,
  actor?: string,
): GatewayAdminA2ATrustResponse {
  declineIncomingA2APairingRequest({
    requestId: normalizeA2AStringInput(input.requestId, 'requestId'),
    reason: normalizeOptionalA2AStringInput(input.reason, 'reason'),
    actor,
  });
  return getGatewayAdminA2ATrust();
}

function mapA2AThreadMessage(
  envelope: ReturnType<typeof listA2AThreadEnvelopes>[number],
): GatewayAdminA2AThreadMessage {
  return {
    id: envelope.id,
    threadId: envelope.thread_id,
    senderAgentId: envelope.sender_agent_id,
    recipientAgentId: envelope.recipient_agent_id,
    parentMessageId: envelope.parent_message_id ?? null,
    intent: envelope.intent,
    content: envelope.content,
    createdAt: envelope.created_at,
  };
}

function compareA2AThreadEnvelopes(
  left: ReturnType<typeof listA2AThreadEnvelopes>[number],
  right: ReturnType<typeof listA2AThreadEnvelopes>[number],
): number {
  const createdAtOrder = left.created_at.localeCompare(right.created_at);
  if (createdAtOrder !== 0) return createdAtOrder;
  return left.id.localeCompare(right.id);
}

function mapA2AThreadSummary(
  thread: A2AThreadSummary,
): GatewayAdminA2AThreadSummary {
  return {
    id: thread.thread_id,
    ownerCoworkerId: thread.owner_coworker_id,
    messageCount: thread.message_count,
    participants: thread.participants,
    latestMessage:
      thread.latest_message_id &&
      thread.latest_sender_agent_id &&
      thread.latest_recipient_agent_id &&
      thread.latest_intent &&
      thread.latest_created_at
        ? {
            id: thread.latest_message_id,
            threadId: thread.thread_id,
            senderAgentId: thread.latest_sender_agent_id,
            recipientAgentId: thread.latest_recipient_agent_id,
            parentMessageId: thread.latest_parent_message_id,
            intent: thread.latest_intent,
            content: thread.latest_content ?? '',
            createdAt: thread.latest_created_at,
          }
        : null,
  };
}

export function getGatewayAdminA2AInbox(params?: {
  threadId?: string | null;
}): GatewayAdminA2AInboxResponse {
  const threadSummaries = listA2AThreads();
  const threads = threadSummaries.map(mapA2AThreadSummary);
  const requestedThreadId = params?.threadId?.trim() || null;
  const selectedThreadId = requestedThreadId || threads[0]?.id || null;

  if (
    requestedThreadId &&
    !threads.some((thread) => thread.id === requestedThreadId)
  ) {
    throw new GatewayRequestError(404, 'A2A thread not found.');
  }

  const messages = selectedThreadId
    ? listA2AThreadEnvelopes(selectedThreadId)
        .sort(compareA2AThreadEnvelopes)
        .map(mapA2AThreadMessage)
    : [];

  return {
    threads,
    selectedThreadId,
    messages,
  };
}

export function getGatewayA2AAgentCard(
  baseUrl: string,
  options?: BuildLocalA2AAgentCardOptions,
): A2AAgentCard {
  return buildLocalA2AAgentCard(baseUrl, options);
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

export async function getGatewayAdminTools(): Promise<GatewayAdminToolsResponse> {
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

  let pluginToolNames: string[] = [];
  try {
    const pluginManager = await ensurePluginManagerInitialized();
    pluginToolNames = pluginManager
      .getToolDefinitions()
      .map((tool) => tool.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    logger.warn({ error }, 'Failed to load plugin tools for admin catalog');
  }

  const mapTool = (
    name: string,
    group: string,
    kind: GatewayAdminToolCatalogEntry['kind'],
  ): GatewayAdminToolCatalogEntry => {
    const usage = usageByTool.get(name);
    return {
      name,
      group,
      kind,
      recentCalls: usage?.recentCalls || 0,
      recentErrors: usage?.recentErrors || 0,
      lastUsedAt: usage?.lastUsedAt || null,
      recentErrorSamples: usage?.recentErrorSamples || [],
    };
  };

  const groups: GatewayAdminToolsResponse['groups'] = getKnownToolGroups()
    .filter((group) => group.tools.length > 0)
    .map((group) => ({
      label: group.label,
      tools: group.tools.map((name) => mapTool(name, group.label, 'builtin')),
    }));

  if (pluginToolNames.length > 0) {
    groups.push({
      label: 'Plugins',
      tools: pluginToolNames.map((name) => mapTool(name, 'Plugins', 'plugin')),
    });
  }

  const enabledMcpNamespaces = new Set(
    buildMcpServerNamespaces(
      Object.entries(getRuntimeConfig().mcpServers)
        .filter(([, config]) => config.enabled !== false)
        .map(([name]) => name),
    ).values(),
  );
  const mcpTools = Array.from(usageByTool.keys())
    .filter((name) => !isKnownToolName(name) && name.includes('__'))
    .filter((name) =>
      enabledMcpNamespaces.has(name.slice(0, name.indexOf('__'))),
    )
    .sort((left, right) => left.localeCompare(right));

  if (mcpTools.length > 0) {
    groups.push({
      label: 'MCP',
      tools: mcpTools.map((name) => mapTool(name, 'MCP', 'mcp')),
    });
  }

  const builtinTools = groups
    .filter((group) => group.label !== 'Plugins' && group.label !== 'MCP')
    .reduce((sum, group) => sum + group.tools.length, 0);
  const mcpToolCount = groups
    .filter((group) => group.label === 'MCP')
    .reduce((sum, group) => sum + group.tools.length, 0);

  return {
    totals: {
      totalTools: groups.reduce((sum, group) => sum + group.tools.length, 0),
      builtinTools,
      mcpTools: mcpToolCount,
      otherTools: 0,
      recentExecutions: recentExecutions.length,
      recentErrors: recentExecutions.filter((entry) => entry.isError).length,
    },
    groups,
    recentExecutions: recentExecutions.slice(0, 40),
  };
}

function resolveKnownNonHybridProviderKey(
  prefix: string,
): GatewayModelProviderKey {
  const normalized = prefix.replace(/\/+$/g, '');
  if (normalized === 'openai-codex') return 'codex';
  return normalized as GatewayModelProviderKey;
}

const MODEL_PROVIDER_KEY_BY_PREFIX: Array<[string, GatewayModelProviderKey]> = [
  [HYBRIDAI_MODEL_PREFIX, 'hybridai'],
  ...NON_HYBRID_PROVIDER_PREFIXES.map(
    (prefix): [string, GatewayModelProviderKey] => [
      prefix,
      resolveKnownNonHybridProviderKey(prefix),
    ],
  ),
];

// Bare slugs (no `provider/` prefix) are HybridAI passthroughs by gateway
// convention — that's what `runtimeConfig.hybridai.defaultModel` carries and
// what `/model set <slug>` resolves through.
function resolveModelProviderKey(
  modelId: string,
  options: {
    localBackend?: GatewayModelProviderKey | null;
    localEndpoints?: RuntimeConfig['local']['endpoints'];
    providerHint?: GatewayModelProviderKey | null;
  } = {},
): GatewayModelProviderKey {
  const endpointPrefix = modelId.trim().split('/', 1)[0]?.trim() ?? '';
  const localEndpoint = options.localEndpoints?.find(
    (endpoint) => endpoint.enabled === true && endpoint.name === endpointPrefix,
  );
  if (localEndpoint) return localEndpoint.type;
  const normalized = modelId.trim().toLowerCase();
  for (const [prefix, key] of MODEL_PROVIDER_KEY_BY_PREFIX) {
    if (normalized.startsWith(prefix)) return key;
  }
  if (options.localBackend) return options.localBackend;
  if (options.providerHint && normalized.includes('/')) {
    return options.providerHint;
  }
  // A `/`-bearing slug that didn't match any known prefix means a new provider
  // landed in the catalog without an entry here; surface it instead of silently
  // miscategorizing as HybridAI.
  if (normalized.includes('/')) {
    logger.warn(
      { modelId },
      'Unknown provider prefix in model id; defaulting to hybridai',
    );
  }
  return 'hybridai';
}

function resolveSkillsHubAuxiliaryModel(
  runtimeConfig: RuntimeConfig,
): string | null {
  const policy = runtimeConfig.auxiliaryModels.skills_hub;
  const model = policy.model.trim();
  if (policy.provider === 'disabled') return null;
  if (policy.provider === 'auto') return model || null;
  if (!isRuntimeProviderId(policy.provider)) return model || null;
  try {
    return normalizeAuxiliaryProviderModel({
      provider: policy.provider,
      model:
        model || resolveDefaultAuxiliaryModelForProvider(policy.provider) || '',
    });
  } catch {
    return model || null;
  }
}

export async function getGatewayAdminModels(): Promise<GatewayAdminModelsResponse> {
  await refreshAvailableModelCatalogs({ includeHybridAI: true });

  const runtimeConfig = getRuntimeConfig();
  const dailyUsage = new Map(
    listUsageByModel({ window: 'daily' }).map((row) => [row.model, row]),
  );
  const monthlyUsage = new Map(
    listUsageByModel({ window: 'monthly' }).map((row) => [row.model, row]),
  );

  const skillsHubAuxiliaryModel = resolveSkillsHubAuxiliaryModel(runtimeConfig);
  const modelIds = dedupeStrings([
    runtimeConfig.hybridai.defaultModel,
    ...(skillsHubAuxiliaryModel ? [skillsHubAuxiliaryModel] : []),
    ...getAvailableModelList(),
  ]);
  const defaultModel = resolveRequestedCatalogModelName(
    runtimeConfig.hybridai.defaultModel,
    modelIds,
  );
  const providerStatus = await getGatewayAdminProviderStatus();
  const modelCountByProvider = new Map<
    keyof NonNullable<GatewayAdminModelsResponse['providerStatus']>,
    number
  >();
  const localProviderHints = new Map<string, GatewayModelProviderKey>();
  for (const provider of ['ollama', 'lmstudio', 'llamacpp', 'vllm'] as const) {
    for (const modelId of getAvailableModelList(provider)) {
      if (!localProviderHints.has(modelId)) {
        localProviderHints.set(modelId, provider);
      }
    }
  }

  const providerKeyByModel = new Map(
    modelIds.map(
      (id) =>
        [
          id,
          resolveModelProviderKey(id, {
            localBackend: getLocalModelInfo(id)?.backend || null,
            localEndpoints: runtimeConfig.local.endpoints,
            providerHint: localProviderHints.get(id) || null,
          }),
        ] as const,
    ),
  );
  for (const providerKey of providerKeyByModel.values()) {
    modelCountByProvider.set(
      providerKey,
      (modelCountByProvider.get(providerKey) || 0) + 1,
    );
  }

  for (const [providerKey, current] of Object.entries(providerStatus || {})) {
    providerStatus[
      providerKey as keyof NonNullable<
        GatewayAdminModelsResponse['providerStatus']
      >
    ] = {
      ...current,
      modelCount:
        modelCountByProvider.get(
          providerKey as keyof NonNullable<
            GatewayAdminModelsResponse['providerStatus']
          >,
        ) || 0,
    };
  }
  const sortedProviderStatus = Object.fromEntries(
    Object.entries(providerStatus).sort(
      ([leftKey, left], [rightKey, right]) => {
        const leftEnabled = left.reachable === true;
        const rightEnabled = right.reachable === true;
        if (leftEnabled !== rightEnabled) return leftEnabled ? -1 : 1;
        return leftKey.localeCompare(rightKey);
      },
    ),
  ) as NonNullable<GatewayAdminModelsResponse['providerStatus']>;

  return {
    defaultModel,
    auxiliaryModels: {
      skillsHub: {
        provider: runtimeConfig.auxiliaryModels.skills_hub.provider,
        model: skillsHubAuxiliaryModel,
      },
    },
    providerStatus: sortedProviderStatus,
    models: modelIds
      .map((modelId) => {
        const info = getLocalModelInfo(modelId);
        const metadata = getModelCatalogMetadata(modelId);
        const dailySummary = dailyUsage.get(modelId);
        const monthlySummary = monthlyUsage.get(modelId);
        return {
          id: modelId,
          provider: providerKeyByModel.get(modelId) ?? 'hybridai',
          discovered: Boolean(info),
          backend: info?.backend || null,
          contextWindow: metadata.contextWindow,
          maxTokens: metadata.maxTokens,
          pricingUsdPerToken: metadata.pricingUsdPerToken,
          capabilities: metadata.capabilities,
          metadataSources: metadata.sources,
          isReasoning: info?.isReasoning ?? metadata.capabilities.reasoning,
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
}): Promise<GatewayAdminModelsResponse> {
  const defaultModel = String(input.defaultModel || '').trim();
  if (!defaultModel) {
    throw new Error('Expected non-empty `defaultModel`.');
  }

  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultModel = defaultModel;
  });

  return getGatewayAdminModels();
}

export function getGatewayAdminMcp(): GatewayAdminMcpResponse {
  const servers = Object.entries(getRuntimeConfig().mcpServers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => ({
      name,
      enabled: config.enabled !== false,
      summary: summarizeMcpServer(config),
      config,
      auth: getMcpOAuthStatus(name, config),
    }));
  return { servers };
}

function requireConfiguredMcpServer(name: string): {
  name: string;
  config: McpServerConfig;
} {
  const parsedName = parseMcpServerName(name);
  if (!parsedName.name) {
    throw new Error(parsedName.error || 'Invalid MCP server name.');
  }
  const config = getRuntimeConfig().mcpServers[parsedName.name];
  if (!config) {
    throw new Error(`MCP server \`${parsedName.name}\` was not found.`);
  }
  return { name: parsedName.name, config };
}

export function resolveMcpOAuthRedirectUri(requestBaseUrl?: string): string {
  const base = String(requestBaseUrl || GATEWAY_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'Cannot determine the gateway base URL for the OAuth redirect.',
    );
  }
  return `${base}/api/mcp/oauth/callback`;
}

export async function startGatewayAdminMcpOAuth(input: {
  name: string;
  requestBaseUrl?: string;
}): Promise<McpOAuthStartResult> {
  const { name, config } = requireConfiguredMcpServer(input.name);
  if (!supportsMcpOAuth(config.transport)) {
    throw new Error('OAuth is only supported for http and sse MCP servers.');
  }
  if (!config.url?.trim()) {
    throw new Error(`MCP server \`${name}\` has no URL configured.`);
  }
  if (config.auth !== 'oauth') {
    updateRuntimeConfig((draft) => {
      const entry = draft.mcpServers[name];
      if (entry) entry.auth = 'oauth';
    });
  }
  return await startMcpOAuthFlow({
    serverName: name,
    serverUrl: config.url.trim(),
    redirectUri: resolveMcpOAuthRedirectUri(input.requestBaseUrl),
  });
}

export async function completeGatewayMcpOAuthCallback(input: {
  state: string;
  code: string;
}): Promise<{ serverName: string }> {
  return await completeMcpOAuthFlow(input);
}

export function getGatewayAdminMcpOAuthStatus(
  name: string,
): GatewayAdminMcpOAuthStatusResponse {
  const server = requireConfiguredMcpServer(name);
  return {
    name: server.name,
    auth: getMcpOAuthStatus(server.name, server.config),
  };
}

export function logoutGatewayAdminMcpOAuth(
  name: string,
): GatewayAdminMcpResponse {
  const server = requireConfiguredMcpServer(name);
  clearMcpOAuth(server.name);
  return getGatewayAdminMcp();
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

  updateRuntimeConfig((draft) => {
    draft.mcpServers[serverName] = parsedConfig.config as McpServerConfig;
  });
  return getGatewayAdminMcp();
}

// Deleting a server must also drop its stored OAuth credentials.
function deleteMcpServerConfig(name: string): void {
  updateRuntimeConfig((draft) => {
    delete draft.mcpServers[name];
  });
  clearMcpOAuth(name);
}

export function removeGatewayAdminMcpServer(
  name: string,
): GatewayAdminMcpResponse {
  const parsedName = parseMcpServerName(name);
  if (!parsedName.name) {
    throw new Error(parsedName.error || 'Invalid MCP server name.');
  }

  deleteMcpServerConfig(parsedName.name);
  return getGatewayAdminMcp();
}

export function getGatewayAdminAudit(params?: {
  query?: string;
  sessionId?: string;
  eventType?: string;
  since?: string;
  until?: string;
  cursor?: number;
  limit?: number;
}): GatewayAdminAuditResponse {
  const query = String(params?.query || '').trim();
  const sessionId = String(params?.sessionId || '').trim();
  const eventType = String(params?.eventType || '').trim();
  const since = String(params?.since || '').trim();
  const until = String(params?.until || '').trim();
  const cursor =
    typeof params?.cursor === 'number' && Number.isFinite(params.cursor)
      ? Math.max(0, Math.floor(params.cursor))
      : 0;
  const limit = Math.max(1, Math.min(params?.limit ?? 60, 200));

  // Fetch one extra row so we can detect a next page without a separate count.
  // `maxLimit` must also be lifted past the default 200 cap, or the +1 row gets
  // silently clamped away and `hasMore` is wrong at the page boundary.
  const rows = listStructuredAuditEntries({
    query,
    sessionId,
    eventType,
    eventTypeMatch: 'prefix',
    since: since || undefined,
    until: until || undefined,
    beforeId: cursor > 0 ? cursor : undefined,
    limit: limit + 1,
    maxLimit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  // Total rows matching the filters (ignoring the page cursor/limit) so the UI
  // can report the real match count, not just how many have been paged in.
  const total = countStructuredAuditEntries({
    query,
    sessionId,
    eventType,
    eventTypeMatch: 'prefix',
    since: since || undefined,
    until: until || undefined,
  });

  return {
    query,
    sessionId,
    eventType,
    since: since || null,
    until: until || null,
    limit,
    entries: page.map(mapAdminAuditEntry),
    nextCursor,
    total,
  };
}

function listGatewayAdminApprovalAgents(
  selectedAgentId: string,
): GatewayAdminApprovalAgent[] {
  const agents = new Map<string, GatewayAdminApprovalAgent>();

  for (const agentId of [
    selectedAgentId,
    ...listAgents().map((agent) => agent.id),
  ]) {
    const resolved = resolveAgentConfig(agentId);
    agents.set(resolved.id, {
      id: resolved.id,
      name: resolved.name || null,
      workspacePath: path.resolve(agentWorkspaceDir(resolved.id)),
    });
  }

  return [...agents.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function mapGatewayAdminPolicyRule(
  rule: ReturnType<typeof readPolicyState>['rules'][number],
): GatewayAdminPolicyRule {
  return {
    index: rule.index,
    action: rule.action,
    host: rule.host,
    port: rule.port,
    methods: [...rule.methods],
    paths: [...rule.paths],
    agent: rule.agent,
    ...(rule.comment ? { comment: rule.comment } : {}),
    ...(rule.managedByPreset ? { managedByPreset: rule.managedByPreset } : {}),
  };
}

function mapGatewayAdminPolicyStateValue(
  state: ReturnType<typeof readPolicyState>,
): GatewayAdminPolicyState {
  return {
    exists: state.exists,
    policyPath: state.policyPath,
    workspacePath: state.workspacePath,
    defaultAction: state.defaultAction,
    presets: [...state.presets],
    rules: state.rules.map(mapGatewayAdminPolicyRule),
    lanHttpAccess: {
      mode: state.lanHttpAccess.mode,
      managedRuleIndexes: [...state.lanHttpAccess.managedRuleIndexes],
    },
  };
}

function mapGatewayAdminPolicyState(agentId: string): GatewayAdminPolicyState {
  return mapGatewayAdminPolicyStateValue(
    readPolicyState(path.resolve(agentWorkspaceDir(agentId))),
  );
}

function mapGatewayAdminPolicyPresetSummary(
  preset: PolicyPresetSummary,
): GatewayAdminPolicyPresetSummary {
  return {
    name: preset.name,
    description: preset.description,
  };
}

function resolveGatewayAdminPolicyWorkspace(agentId?: string): string {
  const resolved = resolveAgentConfig(agentId);
  return path.resolve(agentWorkspaceDir(resolved.id));
}

function mapGatewayAdminPendingApproval(
  pending: ReturnType<typeof listPendingApprovals>[number],
  sessionAgentIds: Map<string, string>,
): GatewayAdminPendingApproval {
  return {
    sessionId: pending.sessionId,
    agentId: sessionAgentIds.get(pending.sessionId) || null,
    approvalId: pending.entry.approvalId,
    userId: pending.entry.userId,
    prompt: pending.entry.prompt,
    createdAt: new Date(pending.entry.createdAt).toISOString(),
    expiresAt: new Date(pending.entry.expiresAt).toISOString(),
    allowSession: pending.entry.commandAction?.allowSession === true,
    allowAgent: pending.entry.commandAction?.allowAgent === true,
    allowAll: pending.entry.commandAction?.allowAll === true,
    actionKey: pending.entry.commandAction?.actionKey?.trim() || null,
  };
}

function mapGatewayAdminSuspendedSession(
  session: ReturnType<typeof listSuspendedSessions>[number],
  sessionAgentIds: Map<string, string>,
): GatewayAdminSuspendedSession {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId || sessionAgentIds.get(session.sessionId) || null,
    approvalId: session.approvalId,
    userId: session.userId,
    prompt: session.prompt,
    status: session.status,
    modality: session.modality,
    expectedReturnKinds: session.expectedReturnKinds,
    context: session.context,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    blockedLabel: `blocked: needs ${session.modality === 'totp' ? '2FA' : session.modality}`,
  };
}

export function getGatewayAdminApprovals(params?: {
  agentId?: string;
}): GatewayAdminApprovalsResponse {
  const selectedAgentId = resolveAgentConfig(params?.agentId).id;
  const pendingApprovals = listPendingApprovals();
  const suspendedSessions = listSuspendedSessions();
  const referencedSessionIds = new Set<string>();
  for (const pending of pendingApprovals) {
    if (pending.sessionId) referencedSessionIds.add(pending.sessionId);
  }
  for (const suspended of suspendedSessions) {
    if (suspended.sessionId) referencedSessionIds.add(suspended.sessionId);
  }
  const sessionAgentIds = new Map<string, string>();
  for (const sessionId of referencedSessionIds) {
    const session = memoryService.getSessionById(sessionId);
    if (!session) continue;
    sessionAgentIds.set(
      session.id,
      resolveAgentForRequest({ session }).agentId,
    );
  }

  return {
    selectedAgentId,
    agents: listGatewayAdminApprovalAgents(selectedAgentId),
    pending: pendingApprovals.map((pending) =>
      mapGatewayAdminPendingApproval(pending, sessionAgentIds),
    ),
    suspendedSessions: suspendedSessions.map((session) =>
      mapGatewayAdminSuspendedSession(session, sessionAgentIds),
    ),
    policy: mapGatewayAdminPolicyState(selectedAgentId),
    availablePresets: listPolicyPresetSummaries().map(
      mapGatewayAdminPolicyPresetSummary,
    ),
  };
}

function syncManagedBrowserTenantPolicyProjection(): void {
  try {
    syncLocalManagedBrowserTenantPolicyFromAdminPolicies();
  } catch (error) {
    logger.warn(
      { error },
      'Failed to sync managed browser tenant policy from admin policy',
    );
  }
}

export function saveGatewayAdminPolicyRule(input: {
  agentId?: string;
  index?: number | null;
  rule: Parameters<typeof addPolicyRule>[1];
}): GatewayAdminPolicyState {
  const workspacePath = resolveGatewayAdminPolicyWorkspace(input.agentId);
  try {
    const state =
      input.index != null
        ? updatePolicyRule(workspacePath, input.index, input.rule)
        : addPolicyRule(workspacePath, input.rule);
    syncManagedBrowserTenantPolicyProjection();
    return mapGatewayAdminPolicyStateValue(state);
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function deleteGatewayAdminPolicyRule(input: {
  agentId?: string;
  index: number;
}): GatewayAdminPolicyState {
  const workspacePath = resolveGatewayAdminPolicyWorkspace(input.agentId);
  try {
    const state = deletePolicyRule(workspacePath, String(input.index)).state;
    syncManagedBrowserTenantPolicyProjection();
    return mapGatewayAdminPolicyStateValue(state);
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function saveGatewayAdminPolicyDefault(input: {
  agentId?: string;
  defaultAction: 'allow' | 'deny';
}): GatewayAdminPolicyState {
  const workspacePath = resolveGatewayAdminPolicyWorkspace(input.agentId);
  try {
    const state = setPolicyDefault(workspacePath, input.defaultAction);
    syncManagedBrowserTenantPolicyProjection();
    return mapGatewayAdminPolicyStateValue(state);
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function saveGatewayAdminPolicyLanHttpAccess(input: {
  agentId?: string;
  mode: GatewayAdminLanHttpAccessMode;
}): GatewayAdminPolicyState {
  const workspacePath = resolveGatewayAdminPolicyWorkspace(input.agentId);
  try {
    const state = setLanHttpAccessMode(workspacePath, input.mode);
    syncManagedBrowserTenantPolicyProjection();
    return mapGatewayAdminPolicyStateValue(state);
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function applyGatewayAdminPolicyPreset(input: {
  agentId?: string;
  presetName: string;
}): GatewayAdminPolicyState {
  const workspacePath = resolveGatewayAdminPolicyWorkspace(input.agentId);
  try {
    const state = applyPolicyPreset(workspacePath, input.presetName).state;
    syncManagedBrowserTenantPolicyProjection();
    return mapGatewayAdminPolicyStateValue(state);
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function mapGatewayAdminSkillBase(
  skill: SkillCatalogEntry | BlockedSkillCatalogEntry,
): Omit<
  GatewayAdminSkill,
  | 'available'
  | 'enabled'
  | 'missing'
  | 'blocked'
  | 'blockedReason'
  | 'guardFindings'
> {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    shortDescription: skill.metadata.hybridclaw.shortDescription,
    source: String(skill.source),
    userInvocable: skill.userInvocable,
    disableModelInvocation: skill.disableModelInvocation,
    always: skill.always,
    tags: skill.metadata.hybridclaw.tags,
    relatedSkills: skill.metadata.hybridclaw.relatedSkills,
    credentials: skill.manifest.credentials,
    configVariables: skill.manifest.configVariables,
  };
}

function sanitizeGatewayAdminSkillGuardFindings(
  findings: SkillGuardFinding[],
): NonNullable<GatewayAdminSkill['guardFindings']> {
  return findings.map(({ match: _match, ...finding }) => finding);
}

export function getGatewayAdminSkills(): GatewayAdminSkillsResponse {
  const runtimeConfig = getRuntimeConfig();
  const catalog = loadSkillCatalogs();
  const availableSkills = catalog.available.map((skill) => ({
    ...mapGatewayAdminSkillBase(skill),
    available: skill.available,
    enabled: skill.enabled,
    missing: skill.missing,
  }));
  const blockedSkills = catalog.blocked.map((skill) => ({
    ...mapGatewayAdminSkillBase(skill),
    available: false,
    enabled: false,
    blocked: true,
    blockedReason: skill.blockedReason,
    guardFindings: sanitizeGatewayAdminSkillGuardFindings(skill.guardFindings),
    missing: [skill.blockedReason],
  }));
  return {
    extraDirs: runtimeConfig.skills.extraDirs,
    disabled: dedupeStrings(runtimeConfig.skills.disabled).sort((a, b) =>
      a.localeCompare(b),
    ),
    channelDisabled: getAdminChannelDisabledSkills(
      runtimeConfig.skills.channelDisabled,
    ),
    skills: [...availableSkills, ...blockedSkills].sort((left, right) => {
      const categoryCompare = left.category.localeCompare(right.category);
      return categoryCompare || left.name.localeCompare(right.name);
    }),
  };
}

export function getGatewayAdminAgentScoreboard(): GatewayAdminAgentScoreboardResponse {
  return {
    observed_skill_count: getObservedAgentSkillCount(),
    agents: getAgentScoreboard().map(({ cv_path, ...entry }) => ({
      ...entry,
      best_skills: entry.best_skills.map((score) => ({ ...score })),
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

export function unblockGatewayAdminSkill(input: {
  name: string;
}): GatewayAdminSkillsResponse {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new GatewayRequestError(400, 'Expected non-empty skill `name`.');
  }

  try {
    unblockGuardedSkill(name, 'admin-console');
  } catch (error) {
    if (!(error instanceof SkillGuardUnblockInputError)) {
      throw error;
    }
    throw new GatewayRequestError(400, error.message);
  }

  return getGatewayAdminSkills();
}

function normalizeCreatedSkillCategory(raw: string | undefined): string {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'uncategorized';
}

function assertGatewayAdminSkillAllowed(
  skillName: string,
  skillPath: string,
): void {
  const guardDecision = guardSkillDirectory({
    skillName,
    skillPath,
    sourceTag: 'workspace',
  });
  if (guardDecision.allowed) {
    return;
  }
  throw new GatewayRequestError(
    400,
    `Skill \`${skillName}\` was blocked by the security scanner: ${guardDecision.reason}.`,
  );
}

export function createGatewayAdminSkill(input: {
  name: string;
  description: string;
  category?: string;
  shortDescription?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  tags?: string[];
  body: string;
  files?: Array<{ path: string; content: string }>;
}): GatewayAdminSkillsResponse {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new GatewayRequestError(400, 'Expected non-empty skill `name`.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new GatewayRequestError(
      400,
      'Skill name must be lowercase alphanumeric with hyphens (e.g. "my-skill").',
    );
  }
  if (name.length > 64) {
    throw new GatewayRequestError(
      400,
      'Skill name must be 64 characters or fewer.',
    );
  }
  const description = String(input.description || '').trim();
  if (!description) {
    throw new GatewayRequestError(
      400,
      'Expected non-empty skill `description`.',
    );
  }
  const category = normalizeCreatedSkillCategory(input.category);
  const shortDescription = String(input.shortDescription || '').trim();

  const projectSkillsDir = resolveManagedCommunitySkillsDir();
  const skillDir = path.join(projectSkillsDir, name);

  if (fs.existsSync(skillDir)) {
    throw new GatewayRequestError(
      409,
      `Skill \`${name}\` already exists at ${skillDir}.`,
    );
  }

  const userInvocable =
    input.userInvocable !== undefined ? input.userInvocable : true;
  const disableModelInvocation =
    input.disableModelInvocation !== undefined
      ? input.disableModelInvocation
      : false;
  const tags = Array.isArray(input.tags) ? input.tags : [];

  const frontmatterLines = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    `user-invocable: ${userInvocable}`,
    `disable-model-invocation: ${disableModelInvocation}`,
  ];
  if (category || shortDescription || tags.length > 0) {
    frontmatterLines.push('metadata:');
    frontmatterLines.push('  hybridclaw:');
    frontmatterLines.push(`    category: ${JSON.stringify(category)}`);
    if (shortDescription) {
      frontmatterLines.push(
        `    short_description: ${JSON.stringify(shortDescription)}`,
      );
    }
    if (tags.length > 0) {
      frontmatterLines.push('    tags:');
      for (const tag of tags) {
        frontmatterLines.push(`      - ${JSON.stringify(String(tag))}`);
      }
    }
  }
  frontmatterLines.push('---');

  const body = String(input.body || '').trim();
  const content = `${frontmatterLines.join('\n')}\n\n${body}\n`;

  // Validate all file paths before writing anything to disk
  const files = Array.isArray(input.files) ? input.files : [];
  const resolvedFiles: Array<{ relativePath: string; content: string }> = [];
  for (const file of files) {
    const filePath = String(file.path || '').trim();
    if (!filePath) {
      throw new GatewayRequestError(
        400,
        'Skill file paths must be non-empty and include a filename.',
      );
    }
    if (filePath.endsWith('/') || filePath.endsWith(path.sep)) {
      throw new GatewayRequestError(
        400,
        `File path \`${filePath}\` must include a filename.`,
      );
    }
    const resolved = path.resolve(skillDir, filePath);
    if (!resolved.startsWith(skillDir + path.sep)) {
      throw new GatewayRequestError(
        400,
        `File path \`${filePath}\` escapes the skill directory.`,
      );
    }
    resolvedFiles.push({
      relativePath: path.relative(skillDir, resolved),
      content: file.content || '',
    });
  }

  // Stage outside skills/ so catalog scans never see partial skill directories.
  fs.mkdirSync(projectSkillsDir, { recursive: true });
  const stagedSkillDir = fs.mkdtempSync(
    path.join(projectSkillsDir, `.${name}.create-`),
  );
  try {
    fs.writeFileSync(path.join(stagedSkillDir, 'SKILL.md'), content, 'utf-8');
    for (const file of resolvedFiles) {
      const stagedFilePath = path.join(stagedSkillDir, file.relativePath);
      fs.mkdirSync(path.dirname(stagedFilePath), { recursive: true });
      fs.writeFileSync(stagedFilePath, file.content, 'utf-8');
    }
    assertGatewayAdminSkillAllowed(name, stagedSkillDir);
    try {
      fs.renameSync(stagedSkillDir, skillDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === 'EEXIST' ||
        code === 'ENOTEMPTY' ||
        fs.existsSync(skillDir)
      ) {
        throw new GatewayRequestError(
          409,
          `Skill \`${name}\` already exists at ${skillDir}.`,
        );
      }
      throw error;
    }
  } catch (error) {
    fs.rmSync(stagedSkillDir, { recursive: true, force: true });
    throw error;
  }

  return getGatewayAdminSkills();
}

const SKILL_ZIP_MAX_BYTES = 10 * 1024 * 1024;
const SKILL_ZIP_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const SKILL_ZIP_MAX_FILES = 200;
const SKILL_ZIP_IGNORED_TOP_LEVEL_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SKILL_ZIP_IGNORED_TOP_LEVEL_DIRECTORIES = new Set(['__MACOSX']);
const SKILL_ZIP_SERVER_ERROR_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);

function toSkillZipArchiveRequestError(error: unknown): GatewayRequestError {
  if (error instanceof GatewayRequestError) {
    return error;
  }
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  if (SKILL_ZIP_SERVER_ERROR_CODES.has(code)) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GatewayRequestError(
    400,
    message.startsWith('ZIP ')
      ? message
      : 'Uploaded file is not a valid skill ZIP archive.',
  );
}

function isIgnoredSkillZipTopLevelEntry(entry: fs.Dirent): boolean {
  return entry.isDirectory()
    ? SKILL_ZIP_IGNORED_TOP_LEVEL_DIRECTORIES.has(entry.name)
    : SKILL_ZIP_IGNORED_TOP_LEVEL_FILES.has(entry.name);
}

function resolveUploadedSkillZipRoot(extractedDir: string): string {
  if (fs.existsSync(path.join(extractedDir, 'SKILL.md'))) {
    return extractedDir;
  }

  const topEntries = fs
    .readdirSync(extractedDir, { withFileTypes: true })
    .filter((entry) => !isIgnoredSkillZipTopLevelEntry(entry));

  if (topEntries.length === 1 && topEntries[0].isDirectory()) {
    return path.join(extractedDir, topEntries[0].name);
  }

  return extractedDir;
}

export async function uploadGatewayAdminSkillZip(
  zipBuffer: Buffer,
  options: { force?: boolean } = {},
): Promise<GatewayAdminSkillsResponse> {
  if (zipBuffer.length === 0) {
    throw new GatewayRequestError(400, 'Uploaded file is empty.');
  }
  if (zipBuffer.length > SKILL_ZIP_MAX_BYTES) {
    throw new GatewayRequestError(
      413,
      `Skill ZIP exceeds the ${SKILL_ZIP_MAX_BYTES} byte limit.`,
    );
  }

  // Write buffer to a temp file for yauzl
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-skill-'));
  const tmpZipPath = path.join(tmpDir, 'upload.zip');
  const tmpExtractDir = path.join(tmpDir, 'extracted');
  try {
    fs.writeFileSync(tmpZipPath, zipBuffer);

    // safeExtractZip handles structural security: symlinks, path traversal,
    // encrypted entries, null bytes, absolute paths
    try {
      await safeExtractZip(tmpZipPath, tmpExtractDir);
    } catch (error) {
      throw toSkillZipArchiveRequestError(error);
    }

    // Enforce skill-specific size and file count limits (safeExtractZip's
    // 512MB / 10k-entry budget is for CLAW archives — too generous here)
    let totalBytes = 0;
    let fileCount = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
        } else {
          fileCount += 1;
          totalBytes += fs.statSync(path.join(dir, entry.name)).size;
        }
        if (fileCount > SKILL_ZIP_MAX_FILES) {
          throw new GatewayRequestError(
            400,
            `Skill ZIP exceeds the ${SKILL_ZIP_MAX_FILES} file limit.`,
          );
        }
        if (totalBytes > SKILL_ZIP_MAX_UNCOMPRESSED_BYTES) {
          throw new GatewayRequestError(
            400,
            `Skill ZIP exceeds the ${SKILL_ZIP_MAX_UNCOMPRESSED_BYTES} byte uncompressed limit.`,
          );
        }
      }
    };
    walk(tmpExtractDir);

    // ZIP may contain a top-level wrapper directory plus archive metadata
    // such as __MACOSX/ or .DS_Store — ignore those when unwrapping.
    const skillRoot = resolveUploadedSkillZipRoot(tmpExtractDir);

    // Validate SKILL.md exists
    const manifestPath = path.join(skillRoot, 'SKILL.md');
    if (!fs.existsSync(manifestPath)) {
      throw new GatewayRequestError(
        400,
        'ZIP archive does not contain a SKILL.md file at the root.',
      );
    }

    // Extract skill name from frontmatter
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const nameMatch = manifestContent.match(/^---[\s\S]*?^name:\s*(.+?)$/m);
    const skillName = nameMatch
      ? nameMatch[1].trim().replace(/^["']|["']$/g, '')
      : '';
    if (!skillName) {
      throw new GatewayRequestError(
        400,
        'SKILL.md is missing a `name` field in its frontmatter.',
      );
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) {
      throw new GatewayRequestError(
        400,
        `Skill name "${skillName}" must be lowercase alphanumeric with hyphens.`,
      );
    }
    if (skillName.length > 64) {
      throw new GatewayRequestError(
        400,
        'Skill name must be 64 characters or fewer.',
      );
    }
    assertGatewayAdminSkillAllowed(skillName, skillRoot);

    const projectSkillsDir = resolveManagedCommunitySkillsDir();
    const targetDir = path.join(projectSkillsDir, skillName);
    const targetExists = fs.existsSync(targetDir);
    if (targetExists && !options.force) {
      throw new GatewayRequestError(
        409,
        `Skill \`${skillName}\` already exists at ${targetDir}.`,
      );
    }
    // Copy extracted skill to a sibling staging directory first (copy instead
    // of rename to avoid EXDEV when tmp and skills/ are on different mounts).
    // The existing skill is moved aside only after the copy succeeds.
    fs.mkdirSync(projectSkillsDir, { recursive: true });
    const stagedParentDir = fs.mkdtempSync(
      path.join(projectSkillsDir, `.${skillName}.upload-`),
    );
    const stagedSkillDir = path.join(stagedParentDir, skillName);
    let replacedParentDir: string | undefined;
    let replacedSkillDir: string | undefined;
    try {
      fs.cpSync(skillRoot, stagedSkillDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });

      if (targetExists) {
        replacedParentDir = fs.mkdtempSync(
          path.join(projectSkillsDir, `.${skillName}.replace-`),
        );
        replacedSkillDir = path.join(replacedParentDir, skillName);
        fs.renameSync(targetDir, replacedSkillDir);
      }

      try {
        fs.renameSync(stagedSkillDir, targetDir);
      } catch (error) {
        if (replacedSkillDir && fs.existsSync(replacedSkillDir)) {
          if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
          }
          fs.renameSync(replacedSkillDir, targetDir);
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code === 'EEXIST' ||
          code === 'ENOTEMPTY' ||
          fs.existsSync(targetDir)
        ) {
          throw new GatewayRequestError(
            409,
            `Skill \`${skillName}\` already exists at ${targetDir}.`,
          );
        }
        throw error;
      }

      if (replacedParentDir) {
        fs.rmSync(replacedParentDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(stagedParentDir, { recursive: true, force: true });
      if (
        replacedParentDir &&
        (!replacedSkillDir || !fs.existsSync(replacedSkillDir))
      ) {
        fs.rmSync(replacedParentDir, { recursive: true, force: true });
      }
    }

    return getGatewayAdminSkills();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
  return collapseRepeatedBootstrapBlock(String(normalized.result || '').trim());
}

function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}

function sameBootstrapLines(left: string[], right: string[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every(
    (line, index) => line.trimEnd() === right[index]?.trimEnd(),
  );
}

function collapseRepeatedBootstrapBlock(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  const lines = normalized.split('\n');
  for (let split = 1; split < lines.length; split += 1) {
    const left = trimEmptyEdges(lines.slice(0, split));
    const right = trimEmptyEdges(lines.slice(split));
    if (sameBootstrapLines(left, right)) {
      return left.join('\n').trim();
    }
  }
  return normalized;
}

function resolveBootstrapAutostartContext(params: {
  sessionId: string;
  channelId?: string | null;
  agentId?: string | null;
  allowExistingSessionMessages?: boolean;
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
    !params.allowExistingSessionMessages &&
    (session.message_count > 0 ||
      String(session.session_summary || '').trim().length > 0)
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
  allowExistingSessionMessages?: boolean;
}): Promise<void> {
  const context = resolveBootstrapAutostartContext(params);
  if (!context) return;
  const { channelId, session, resolved, bootstrapFile } = context;
  const markerKey = getBootstrapAutostartMarkerKey(resolved.agentId);
  const lockKey = getBootstrapAutostartLockKey(session.id, resolved.agentId);
  if (activeBootstrapAutostartSessions.has(lockKey)) {
    return;
  }
  activeBootstrapAutostartSessions.add(lockKey);

  try {
    if (getMemoryValue(session.id, markerKey)) {
      return;
    }
    const markerStartedAt = new Date().toISOString();
    setMemoryValue(session.id, markerKey, {
      status: 'started',
      fileName: bootstrapFile,
      at: markerStartedAt,
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
      deleteMemoryValue(session.id, markerKey);
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
        workspacePath,
      });
      await pluginManager.notifyBeforeAgentStart({
        sessionId: session.id,
        userId: normalizedUserId,
        agentId: resolved.agentId,
        channelId,
        model: resolved.model || undefined,
      });
    }

    const storeBootstrapAssistantMessage = (content: string): number => {
      const assistantMessageId = memoryService.storeMessage({
        sessionId: session.id,
        userId: 'assistant',
        username: null,
        role: 'assistant',
        content,
        agentId: resolved.agentId,
      });
      appendSessionTranscript(resolved.agentId, {
        sessionId: session.id,
        channelId,
        role: 'assistant',
        userId: 'assistant',
        username: null,
        content,
      });
      return assistantMessageId;
    };
    const preludeText = await generateBootstrapPrelude({
      agentId: resolved.agentId,
      fileName: bootstrapFile,
      model: resolved.model,
      chatbotId,
    });
    const hasPrelude = Boolean(preludeText);
    if (preludeText) {
      storeBootstrapAssistantMessage(preludeText);
    }
    const baseAssistantMessages = hasPrelude ? 1 : 0;

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
        dynamicContext: readDynamicContextMessage(messages),
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
      fullAutoNeverApproveTools: [
        ...FULLAUTO_NEVER_APPROVE_TOOLS,
        ...loadPolicyFullAutoNeverApprove(agentWorkspaceDir(resolved.agentId)),
      ],
      scheduledTasks: [],
      pluginTools: pluginManager?.getToolDefinitions() ?? [],
    });
    if (pluginManager) {
      await pluginManager.notifyMemoryWrites({
        sessionId: session.id,
        agentId: resolved.agentId,
        channelId,
        toolExecutions: output.toolExecutions || [],
      });
    }
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
        runtime: resolveTurnRuntimeAuditLabel(resolved.model, output),
        codexRuntime: output.codexRuntime || null,
        durationMs: Date.now() - startedAt,
        toolCallCount: (output.toolExecutions || []).length,
        ...usagePayload,
      },
    });
    enqueueTokenUsage({
      sessionId: session.id,
      agentId: resolved.agentId,
      model: resolved.model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      toolCalls: (output.toolExecutions || []).length,
      costUsd: await resolveUsageCostUsdAfterMetadataRefresh({
        model: resolved.model,
        tokenUsage: output.tokenUsage,
        usage: usagePayload,
      }),
      auditRunId: runId,
    });
    for (const event of buildMediaGenerationUsageEvents({
      sessionId: session.id,
      agentId: resolved.agentId,
      auditRunId: runId,
      toolExecutions: output.toolExecutions || [],
    })) {
      enqueueTokenUsage(event);
    }

    if (output.status !== 'success' || !resultText) {
      deleteMemoryValue(session.id, markerKey);
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
            assistantMessages: baseAssistantMessages,
            toolCalls: (output.toolExecutions || []).length,
            durationMs: Date.now() - startedAt,
          },
        },
      });
      return;
    }

    const assistantMessageId = storeBootstrapAssistantMessage(resultText);
    setMemoryValue(session.id, markerKey, {
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
          assistantMessages: baseAssistantMessages + 1,
          toolCalls: (output.toolExecutions || []).length,
          durationMs: Date.now() - startedAt,
        },
      },
    });
  } catch (error) {
    deleteMemoryValue(session.id, markerKey);
    logger.warn(
      { sessionId: session.id, agentId: resolved.agentId, channelId, error },
      'Failed to run bootstrap autostart turn',
    );
  } finally {
    activeBootstrapAutostartSessions.delete(lockKey);
  }
}

export function getGatewayBootstrapAutostartState(params: {
  sessionId: string;
  channelId?: string | null;
  agentId?: string | null;
  allowExistingSessionMessages?: boolean;
}): {
  status: 'idle' | 'starting' | 'completed';
  fileName: 'BOOTSTRAP.md' | 'OPENING.md';
} | null {
  const context = resolveBootstrapAutostartContext(params);
  if (!context) return null;
  const { session, resolved, bootstrapFile } = context;

  const marker = getMemoryValue(
    session.id,
    getBootstrapAutostartMarkerKey(resolved.agentId),
  ) as {
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
  options?: {
    operatorUserId?: string | null;
  },
): ConversationHistoryPage {
  const page = memoryService.getConversationHistoryPage(
    sessionId,
    Math.max(1, Math.min(limit, 200)),
  );
  const ratingOperatorUserId = options?.operatorUserId?.trim() || '';
  const responseRatings = ratingOperatorUserId
    ? getResponseRatingsForMessages({
        sessionId: page.sessionId,
        messageIds: page.history
          .filter((message) => message.role === 'assistant')
          .map((message) => message.id),
        operatorUserId: ratingOperatorUserId,
      })
    : new Map();
  const history = page.history
    .filter((message) => {
      if (message.role !== 'assistant') return true;
      return (
        !isSilentReply(message.content) &&
        !isApprovalHistoryMessage(message.content)
      );
    })
    .map((message) => {
      if (message.role !== 'assistant') return message;
      const content = stripSilentToken(message.content);
      const assistantPresentation =
        getGatewayAssistantPresentationForMessageAgent(message.agent_id);
      const responseRating = responseRatings.get(message.id) ?? null;
      if (
        content === message.content &&
        !assistantPresentation &&
        !responseRating
      ) {
        return message;
      }
      return {
        ...message,
        ...(content !== message.content ? { content } : {}),
        ...(assistantPresentation ? { assistantPresentation } : {}),
        ...(responseRating ? { response_rating: responseRating } : {}),
      };
    })
    .filter((message) => message.content.trim().length > 0)
    .reverse();
  return {
    sessionId: page.sessionId,
    agentId: page.agentId,
    sessionKey: page.sessionKey,
    mainSessionKey: page.mainSessionKey,
    history,
    branchFamilies: page.branchFamilies,
  };
}

export function getGatewayAgentList(): GatewayAgentListResponse {
  return {
    agents: listAgents().map((agent) => {
      const presentation = getGatewayAssistantPresentationForAgent(agent.id);
      return {
        id: agent.id,
        name: agent.name || null,
        ...(presentation.imageUrl ? { imageUrl: presentation.imageUrl } : {}),
        ...(agent.emptyChatHeader
          ? { emptyChatHeader: agent.emptyChatHeader }
          : {}),
      };
    }),
  };
}

export function getGatewayRecentChatSessions(params: {
  userId: string;
  channelId?: string | null;
  limit?: number;
  query?: string | null;
  fallbackToChannelRecent?: boolean;
  includeScheduled?: boolean;
}): GatewayRecentChatSession[] {
  const sessions = getRecentSessionsForUser({
    userId: params.userId,
    channelId: params.channelId || 'web',
    limit: params.limit,
    query: params.query,
    includeScheduled: params.includeScheduled,
  });
  if (!params.fallbackToChannelRecent) {
    return sessions;
  }
  const channelSessions = getRecentSessionsForChannel({
    channelId: params.channelId || 'web',
    limit: params.limit,
    query: params.query,
    includeScheduled: params.includeScheduled,
  });
  const merged = new Map<string, GatewayRecentChatSession>();
  for (const session of [...channelSessions, ...sessions]) {
    merged.set(session.sessionId, session);
  }
  return [...merged.values()]
    .sort(
      (a, b) => Date.parse(b.lastActive || '') - Date.parse(a.lastActive || ''),
    )
    .slice(0, params.limit ?? 20);
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
  const nonce = randomUUID();
  return `delegate:d${nextDepth}:${safeParent}:${Date.now()}:${nonce}`;
}

function resolveSubagentAllowedTools(depth: number): string[] {
  if (depth < PROACTIVE_DELEGATION_MAX_DEPTH)
    return ORCHESTRATOR_SUBAGENT_ALLOWED_TOOLS;
  return BASE_SUBAGENT_ALLOWED_TOOLS;
}

function buildSubagentSystemPrompt(params: {
  canDelegate: boolean;
  allowedTools: string[];
}): string {
  const { canDelegate, allowedTools } = params;
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
    '## Delegation Capability',
    delegationLine,
    '',
    ...(toolsSummary ? [toolsSummary, ''] : []),
    '## Rules',
    '- Do not interact with users directly.',
    '- Do not create schedules or persistent autonomous workflows.',
    '- Do as many tool calls as needed until you have all the information required to fully answer the task.',
    '- When using `web_search`, use multiple searches with varied search terms so you get a more diverse and complete result.',
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

function buildSubagentUserPrompt(params: {
  depth: number;
  mode: DelegationMode;
  canDelegate: boolean;
  taskPrompt: string;
}): string {
  const { depth, mode, canDelegate, taskPrompt } = params;
  const assignmentHints = formatAgentAssignmentHints(taskPrompt);
  return [
    '# Delegated Task',
    `Delegation mode: ${mode}.`,
    `Current delegation depth: ${depth}.`,
    canDelegate
      ? 'Delegation capability: You may delegate further only if absolutely necessary and still within depth/turn limits.'
      : 'Delegation capability: You are a leaf subagent. Do not delegate further work.',
    '',
    ...(assignmentHints ? [assignmentHints, ''] : []),
    'Task handoff from parent:',
    taskPrompt,
  ].join('\n');
}

function inferDelegationStatus(errorText: string): DelegationRunStatus {
  return /timeout|timed out|deadline exceeded/i.test(errorText)
    ? 'timeout'
    : 'failed';
}

function extractDelegationTokenCount(
  tokenUsage?: TokenUsageStats,
): number | undefined {
  if (!tokenUsage) return undefined;
  const total = tokenUsage.apiUsageAvailable
    ? tokenUsage.apiTotalTokens
    : tokenUsage.estimatedTotalTokens;
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return Math.round(total);
}

function formatDelegationTokenCount(tokenCount?: number): string {
  if (!tokenCount || tokenCount <= 0) return '';
  if (tokenCount < 1_000) return `${tokenCount} tokens`;
  return `${(tokenCount / 1_000).toFixed(1)}k tokens`;
}

function parseToolProgressPreviewObject(
  preview: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(preview);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function firstStringToolArg(
  args: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const strings = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (strings.length > 0) return strings.join(', ');
    }
  }
  return '';
}

function extractToolProgressPreviewValue(preview: string, key: string): string {
  const match = preview.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,200})`));
  return match?.[1]?.trim() || '';
}

function formatDelegationToolDetail(event: ToolProgressEvent): string {
  const preview = String(event.preview || '').trim();
  if (!preview) return '';

  const args = parseToolProgressPreviewObject(preview);
  if (args) {
    const toolName = event.toolName.toLowerCase();
    const url = firstStringToolArg(args, ['url', 'href', 'uri']);
    if (
      url &&
      (toolName.includes('web') ||
        toolName.includes('browser') ||
        toolName.includes('http'))
    ) {
      return abbreviateForUser(url, 96);
    }
    const query = firstStringToolArg(args, ['query', 'q', 'search_query']);
    if (query) return abbreviateForUser(query, 96);
    const pathValue = firstStringToolArg(args, [
      'path',
      'file',
      'file_path',
      'cwd',
      'workdir',
    ]);
    if (pathValue) return abbreviateForUser(pathValue, 96);
    const command = firstStringToolArg(args, ['cmd', 'command']);
    if (command) return abbreviateForUser(command, 96);
    const selector = firstStringToolArg(args, ['selector', 'ref_id', 'id']);
    if (selector) return abbreviateForUser(selector, 96);
  }

  for (const key of ['url', 'href', 'uri', 'query', 'q', 'path', 'cmd']) {
    const value = extractToolProgressPreviewValue(preview, key);
    if (value) return abbreviateForUser(value, 96);
  }

  return abbreviateForUser(preview, 96);
}

function normalizeDelegationTask(
  raw: unknown,
  params: {
    fallbackModel: string;
    parentModel: string;
    configuredDelegateModel: string;
  },
): NormalizedDelegationTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as DelegationTaskSpec;
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt) return null;
  const label = typeof task.label === 'string' ? task.label.trim() : '';
  const model = resolveDelegationRequestedModel({
    requestedModel: task.model,
    fallbackModel: params.fallbackModel,
    parentModel: params.parentModel,
    configuredDelegateModel: params.configuredDelegateModel,
  });
  return {
    prompt,
    label: label || undefined,
    model,
  };
}

function resolveDelegationFallbackModel(parentModel: string): string {
  return getRuntimeConfig().proactive.delegation.model.trim() || parentModel;
}

function areEquivalentDelegationModels(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftTrimmed = String(left || '').trim();
  const rightTrimmed = String(right || '').trim();
  if (!leftTrimmed || !rightTrimmed) return false;
  if (
    leftTrimmed.localeCompare(rightTrimmed, undefined, {
      sensitivity: 'accent',
    }) === 0
  ) {
    return true;
  }
  return (
    normalizeHybridAIModelForRuntime(leftTrimmed).toLowerCase() ===
    normalizeHybridAIModelForRuntime(rightTrimmed).toLowerCase()
  );
}

function resolveDelegationRequestedModel(params: {
  requestedModel: string | null | undefined;
  fallbackModel: string;
  parentModel: string;
  configuredDelegateModel: string;
}): string {
  const requestedModel = String(params.requestedModel || '').trim();
  if (!requestedModel) return params.fallbackModel;
  if (
    params.configuredDelegateModel &&
    params.parentModel &&
    areEquivalentDelegationModels(requestedModel, params.parentModel) &&
    !areEquivalentDelegationModels(
      requestedModel,
      params.configuredDelegateModel,
    )
  ) {
    return params.configuredDelegateModel;
  }
  return requestedModel;
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
  const configuredDelegateModel =
    getRuntimeConfig().proactive.delegation.model.trim();
  const resolvedFallbackModel =
    configuredDelegateModel || resolveDelegationFallbackModel(fallbackModel);
  const baseModel = resolveDelegationRequestedModel({
    requestedModel: effect.model,
    fallbackModel: resolvedFallbackModel,
    parentModel: fallbackModel,
    configuredDelegateModel,
  });
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
    const normalized = normalizeDelegationTask(sourceTasks[i], {
      fallbackModel: baseModel,
      parentModel: fallbackModel,
      configuredDelegateModel,
    });
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
  if (task.label && !/[-_]/.test(task.label)) return task.label;
  const promptTitle = task.prompt
    .split(/\r?\n/, 1)[0]
    ?.replace(/\s+/g, ' ')
    .replace(/[.:;,\s]+$/, '')
    .trim();
  if (promptTitle) return abbreviateForUser(promptTitle, 72);
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
    onToolProgress,
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
  const sessionId = nextDelegationSessionId(parentSessionId, childDepth);
  const requestMessages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSubagentSystemPrompt({
        canDelegate,
        allowedTools,
      }),
    },
    {
      role: 'user',
      content: buildSubagentUserPrompt({
        depth: childDepth,
        mode,
        canDelegate,
        taskPrompt: task.prompt,
      }),
    },
  ];
  let lastToolsUsed: string[] = [];
  let lastToolExecutions: ToolExecution[] = [];
  let lastArtifacts: ArtifactMetadata[] | undefined;
  let lastTokenCount: number | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    const startedAt = Date.now();
    try {
      const output = await runAgent({
        sessionId,
        messages: requestMessages,
        chatbotId,
        enableRag,
        model: task.model,
        agentId,
        channelId,
        allowedTools,
        onToolProgress,
      });
      const durationMs = Date.now() - startedAt;
      lastDuration = durationMs;
      lastToolsUsed = output.toolsUsed || [];
      lastToolExecutions = output.toolExecutions || [];
      lastArtifacts = output.artifacts;
      lastTokenCount = extractDelegationTokenCount(output.tokenUsage);
      await persistDelegationAttempt({
        sessionId,
        model: task.model,
        chatbotId,
        messages: requestMessages,
        durationMs,
        output,
      });

      if (output.status === 'success' && output.result?.trim()) {
        stopSessionHostProcess(sessionId);
        return {
          status: 'completed',
          sessionId,
          model: task.model,
          durationMs,
          attempts: attempt,
          toolsUsed: output.toolsUsed || [],
          tokenCount: extractDelegationTokenCount(output.tokenUsage),
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
      await persistDelegationAttempt({
        sessionId,
        model: task.model,
        chatbotId,
        messages: requestMessages,
        durationMs,
        error: errorText,
      });
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

  stopSessionHostProcess(sessionId);
  return {
    status: lastStatus,
    sessionId,
    model: task.model,
    durationMs: lastDuration,
    attempts: attempt,
    toolsUsed: lastToolsUsed,
    toolExecutions: lastToolExecutions,
    tokenCount: lastTokenCount,
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

function formatDelegationStatus(params: {
  label?: string;
  entries: DelegationStatusEntry[];
  parentModel?: string;
}): string {
  const runningCount = params.entries.filter(
    (entry) => entry.status === 'running' || entry.status === 'queued',
  ).length;
  const finishedCount = params.entries.length - runningCount;
  const distinctDelegateModels = Array.from(
    new Set(
      params.entries
        .map((entry) => entry.model.trim())
        .filter(
          (model) =>
            model &&
            (!params.parentModel ||
              model.localeCompare(params.parentModel, undefined, {
                sensitivity: 'accent',
              }) !== 0),
        ),
    ),
  );
  const modelSuffix =
    distinctDelegateModels.length > 0
      ? ` (${distinctDelegateModels.join(', ')})`
      : '';
  const heading =
    runningCount > 0
      ? `Running ${runningCount} delegate jobs${modelSuffix}`
      : `${finishedCount} delegate jobs finished${modelSuffix}`;
  const lines = ['[Delegate Status]', heading];
  params.entries.forEach((entry, index) => {
    const prefix = index === params.entries.length - 1 ? '└' : '├';
    const donePrefix = index === params.entries.length - 1 ? '   └' : '│  └';
    const toolLabel =
      entry.toolUses === 1 ? '1 tool use' : `${entry.toolUses} tool uses`;
    const tokenLabel = formatDelegationTokenCount(entry.tokenCount);
    const statusLabel =
      entry.status === 'queued'
        ? 'initializing'
        : entry.status === 'running'
          ? entry.currentTool
            ? `running ${entry.currentTool}${entry.currentToolDetail ? ` ${entry.currentToolDetail}` : ''}`
            : entry.lastTool
              ? `thinking after ${entry.lastTool}${entry.lastToolDetail ? ` ${entry.lastToolDetail}` : ''}`
              : 'starting'
          : entry.status;
    lines.push(
      `${prefix} ${entry.title} · ${toolLabel}${tokenLabel ? ` · ${tokenLabel}` : ''}`,
    );
    lines.push(
      `${donePrefix} ${statusLabel === 'completed' ? 'Done' : statusLabel}`,
    );
  });
  return lines.join('\n');
}

async function synthesizeDelegationFinal(params: {
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  model: string;
  parentPrompt?: string;
  parentResult?: string;
  delegationResults: string;
  onTextDelta?: (delta: string) => void;
}): Promise<string | null> {
  if (!params.parentPrompt?.trim()) return null;
  const sessionId = nextDelegationSessionId(params.parentSessionId, 0);
  const output = await runAgent({
    sessionId,
    messages: [
      {
        role: 'system',
        content: [
          'You are synthesizing the final user-facing answer after delegated research completed.',
          'Use the delegated results as source material.',
          'Return only the final answer to the user.',
          'Do not say you are waiting for delegates.',
          'Do not mention internal session ids.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          'Original user request:',
          params.parentPrompt.trim(),
          '',
          'Parent provisional response:',
          params.parentResult?.trim() || '(none)',
          '',
          'Delegated results:',
          params.delegationResults.trim(),
        ].join('\n'),
      },
    ],
    chatbotId: params.chatbotId,
    enableRag: params.enableRag,
    model: params.model,
    agentId: params.agentId,
    channelId: params.channelId,
    allowedTools: [],
    onTextDelta: params.onTextDelta,
  });
  stopSessionHostProcess(sessionId);
  if (output.status !== 'success') return null;
  const result = output.result?.trim();
  return result || null;
}

function queueDelegationProactiveMessage(params: {
  parentSessionId: string;
  channelId: string;
  text: string;
  artifactCount: number;
  source?: string;
}): void {
  const { queued, dropped } = enqueueProactiveMessage(
    params.channelId,
    params.text,
    params.source || 'delegate',
    MAX_QUEUED_DELEGATION_MESSAGES,
  );
  logger.info(
    {
      parentSessionId: params.parentSessionId,
      channelId: params.channelId,
      queued,
      dropped,
      artifactCount: params.artifactCount,
    },
    'Delegation proactive message queued',
  );
  if (params.artifactCount > 0) {
    logger.warn(
      {
        parentSessionId: params.parentSessionId,
        channelId: params.channelId,
        artifactCount: params.artifactCount,
      },
      'Queued delegation message does not persist attachments; only text was queued',
    );
  }
}

function createDelegationSynthesisStream(params: {
  parentSessionId: string;
  channelId: string;
}): {
  onTextDelta: (delta: string) => void;
  finish: () => void;
  started: () => boolean;
  text: () => string;
} {
  let hasStarted = false;
  let hasFinished = false;
  let buffer = '';
  let streamedText = '';

  const queue = (source: string, text: string): void => {
    queueDelegationProactiveMessage({
      parentSessionId: params.parentSessionId,
      channelId: params.channelId,
      text,
      artifactCount: 0,
      source,
    });
  };

  const ensureStarted = (): void => {
    if (hasStarted) return;
    hasStarted = true;
    queue('delegate:stream:start', '');
  };

  const flush = (): void => {
    if (!buffer) return;
    ensureStarted();
    queue('delegate:stream:delta', buffer);
    buffer = '';
  };

  return {
    onTextDelta: (delta: string) => {
      const text = String(delta || '');
      if (!text) return;
      streamedText += text;
      buffer += text;
      if (
        buffer.length >= DELEGATION_STREAM_DELTA_FLUSH_CHARS ||
        buffer.endsWith('\n')
      ) {
        flush();
      }
    },
    finish: () => {
      if (hasFinished) return;
      hasFinished = true;
      if (!hasStarted && !buffer) return;
      flush();
      queue('delegate:stream:end', '');
    },
    started: () => hasStarted,
    text: () => streamedText,
  };
}

async function publishDelegationLifecycleMessage(params: {
  parentSessionId: string;
  channelId: string;
  text: string;
  artifacts?: ArtifactMetadata[];
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
}): Promise<void> {
  const text = params.text.trim();
  if (!text) return;
  const artifactCount = params.artifacts?.length || 0;

  if (params.onProactiveMessage) {
    try {
      await params.onProactiveMessage({
        text,
        artifacts: params.artifacts,
      });
      return;
    } catch (err) {
      logger.warn(
        {
          parentSessionId: params.parentSessionId,
          channelId: params.channelId,
          err,
        },
        'Delegation proactive callback failed; falling back to queue',
      );
    }
  }

  queueDelegationProactiveMessage({
    parentSessionId: params.parentSessionId,
    channelId: params.channelId,
    text,
    artifactCount,
  });
}

async function publishDelegationCompletion(params: {
  parentSessionId: string;
  channelId: string;
  agentId: string;
  forLLM: string;
  forUser: string;
  artifacts?: ArtifactMetadata[];
  publishForUser?: boolean;
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
    publishForUser = true,
    onProactiveMessage,
  } = params;

  memoryService.storeMessage({
    sessionId: parentSessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: forLLM,
    agentId,
  });
  appendSessionTranscript(agentId, {
    sessionId: parentSessionId,
    channelId,
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: forLLM,
  });

  if (publishForUser) {
    await publishDelegationLifecycleMessage({
      parentSessionId,
      channelId,
      text: forUser,
      artifacts,
      onProactiveMessage,
    });
  }
}

export function enqueueDelegationFromSideEffect(params: {
  plan: NormalizedDelegationPlan;
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  parentModel?: string;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  parentDepth: number;
  parentPrompt?: string;
  parentResult?: string;
}): void {
  enqueueDelegationBatchFromSideEffects({
    ...params,
    plans: [params.plan],
  });
}

export function enqueueDelegationBatchFromSideEffects(params: {
  plans: NormalizedDelegationPlan[];
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  parentModel?: string;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  parentDepth: number;
  parentPrompt?: string;
  parentResult?: string;
}): void {
  const {
    plans,
    parentSessionId,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    parentModel,
    onProactiveMessage,
    parentDepth,
    parentPrompt,
    parentResult,
  } = params;
  const activePlans = plans.filter((plan) => plan.tasks.length > 0);
  if (activePlans.length === 0) return;
  const childDepth = parentDepth + 1;
  if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
    logger.info(
      { parentSessionId, childDepth, maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH },
      'Delegation skipped — depth limit reached',
    );
    return;
  }

  const statusEntries: DelegationStatusEntry[] = [];
  const statusEntriesByPlan = activePlans.map((plan) =>
    plan.tasks.map((task, index) => {
      const entry: DelegationStatusEntry = {
        title: renderDelegationTaskTitle(
          plan.mode,
          task,
          index,
          plan.tasks.length,
        ),
        model: task.model,
        status: 'queued',
        toolUses: 0,
      };
      statusEntries.push(entry);
      return entry;
    }),
  );
  const batchLabel =
    activePlans.length === 1
      ? activePlans[0]?.label
      : activePlans
          .map((plan) => plan.label)
          .filter(Boolean)
          .join(', ') || undefined;

  const jobId = `${parentSessionId}:${Date.now()}:${randomUUID()}`;
  enqueueDelegation({
    id: jobId,
    run: async () => {
      const startedAt = Date.now();
      const entries: DelegationCompletionEntry[] = [];
      await publishDelegationLifecycleMessage({
        parentSessionId,
        channelId,
        text: formatDelegationStatus({
          label: batchLabel,
          entries: statusEntries,
          parentModel,
        }),
        onProactiveMessage,
      });

      let statusPublishChain = Promise.resolve();
      const publishStatus = (): Promise<void> => {
        const text = formatDelegationStatus({
          label: batchLabel,
          entries: statusEntries,
          parentModel,
        });
        statusPublishChain = statusPublishChain
          .catch(() => undefined)
          .then(() =>
            publishDelegationLifecycleMessage({
              parentSessionId,
              channelId,
              text,
              onProactiveMessage,
            }),
          );
        return statusPublishChain;
      };
      const runTask = async (params: {
        plan: NormalizedDelegationPlan;
        task: NormalizedDelegationTask;
        index: number;
        statusEntry: DelegationStatusEntry;
        prompt?: string;
      }): Promise<DelegationCompletionEntry> => {
        const { plan, task, statusEntry, prompt } = params;
        statusEntry.status = 'running';
        await publishStatus();
        const run = await runDelegationTaskWithRetry({
          parentSessionId,
          childDepth,
          channelId,
          chatbotId,
          enableRag,
          agentId,
          mode: plan.mode,
          task: prompt ? { ...task, prompt } : task,
          onToolProgress: (event) => {
            if (event.phase === 'finish') {
              statusEntry.toolUses += 1;
              statusEntry.lastTool = statusEntry.currentTool ?? event.toolName;
              statusEntry.lastToolDetail = statusEntry.currentToolDetail;
              statusEntry.currentTool = undefined;
              statusEntry.currentToolDetail = undefined;
              void publishStatus();
              return;
            }
            statusEntry.currentTool = event.toolName;
            statusEntry.currentToolDetail = formatDelegationToolDetail(event);
            void publishStatus();
          },
        });
        statusEntry.status = run.status;
        statusEntry.currentTool = undefined;
        statusEntry.currentToolDetail = undefined;
        statusEntry.lastTool = undefined;
        statusEntry.lastToolDetail = undefined;
        statusEntry.toolUses = Math.max(
          statusEntry.toolUses,
          run.toolsUsed.length,
        );
        statusEntry.tokenCount = run.tokenCount;
        await publishStatus();
        return {
          title: statusEntry.title,
          run,
        };
      };

      const runPlan = async (
        plan: NormalizedDelegationPlan,
        planIndex: number,
      ): Promise<DelegationCompletionEntry[]> => {
        const planStatusEntries = statusEntriesByPlan[planIndex] || [];
        if (plan.mode === 'parallel') {
          return Promise.all(
            plan.tasks.map(async (task, index) =>
              runTask({
                plan,
                task,
                index,
                statusEntry: planStatusEntries[index],
              }),
            ),
          );
        }

        if (plan.mode === 'chain') {
          const planEntries: DelegationCompletionEntry[] = [];
          let previousResult = '';
          for (let i = 0; i < plan.tasks.length; i++) {
            const task = plan.tasks[i];
            const entry = await runTask({
              plan,
              task,
              index: i,
              statusEntry: planStatusEntries[i],
              prompt: interpolateChainPrompt(task.prompt, previousResult),
            });
            planEntries.push(entry);
            if (entry.run.status !== 'completed') break;
            previousResult = entry.run.result || '';
          }
          return planEntries;
        }

        const task = plan.tasks[0];
        return [
          await runTask({
            plan,
            task,
            index: 0,
            statusEntry: planStatusEntries[0],
          }),
        ];
      };

      const planEntries = await Promise.all(
        activePlans.map(async (plan, planIndex) => runPlan(plan, planIndex)),
      );
      entries.push(...planEntries.flat());

      if (entries.length === 0) {
        logger.warn(
          { parentSessionId, planCount: activePlans.length },
          'Delegation produced no entries',
        );
        return;
      }

      const completion = formatDelegationCompletion({
        mode:
          activePlans.length === 1
            ? activePlans[0]?.mode || 'single'
            : 'parallel',
        label: batchLabel,
        entries,
        totalDurationMs: Date.now() - startedAt,
      });
      let finalForUser: string | null = null;
      let streamedFinal = false;
      let synthesisStream: ReturnType<
        typeof createDelegationSynthesisStream
      > | null = null;
      try {
        synthesisStream =
          channelId === 'tui'
            ? createDelegationSynthesisStream({
                parentSessionId,
                channelId,
              })
            : null;
        finalForUser = await synthesizeDelegationFinal({
          parentSessionId,
          channelId,
          chatbotId,
          enableRag,
          agentId,
          model: parentModel || HYBRIDAI_MODEL,
          parentPrompt,
          parentResult,
          delegationResults: completion.forLLM,
          onTextDelta: synthesisStream?.onTextDelta,
        });
        synthesisStream?.finish();
        streamedFinal =
          Boolean(finalForUser) &&
          (synthesisStream?.started() === true ||
            Boolean(synthesisStream?.text().trim()));
        if (streamedFinal && synthesisStream) {
          finalForUser = synthesisStream.text().trim() || finalForUser;
        }
      } catch (err) {
        logger.warn(
          { parentSessionId, channelId, err },
          'Delegation final synthesis failed; using completion summary',
        );
      } finally {
        synthesisStream?.finish();
      }
      await publishDelegationCompletion({
        parentSessionId,
        channelId,
        agentId,
        forLLM: completion.forLLM,
        forUser: finalForUser || completion.forUser,
        artifacts: completion.artifacts,
        publishForUser: !streamedFinal,
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

function buildGatewaySessionContextUsageSnapshot(
  session: Session,
  statusSnapshot?: SessionStatusSnapshot,
): ReturnType<typeof buildContextUsageSnapshot> {
  const runtime = resolveSessionRuntimeTarget(session);
  const sessionModel = runtime.model;
  const modelContextWindowTokens = resolveKnownModelContextWindow(sessionModel);
  return buildContextUsageSnapshot({
    sessionId: session.id,
    model: sessionModel,
    messageCount: session.message_count,
    compactionCount: session.compaction_count,
    modelContextWindowTokens,
    ...(statusSnapshot ? { statusSnapshot } : {}),
  });
}

export function getGatewaySessionContextUsage(sessionId: string): {
  status: 'ok' | 'not_found';
  sessionId: string;
  snapshot: ReturnType<typeof buildContextUsageSnapshot> | null;
} {
  const session = memoryService.getSessionById(sessionId);
  if (!session) {
    return { status: 'not_found', sessionId, snapshot: null };
  }
  return {
    status: 'ok',
    sessionId: session.id,
    snapshot: buildGatewaySessionContextUsageSnapshot(session),
  };
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
  const cmd = parseLowerArg(req.args, 0);
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
      (req.channelId === 'web' ||
        req.channelId === 'tui' ||
        req.channelId === 'cli')
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

  const result = await (async (): Promise<GatewayCommandResult> => {
    switch (cmd) {
      case 'help': {
        const help = buildLocalSessionSlashHelpEntries('web').map(
          ({ command, description }) => `\`${command}\`: ${description}`,
        );
        return infoCommand('HybridClaw Commands', help.join('\n'));
      }

      case 'agent': {
        const sub = parseLowerArg(req.args, 1);
        const switchToAgent = (
          targetAgent: AgentConfig,
        ): GatewayCommandResult => {
          updateSessionAgent(session.id, targetAgent.id);
          setActiveThreadAgentId(session, targetAgent.id);
          const model = resolveAgentModel(targetAgent) || HYBRIDAI_MODEL;
          ensureBootstrapFiles(targetAgent.id);
          const startupBootstrapFile = resolveStartupBootstrapFile(
            targetAgent.id,
          );
          void ensureGatewayBootstrapAutostart({
            sessionId: session.id,
            channelId: req.channelId,
            userId: req.userId,
            username: req.username,
            agentId: targetAgent.id,
            allowExistingSessionMessages: true,
          }).catch((error) => {
            logger.warn(
              { sessionId: session.id, agentId: targetAgent.id, error },
              'Failed to start agent hatching after switch',
            );
          });
          const hatchingSuffix =
            startupBootstrapFile === 'BOOTSTRAP.md'
              ? ' Hatching will start automatically from `BOOTSTRAP.md`.'
              : startupBootstrapFile === 'OPENING.md'
                ? ' Opening will start automatically from `OPENING.md`.'
                : '';
          return plainCommand(
            `Session agent set to \`${targetAgent.id}\` (model: \`${formatModelForDisplay(model)}\`).${hatchingSuffix}`,
          );
        };

        if (
          sub &&
          ![
            'info',
            'current',
            'list',
            'switch',
            'model',
            'create',
            'install',
          ].includes(sub)
        ) {
          const rawTarget = req.args.slice(1).join(' ').trim();
          const handle = rawTarget.replace(/^@+/, '').replace(/\s+/g, '-');
          const resolution = resolveAgentAddressing({
            content: `@${handle}`,
            currentAgentId: resolveSessionAgentId(session),
            fromAgentId: resolveSessionAgentId(session),
          });
          if (resolution.kind === 'agent') {
            const targetAgent = findAgentConfig(resolution.agentId);
            if (targetAgent) return switchToAgent(targetAgent);
          }
          if (resolution.kind === 'error') {
            return badCommand('Agent Not Found', resolution.message);
          }
          return badCommand('Usage', 'Usage: `agent <name>`');
        }

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
          const targetAgentId = parseIdArg(req.args, 2);
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
          return switchToAgent(targetAgent);
        }

        if (sub === 'model') {
          const currentAgentId = resolveSessionAgentId(session);
          const storedAgent =
            getStoredAgentConfig(currentAgentId) ??
            ({ id: currentAgentId } satisfies AgentConfig);
          const resolvedAgent = resolveAgentConfig(currentAgentId);
          const sessionOverride = formatSessionModelOverride(session.model);
          const modelName = parseIdArg(req.args, 2);

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

          await refreshAvailableModelCatalogs({
            includeHybridAI: true,
          });
          const availableModels = getAvailableModelList();
          const normalizedModelName = resolveRequestedCatalogModelName(
            modelName,
            availableModels,
          );
          await refreshAvailableModelCatalogs({
            includeHybridAI:
              resolveModelProvider(normalizedModelName) === 'hybridai',
          });
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
          const newAgentId = parseIdArg(req.args, 2);
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
              parseLowerArg(trailingArgs, 0) !== '--model' ||
              !parseIdArg(trailingArgs, 1)
            ) {
              return badCommand(
                'Usage',
                'Usage: `agent create <id> [--model <model>]`',
              );
            }
            await refreshAvailableModelCatalogs({
              includeHybridAI: true,
            });
            const availableModels = getAvailableModelList();
            modelName = resolveRequestedCatalogModelName(
              parseIdArg(trailingArgs, 1),
              availableModels,
            );
            await refreshAvailableModelCatalogs({
              includeHybridAI: resolveModelProvider(modelName) === 'hybridai',
            });
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
          const workspacePath = path.resolve(agentWorkspaceDir(created.id));
          ensureBootstrapFiles(created.id);
          return infoCommand(
            'Agent Created',
            [
              `Agent: ${created.id}`,
              `Model: ${formatModelForDisplay(resolveAgentModel(created) || HYBRIDAI_MODEL)}`,
              `Workspace: ${workspacePath}`,
              'Hatching: open or switch to a session with this agent. If BOOTSTRAP.md is active, hatching starts automatically without waiting for a user message.',
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
            const arg = parseIdArg(req.args, index);
            if (!arg) continue;
            if (arg === '--id') {
              const nextValue = parseIdArg(req.args, index + 1);
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
        const sub = parseLowerArg(req.args, 1);
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
              const botModel = formatHybridAIModelForCatalog(
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
          const previousDefaultChatbotId =
            getRuntimeConfig().hybridai.defaultChatbotId.trim();
          updateSessionChatbot(session.id, null);
          if (previousDefaultChatbotId) {
            updateRuntimeConfig(
              (draft) => {
                draft.hybridai.defaultChatbotId = '';
              },
              {
                route: 'gateway.command.bot.clear',
                source: 'gateway',
              },
            );
          }
          recordAuditEvent({
            sessionId: session.id,
            runId: makeAuditRunId('cmd'),
            event: {
              type: 'bot.clear',
              source: 'command',
              previousBotId,
              previousDefaultChatbotId,
              clearedDefaultChatbotId: Boolean(previousDefaultChatbotId),
              changed:
                previousBotId !== null || Boolean(previousDefaultChatbotId),
              userId: boundAuditActorField(req.userId),
              username: boundAuditActorField(req.username),
            },
          });
          return plainCommand(
            previousDefaultChatbotId
              ? 'Chatbot cleared for this session and default HybridAI chatbot cleared. HybridAI account fallback will be used when required.'
              : 'Chatbot cleared for this session. HybridAI account fallback will be used when required.',
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

      case 'btw': {
        const question = req.args.slice(1).join(' ').trim();
        if (!question) {
          return badCommand('Usage', 'Usage: `/btw <question>`');
        }
        try {
          return infoCommand(
            'BTW',
            await runBtwSideQuestion(session, question),
          );
        } catch (error) {
          return badCommand(
            'BTW Failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      case 'aux': {
        try {
          return infoCommand(
            'Auxiliary Model',
            await runAuxCommand(session, req.args.slice(1)),
          );
        } catch (error) {
          return badCommand(
            error instanceof AuxCommandUsageError ? 'Usage' : 'Aux Failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      case 'second-opinion': {
        try {
          return infoCommand(
            'Second Opinion',
            await runSecondOpinionCommand(session, req.args.slice(1)),
          );
        } catch (error) {
          return badCommand(
            'Second Opinion Failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      case 'model': {
        const sub = parseLowerArg(req.args, 1);
        const providerFilterArg =
          sub === 'list' ? parseIdArg(req.args, 2) : undefined;
        const listModifierArg =
          sub === 'list' ? parseLowerArg(req.args, 3) : undefined;
        const providerFilter = providerFilterArg
          ? normalizeModelCatalogProviderFilter(providerFilterArg)
          : null;
        const expandedModelList =
          listModifierArg === 'more' ||
          listModifierArg === 'all' ||
          listModifierArg === 'full';
        const needsAvailableModels =
          sub === 'list' || sub === 'default' || sub === 'set';
        const modelCatalogRefreshResult = needsAvailableModels
          ? await refreshAvailableModelCatalogs({
              includeHybridAI:
                sub !== 'list' ||
                !providerFilterArg ||
                providerFilter === 'hybridai',
            })
          : null;
        const gatewayStatus = needsAvailableModels
          ? await getGatewayStatusForModelSubcommand(sub)
          : null;
        const availableModels =
          gatewayStatus == null ? [] : getAvailableModelList();
        const runtime = resolveSessionRuntimeTarget(session);
        const currentAgentId = resolveSessionAgentId(session);
        const resolvedAgent = resolveAgentConfig(currentAgentId);
        const sessionOverride = formatSessionModelOverride(session.model);
        const fallbackModel =
          resolveAgentModel(resolvedAgent) || HYBRIDAI_MODEL;
        if (sub === 'info') {
          await refreshModelCatalogMetadata(runtime.model);
        }
        if (sub === 'list') {
          if (providerFilterArg && !providerFilter) {
            return badCommand(
              'Unknown Provider',
              'Usage: `model list [hybridai|codex|anthropic|openrouter|mistral|huggingface|local|ollama|lmstudio|llamacpp|vllm]`',
            );
          }
          if (listModifierArg && !expandedModelList) {
            return badCommand(
              'Usage',
              'Usage: `model list [hybridai|codex|anthropic|openrouter|mistral|huggingface|local|ollama|lmstudio|llamacpp|vllm]`',
            );
          }
          if (providerFilter && gatewayStatus) {
            const diagnostic = diagnoseProviderForModels(
              providerFilter,
              gatewayStatus.providerHealth,
              modelCatalogRefreshResult?.failures,
            );
            if (diagnostic) {
              return infoCommand(
                `Available Models (${providerFilterArg})`,
                diagnostic.message,
              );
            }
          }
          const listedModels =
            gatewayStatus == null
              ? []
              : getAvailableModelList(providerFilterArg);
          const current = resolveRequestedCatalogModelName(
            runtime.model,
            listedModels,
          );
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
                ? `No models available for provider \`${providerFilterArg}\`.`
                : 'No models available.',
            );
          }
          return infoCommand(
            providerFilterArg
              ? `Available Models (${providerFilterArg})`
              : 'Available Models',
            `${list}\n\n${formatModelCountSuffix(modelCatalog.length)}`,
            undefined,
            { modelCatalog },
          );
        }

        if (sub === 'default') {
          const modelName = parseIdArg(req.args, 2);
          if (!modelName) {
            const defaultModel = resolveRequestedCatalogModelName(
              HYBRIDAI_MODEL,
              availableModels,
            );
            const defaultLine = `Default model: ${formatModelForDisplay(defaultModel)}`;
            if (availableModels.length === 0) {
              return infoCommand('Default Model', defaultLine);
            }
            const list = availableModels
              .map((m) => {
                const label = formatModelForDisplay(m);
                return m === defaultModel ? `${label} (default)` : label;
              })
              .join('\n');
            return infoCommand('Default Model', `${defaultLine}\n\n${list}`);
          }
          const normalizedModelName = resolveRequestedCatalogModelName(
            modelName,
            availableModels,
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
          const modelName = parseIdArg(req.args, 2);
          if (!modelName)
            return badCommand('Usage', 'Usage: `model set <name>`');
          const normalizedModelName = resolveRequestedCatalogModelName(
            modelName,
            availableModels,
          );
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
          const metadata = getModelCatalogMetadata(runtime.model);
          const normalizedRuntimeModel = runtime.model.trim().toLowerCase();
          const pricing = metadata.pricingUsdPerToken;
          const pricingLine = normalizedRuntimeModel.startsWith('openai-codex/')
            ? 'Pricing: subscription included (0 EUR)'
            : /^(ollama|lmstudio|llamacpp|vllm)\//.test(normalizedRuntimeModel)
              ? 'Pricing: local model (0 EUR)'
              : pricing.input != null || pricing.output != null
                ? `Pricing: ${
                    pricing.input == null
                      ? 'unknown'
                      : formatUsd(pricing.input * 1_000_000)
                  } input / ${
                    pricing.output == null
                      ? 'unknown'
                      : formatUsd(pricing.output * 1_000_000)
                  } output per 1M tokens`
                : 'Pricing: dynamic pricing unavailable';
          const capabilities =
            [
              metadata.capabilities.vision ? 'vision' : null,
              metadata.capabilities.tools ? 'tools' : null,
              metadata.capabilities.jsonMode ? 'JSON mode' : null,
              metadata.capabilities.reasoning ? 'reasoning' : null,
            ]
              .filter((capability) => capability != null)
              .join(', ') || 'unknown';
          return infoCommand(
            'Model Info',
            [
              `Effective model: ${formatModelForDisplay(runtime.model)}`,
              `Global model: ${formatModelForDisplay(HYBRIDAI_MODEL)}`,
              `Agent model: ${formatConfiguredAgentModel(resolvedAgent)}`,
              `Session model: ${sessionOverride}`,
              ...formatAuxiliaryModelLines(getRuntimeConfig()),
              `Known metadata: ${metadata.known ? 'yes' : 'no'}`,
              `Context window: ${metadata.contextWindow == null ? 'unknown' : formatCompactNumber(metadata.contextWindow)}`,
              `Max output tokens: ${metadata.maxTokens == null ? 'unknown' : formatCompactNumber(metadata.maxTokens)}`,
              `Capabilities: ${capabilities}`,
              pricingLine,
              `Sources: ${metadata.sources.length > 0 ? metadata.sources.join(', ') : 'unknown'}`,
            ].join('\n'),
          );
        }

        return badCommand(
          'Usage',
          'Usage: `model list [provider] [more]|set <name>|clear|default [name]|info`',
        );
      }

      case 'rag': {
        const sub = parseLowerArg(req.args, 1);
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
        const sub = parseLowerArg(req.args, 1);
        if (sub === 'mode' || !sub) {
          const guildId = req.guildId;
          if (!guildId) {
            return badCommand(
              'Guild Only',
              '`channel mode` is only available in Discord guild channels.',
            );
          }
          const requestedMode = parseLowerArg(req.args, sub ? 2 : 1);
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
          const requestedPolicy = parseLowerArg(req.args, 2);
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
        const sub = parseLowerArg(req.args, 1);
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
          const rawValue = parseIdArg(req.args, 2);
          if (!rawValue) {
            return badCommand(
              'Usage',
              'Usage: `ralph set <n>` (0=off, -1=unlimited, 1-64=extra iterations)',
            );
          }
          const parsed = Number.parseInt(rawValue, 10);
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

      case 'goal': {
        return await handleGoalCommand({ session, req });
      }

      case 'fullauto': {
        const sub = parseLowerArg(req.args, 1);
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
        const nextMode = parseLowerArg(req.args, 1);

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
        const sub = parseLowerArg(req.args, 1);
        const provider = normalizeGatewayAuthStatusProvider(
          parseIdArg(req.args, 2),
        );
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

        const sub = parseLowerArg(req.args, 1);
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
          const secretName = parseIdArg(req.args, 2);
          const secretValue = normalizeRuntimeSecretInputValue(
            req.args.slice(3).join(' '),
          );
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
          refreshRuntimeSecretsFromEnv();
          return plainCommand(
            `Stored encrypted secret \`${secretName}\` in \`${runtimeSecretsPath()}\`.`,
          );
        }

        if (sub === 'unset' || sub === 'delete' || sub === 'remove') {
          const secretName = parseIdArg(req.args, 2);
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
          refreshRuntimeSecretsFromEnv();
          return plainCommand(`Removed encrypted secret \`${secretName}\`.`);
        }

        if (sub === 'route') {
          const action = parseLowerArg(req.args, 2);
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
            const rawPrefix = parseIdArg(req.args, 3);
            const secretName = parseIdArg(req.args, 4);
            const rawHeader = parseIdArg(req.args, 5);
            const rawAuthPrefix = parseIdArg(req.args, 6);
            if (!rawPrefix || !secretName) {
              return badCommand(
                'Usage',
                'Usage: `secret route add <url-prefix> <secret-name|google-oauth> [header] [prefix|none]`',
              );
            }
            const secret = normalizeSecretRouteSecret(secretName);
            if (
              isStoreSecretRouteSecret(secret) &&
              !isRuntimeSecretName(secret.id)
            ) {
              return badCommand(
                'Invalid Secret Name',
                'Secret names must use uppercase letters, digits, and underscores only.',
              );
            }
            if (
              isStoreSecretRouteSecret(secret) &&
              isReservedNonSecretRuntimeName(secret.id)
            ) {
              return badCommand(
                'Reserved Non-Secret Name',
                `\`${secret.id}\` is a normal runtime config key and cannot be used as an encrypted secret route target.`,
              );
            }
            try {
              const urlPrefix =
                normalizeHttpRequestAuthRuleUrlPrefix(rawPrefix);
              if (
                isGoogleOAuthSecretRef(secret) &&
                !isGoogleApisUrlPrefix(urlPrefix)
              ) {
                return badCommand(
                  'Invalid Google OAuth Route',
                  '`google-oauth` routes can only target googleapis.com or *.googleapis.com URL prefixes.',
                );
              }
              const header = normalizeSecretRouteHeader(rawHeader);
              const prefix = normalizeSecretRoutePrefix(rawAuthPrefix);
              const agentId = resolveSessionAgentId(session);
              const policyWorkspacePath = agentWorkspaceDir(agentId);
              const policySnapshot =
                captureHttpSecretRoutePolicySnapshot(policyWorkspacePath);
              allowHttpSecretRouteInWorkspacePolicy({
                workspacePath: policyWorkspacePath,
                urlPrefix,
                header,
                secret,
                agentId,
              });
              try {
                updateRuntimeConfig((draft) => {
                  const nextRule: RuntimeHttpRequestAuthRule = {
                    urlPrefix,
                    header,
                    prefix,
                    secret,
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
              } catch (error) {
                restoreHttpSecretRoutePolicySnapshot(policySnapshot);
                throw error;
              }
              const authLabel = prefix
                ? `${header}: ${prefix} <secret>`
                : `${header}: <secret>`;
              return plainCommand(
                `Added secret route for \`${urlPrefix}\` using \`${formatRouteSecretLabel(secret)}\` as \`${authLabel}\`.`,
              );
            } catch (error) {
              return badCommand(
                'Secret Route Failed',
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          if (action === 'remove') {
            const rawPrefix = parseIdArg(req.args, 3);
            const rawHeader = parseIdArg(req.args, 4);
            if (!rawPrefix) {
              return badCommand(
                'Usage',
                'Usage: `secret route remove <url-prefix> [header]`',
              );
            }
            try {
              const urlPrefix =
                normalizeHttpRequestAuthRuleUrlPrefix(rawPrefix);
              const header = rawHeader
                ? normalizeSecretRouteHeader(rawHeader)
                : '';
              const currentRules =
                getRuntimeConfig().tools.httpRequest.authRules.filter(
                  (rule) => {
                    if (rule.urlPrefix !== urlPrefix) return false;
                    if (
                      header &&
                      rule.header.toLowerCase() !== header.toLowerCase()
                    ) {
                      return false;
                    }
                    return true;
                  },
                );
              const agentId = resolveSessionAgentId(session);
              const policyWorkspacePath = agentWorkspaceDir(agentId);
              const policySnapshot =
                captureHttpSecretRoutePolicySnapshot(policyWorkspacePath);
              for (const rule of currentRules) {
                removeHttpSecretRouteFromWorkspacePolicy({
                  workspacePath: policyWorkspacePath,
                  urlPrefix,
                  header: rule.header,
                  agentId,
                });
              }
              let removed = 0;
              try {
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
              } catch (error) {
                restoreHttpSecretRoutePolicySnapshot(policySnapshot);
                throw error;
              }
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
            'Usage: `secret route list`, `secret route add <url-prefix> <secret-name|google-oauth> [header] [prefix|none]`, or `secret route remove <url-prefix> [header]`',
          );
        }

        if (sub === 'show' || sub === 'status') {
          const secretName = parseIdArg(req.args, 2);
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

      case 'env': {
        if (!isLocalSession(req)) {
          return badCommand(
            'Env Command Restricted',
            '`env` reads or writes local plaintext runtime env values and is only available from local TUI/web sessions.',
          );
        }

        const sub = parseLowerArg(req.args, 1);
        if (!sub || sub === 'list') {
          const values = readStoredRuntimeEnv();
          const names = Object.keys(values).sort((left, right) =>
            left.localeCompare(right),
          );
          const text = [
            `Runtime env store: ${runtimeEnvPath()}`,
            ...(names.length > 0
              ? names.map((name) => `${name}=${values[name]}`)
              : ['(none)']),
          ].join('\n');
          return infoCommand('Runtime Env', text);
        }

        if (sub === 'set') {
          try {
            const name = validateRuntimeEnvName(parseIdArg(req.args, 2));
            const value = req.args.slice(3).join(' ').trim();
            if (!value) {
              return badCommand('Usage', 'Usage: `env set <name> <value>`');
            }
            saveNamedRuntimeEnv({ [name]: value });
            return plainCommand(
              `Stored runtime env \`${name}\` in \`${runtimeEnvPath()}\`.`,
            );
          } catch (error) {
            return badCommand(
              'Invalid Env Value',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        if (sub === 'unset' || sub === 'delete' || sub === 'remove') {
          try {
            const name = validateRuntimeEnvName(parseIdArg(req.args, 2));
            saveNamedRuntimeEnv({ [name]: null });
            return plainCommand(`Removed runtime env \`${name}\`.`);
          } catch (error) {
            return badCommand(
              'Invalid Env Value',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        if (sub === 'show' || sub === 'get') {
          try {
            const name = validateRuntimeEnvName(parseIdArg(req.args, 2));
            const value = readStoredRuntimeEnvValue(name);
            return infoCommand(
              'Runtime Env',
              [
                `Name: ${name}`,
                `Stored: ${value ? 'yes' : 'no'}`,
                `Value: ${value || '(unset)'}`,
                `Path: ${runtimeEnvPath()}`,
              ].join('\n'),
            );
          } catch (error) {
            return badCommand(
              'Invalid Env Value',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        return badCommand(
          'Usage',
          'Usage: `env list`, `env set <name> <value>`, `env unset <name>`, or `env show <name>`',
        );
      }

      case 'voice': {
        if (!isLocalSession(req)) {
          return badCommand(
            'Voice Command Restricted',
            '`voice` can place outbound calls and is only available from local TUI/web sessions.',
          );
        }

        const voiceConfig = getRuntimeConfig().voice;
        const sub = parseLowerArg(req.args, 1);
        const publicWebhook = resolveVoiceCommandWebhookUrl(
          voiceConfig.webhookPath,
        );

        if (!sub || sub === 'info' || sub === 'status') {
          return infoCommand(
            'Voice',
            [
              `Enabled: ${voiceConfig.enabled ? 'on' : 'off'}`,
              `Provider: ${voiceConfig.provider}`,
              `Account SID: ${voiceConfig.twilio.accountSid.trim() ? 'configured' : 'unset'}`,
              `From number: ${voiceConfig.twilio.fromNumber.trim() || '(unset)'}`,
              `Auth token: ${String(TWILIO_AUTH_TOKEN || '').trim() ? 'configured' : 'unset'}`,
              publicWebhook.url
                ? `Webhook: ${publicWebhook.url}`
                : `Webhook: unavailable (${publicWebhook.error})`,
              'Usage: `voice call <e164-number>`',
            ].join('\n'),
          );
        }

        if (sub === 'call') {
          if (!voiceConfig.enabled) {
            return badCommand(
              'Voice Disabled',
              'Enable `voice.enabled` before using `voice call`.',
            );
          }

          if (voiceConfig.provider !== 'twilio') {
            return badCommand(
              'Voice Provider Unsupported',
              `\`voice call\` currently supports only the Twilio provider, but configured provider is \`${voiceConfig.provider}\`.`,
            );
          }

          const to = normalizeTwilioPhoneNumber(req.args.slice(2).join(' '));
          if (!to) {
            return badCommand('Usage', 'Usage: `voice call <e164-number>`');
          }

          const accountSid = voiceConfig.twilio.accountSid.trim();
          if (!accountSid) {
            return badCommand(
              'Voice Not Configured',
              'Set `voice.twilio.accountSid` before using `voice call`.',
            );
          }

          const from = normalizeTwilioPhoneNumber(
            voiceConfig.twilio.fromNumber,
          );
          if (!from) {
            return badCommand(
              'Voice Not Configured',
              'Set `voice.twilio.fromNumber` to an E.164 number like `+14155550123` before using `voice call`.',
            );
          }

          const authToken = String(TWILIO_AUTH_TOKEN || '').trim();
          if (!authToken) {
            return badCommand(
              'Voice Not Configured',
              'Store `TWILIO_AUTH_TOKEN` in the encrypted secret store before using `voice call`.',
            );
          }

          if (!publicWebhook.url) {
            return badCommand(
              'Voice Webhook Not Public',
              publicWebhook.error ||
                'Set `ops.gatewayBaseUrl` to a public URL before using `voice call`.',
            );
          }

          try {
            const call = await createTwilioOutboundCall({
              accountSid,
              authToken,
              from,
              to,
              url: publicWebhook.url,
            });
            return plainCommand(
              `Calling ${call.to} from ${call.from} via Twilio (Call SID: ${call.sid}, status: ${call.status}).`,
            );
          } catch (error) {
            return badCommand(
              'Voice Call Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        return badCommand('Usage', 'Usage: `voice [info|call <e164-number>]`');
      }

      case 'config': {
        if (!isLocalSession(req)) {
          return badCommand(
            'Config Restricted',
            '`config` reads or writes local runtime config and is only available from local TUI/web sessions.',
          );
        }

        const sub = parseLowerArg(req.args, 1);
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

        if (sub === 'get') {
          const key = parseIdArg(req.args, 2);
          if (!key || req.args.length > 3) {
            return badCommand('Usage', 'Usage: `config get <key>`');
          }
          try {
            const value = getRuntimeConfigValueAtPath(getRuntimeConfig(), key);
            return infoCommand(
              'Runtime Config Value',
              [
                `Path: ${runtimeConfigPath()}`,
                `Key: ${key}`,
                'Value:',
                formatRuntimeConfigValue(value),
              ].join('\n'),
            );
          } catch (error) {
            return badCommand(
              'Config Read Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        if (sub === 'set') {
          const key = parseIdArg(req.args, 2);
          const rawValue = req.args.slice(3).join(' ').trim();
          if (!key || !rawValue) {
            return badCommand(
              'Usage',
              'Usage: `config`, `config check`, `config reload`, `config get <key>`, or `config set <key> <value>`',
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
          'Usage: `config`, `config check`, `config reload`, `config get <key>`, or `config set <key> <value>`',
        );
      }

      case 'policy': {
        if (!isLocalSession(req)) {
          return badCommand(
            'Policy Restricted',
            '`policy` manages local workspace network rules and is only available from local TUI/web sessions.',
          );
        }
        const runtime = resolveSessionRuntimeTarget(session);
        const result = runPolicyCommand(req.args.slice(1), {
          workspacePath: runtime.workspacePath,
        });
        if (result.kind === 'error') {
          return badCommand(
            result.title || 'Policy Command Failed',
            result.text,
          );
        }
        if (result.kind === 'info') {
          return infoCommand(result.title || 'Policy', result.text);
        }
        return plainCommand(result.text);
      }

      case 'stop':
      case 'abort': {
        pauseActiveGoalForSession({
          session,
          reason: 'user-interrupted',
          verdict: 'interrupted',
        });
        await disableFullAutoSession({ sessionId: session.id });
        const stopped = interruptGatewaySessionExecution(req.sessionId);
        return plainCommand(
          stopped
            ? 'Stopped the current session run and disabled full-auto mode.'
            : 'No active session run. Full-auto mode disabled.',
        );
      }

      case 'mcp': {
        const sub = parseLowerArg(req.args, 1, { defaultValue: 'list' });
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
          const statuses = entries.map(([name, config]) =>
            getMcpOAuthStatus(name, config),
          );
          const lines = entries.map(
            ([name, config], index) =>
              `${name} — ${summarizeMcpServer(config)}${describeMcpServerAuth(statuses[index])}`,
          );
          if (statuses.some(mcpOAuthNeedsLogin)) {
            lines.push('', 'Connect OAuth servers with `mcp login <name>`.');
          }
          return infoCommand('MCP Servers', lines.join('\n'));
        }

        if (sub === 'add') {
          const parsedName = parseMcpServerName(parseIdArg(req.args, 2));
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
          const name = parseIdArg(req.args, 2);
          if (!name) {
            return badCommand('Usage', 'Usage: `mcp remove <name>`');
          }
          if (!servers[name]) {
            return badCommand(
              'Not Found',
              `MCP server \`${name}\` was not found.`,
            );
          }
          deleteMcpServerConfig(name);
          return plainCommand(
            `MCP server \`${name}\` removed.${restartNoteForMcpChange(req.sessionId)}`,
          );
        }

        if (sub === 'toggle') {
          const name = parseIdArg(req.args, 2);
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
          const name = parseIdArg(req.args, 2);
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

        if (sub === 'login') {
          const name = parseIdArg(req.args, 2);
          if (!name) {
            return badCommand('Usage', 'Usage: `mcp login <name>`');
          }
          try {
            const started = await startGatewayAdminMcpOAuth({ name });
            return infoCommand(
              'MCP OAuth Login',
              [
                `Open this URL in your browser to authorize \`${name}\`:`,
                started.authorizationUrl,
                '',
                'After approving access, run `mcp status ' +
                  name +
                  '` to confirm the connection.',
              ].join('\n'),
            );
          } catch (error) {
            return badCommand(
              'MCP OAuth Login Failed',
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        if (sub === 'status') {
          const name = parseIdArg(req.args, 2);
          if (!name) {
            return badCommand('Usage', 'Usage: `mcp status <name>`');
          }
          if (!servers[name]) {
            return badCommand(
              'Not Found',
              `MCP server \`${name}\` was not found.`,
            );
          }
          const status = getMcpOAuthStatus(name, servers[name]);
          return infoCommand(
            'MCP Server Status',
            `${name} — ${summarizeMcpServer(servers[name])}${describeMcpServerAuth(status)}` +
              (mcpOAuthNeedsLogin(status)
                ? `\nRun \`mcp login ${name}\` to connect.`
                : ''),
          );
        }

        if (sub === 'logout') {
          const name = parseIdArg(req.args, 2);
          if (!name) {
            return badCommand('Usage', 'Usage: `mcp logout <name>`');
          }
          if (!servers[name]) {
            return badCommand(
              'Not Found',
              `MCP server \`${name}\` was not found.`,
            );
          }
          const cleared = clearMcpOAuth(name);
          return plainCommand(
            cleared
              ? `Cleared OAuth credentials for \`${name}\`. Run \`mcp login ${name}\` to reconnect.`
              : `MCP server \`${name}\` has no stored OAuth credentials.`,
          );
        }

        return badCommand(
          'Usage',
          'Usage: `mcp list|add <name> <json>|remove <name>|toggle <name>|reconnect <name>|login <name>|logout <name>|status <name>`',
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
        const sub = parseLowerArg(req.args, 1);
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

      case 'context': {
        const { snapshot } = getGatewaySessionContextUsage(session.id);
        if (!snapshot) {
          return badCommand(
            'Context Usage',
            'Session not found or has no context usage recorded yet.',
          );
        }
        const usedLabel =
          snapshot.contextUsedTokens != null
            ? formatCompactNumber(snapshot.contextUsedTokens)
            : 'n/a';
        const budgetLabel =
          snapshot.contextBudgetTokens != null
            ? formatCompactNumber(snapshot.contextBudgetTokens)
            : 'unknown';
        const percentLabel =
          snapshot.contextUsagePercent == null ||
          !Number.isFinite(snapshot.contextUsagePercent)
            ? 'n/a'
            : snapshot.contextUsagePercent > 100
              ? `${Math.round(snapshot.contextUsagePercent)}%`
              : formatPercent(snapshot.contextUsagePercent);
        const remainingLabel =
          snapshot.contextRemainingTokens != null
            ? formatCompactNumber(snapshot.contextRemainingTokens)
            : 'n/a';
        const lines = [
          `🧠 Model: ${formatModelForDisplay(snapshot.model)}`,
          `📚 Context: ${usedLabel}/${budgetLabel} tokens (${percentLabel})`,
          `🪽 Headroom: ${remainingLabel} tokens until the window fills`,
          `🧹 Compaction: triggers at ${formatCompactNumber(snapshot.compactionMessageThreshold)} msgs or ${formatCompactNumber(snapshot.compactionTokenBudget)} tokens, keeping ${snapshot.compactionKeepRecent} recent · ran ${snapshot.compactionCount}×`,
          `💬 Messages in session: ${formatCompactNumber(snapshot.messageCount)}`,
        ];
        if (snapshot.contextBudgetTokens == null) {
          lines.push(
            '',
            'Tip: context window for this model is unknown, so the ring shows usage without a budget. Set a known model with `/model set <name>` to see headroom.',
          );
        }
        return infoCommand('Context Usage', lines.join('\n'));
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

      case 'dream': {
        const sub = parseLowerArg(req.args, 1);
        const currentConfig = getRuntimeConfig();
        const currentIntervalHours = Math.max(
          0,
          Math.trunc(currentConfig.memory.consolidationIntervalHours),
        );
        const formatDreamStatus = (): string =>
          [
            `Scheduler: ${currentIntervalHours > 0 ? 'enabled' : 'disabled'}`,
            currentIntervalHours > 0
              ? 'Cadence: nightly, with startup catch-up if a run was missed'
              : 'Cadence: off',
            `Decay rate: ${currentConfig.memory.decayRate}`,
          ].join('\n');

        if (!sub || sub === 'status' || sub === 'info' || sub === 'help') {
          return infoCommand(
            'Dream Status',
            [formatDreamStatus(), '', 'Usage: `dream on|off|now`'].join('\n'),
          );
        }

        if (sub === 'on' || sub === 'enable') {
          if (currentIntervalHours > 0) {
            return plainCommand(
              'Dream scheduling already enabled. Consolidation runs nightly and catches up after downtime.',
            );
          }
          updateRuntimeConfig((draft) => {
            draft.memory.consolidationIntervalHours = 24;
          });
          return plainCommand(
            'Dream scheduling enabled. Memory consolidation will run nightly and catch up on the next startup if a run was missed.',
          );
        }

        if (sub === 'off' || sub === 'disable') {
          if (currentIntervalHours <= 0) {
            return plainCommand('Dream scheduling already disabled.');
          }
          updateRuntimeConfig((draft) => {
            draft.memory.consolidationIntervalHours = 0;
          });
          return plainCommand('Dream scheduling disabled.');
        }

        if (sub !== 'now' && sub !== 'run') {
          return badCommand('Usage', 'Usage: `dream on|off|now`');
        }

        try {
          const report = await runMemoryConsolidation({
            trigger: 'manual',
          });
          if (!report) {
            return plainCommand('Memory consolidation already running.');
          }
          return infoCommand(
            'Memory Consolidated',
            [
              `Memories decayed: ${formatCompactNumber(report.memoriesDecayed)}`,
              `Daily files compiled: ${formatCompactNumber(report.dailyFilesCompiled)}`,
              `Workspaces updated: ${formatCompactNumber(report.workspacesUpdated)}`,
              `Model cleanups: ${formatCompactNumber(report.modelCleanups)}`,
              `Fallbacks used: ${formatCompactNumber(report.fallbacksUsed)}`,
              `Duration: ${formatDurationMs(report.durationMs)}`,
            ].join('\n'),
          );
        } catch (err) {
          return badCommand(
            'Memory Consolidation Failed',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      case 'memory': {
        if (!isLocalSession(req)) {
          return badCommand(
            'Memory Commands Restricted',
            '`memory inspect` and `memory query` expose workspace and session memory details and are only available from local TUI/web sessions.',
          );
        }

        const rawSub = parseIdArg(req.args, 1);
        const sub = rawSub.toLowerCase();
        if (sub && sub !== 'inspect' && sub !== 'query') {
          return badCommand(
            'Usage',
            'Usage: `memory inspect [sessionId]` | `memory query <query>`',
          );
        }

        if (sub === 'query') {
          const query = req.args.slice(2).join(' ').trim();
          if (!query) {
            return badCommand('Usage', 'Usage: `memory query <query>`');
          }
          return infoCommand(
            'Memory Query',
            buildMemoryQueryReport({
              session,
              query,
            }),
          );
        }

        const targetSessionId =
          (sub === 'inspect'
            ? parseIdArg(req.args, 2)
            : parseIdArg(req.args, 1)) || session.id;
        if (!targetSessionId) {
          return badCommand(
            'Usage',
            'Usage: `memory inspect [sessionId]` | `memory query <query>`',
          );
        }

        const targetSession = memoryService.getSessionById(targetSessionId);
        if (!targetSession) {
          return badCommand(
            'Not Found',
            `Session \`${targetSessionId}\` was not found.`,
          );
        }

        return infoCommand(
          'Memory Inspection',
          buildMemoryInspectReport({ session: targetSession }),
        );
      }

      case 'status': {
        const status = await getGatewayStatus();
        const commitShort = resolveGitCommitShort();
        const runtime = resolveSessionRuntimeTarget(session);
        const activeAgent = resolveAgentConfig(runtime.agentId);
        if (activeAgent.proxy) {
          const proxyScope = activeAgent.proxy.conversationScope ?? 'channel';
          const lines = [
            `🦞 HybridClaw v${status.version}${commitShort ? ` (${commitShort})` : ''}`,
            '🔁 Mode: HybridAI proxy',
            `🤖 Agent: ${runtime.agentId}`,
            `🌐 Upstream: ${activeAgent.proxy.baseUrl}`,
            `💬 Chatbot: ${activeAgent.proxy.chatbotId}`,
            `🧵 Conversation scope: ${proxyScope}`,
            `🧵 Session: ${session.id} • updated ${formatRelativeTime(session.last_active)}`,
            `📊 Gateway: uptime ${formatUptime(status.uptime)} · sessions ${status.sessions}`,
          ];
          return infoCommand('Status', lines.join('\n'));
        }

        const delegationStatus = delegationQueueStatus();
        const containerImageStatus =
          status.sandbox?.mode === 'container' && status.sandbox.image
            ? await resolveContainerImageStatus(status.sandbox.image)
            : null;
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
        await refreshModelCatalogMetadata(sessionModel);
        const modelContextWindowTokens =
          resolveKnownModelContextWindow(sessionModel);
        const metrics = readSessionStatusSnapshot(session.id, {
          currentModel: sessionModel,
          modelContextWindowTokens,
        });
        const contextSnapshot = buildGatewaySessionContextUsageSnapshot(
          session,
          metrics,
        );
        const delegateModel = PROACTIVE_DELEGATION_MODEL.trim();
        const showDelegateSetup =
          delegateModel.length > 0 &&
          delegateModel.localeCompare(sessionModel, undefined, {
            sensitivity: 'accent',
          }) !== 0;
        const delegateMetrics = showDelegateSetup
          ? readDelegateSessionStatusSnapshot(session.id)
          : null;
        const mainPromptTokens = Math.max(0, metrics.promptTokens || 0);
        const mainCompletionTokens = Math.max(0, metrics.completionTokens || 0);
        const delegatePromptTokens = Math.max(
          0,
          delegateMetrics?.promptTokens || 0,
        );
        const delegateCompletionTokens = Math.max(
          0,
          delegateMetrics?.completionTokens || 0,
        );
        const totalTokens =
          mainPromptTokens +
          mainCompletionTokens +
          delegatePromptTokens +
          delegateCompletionTokens;
        const localTokens =
          (isLocalModelProvider(sessionModel)
            ? mainPromptTokens + mainCompletionTokens
            : 0) +
          (showDelegateSetup && isLocalModelProvider(delegateModel)
            ? delegatePromptTokens + delegateCompletionTokens
            : 0);
        const localTokenLabel = ` · ${formatPercent(
          totalTokens > 0 ? (localTokens / totalTokens) * 100 : 0,
        )} local`;
        const mainCostLabel = resolveModelCostLabel({
          model: sessionModel,
          promptTokens: mainPromptTokens,
          completionTokens: mainCompletionTokens,
        });
        const delegateCostLabel = showDelegateSetup
          ? resolveModelCostLabel({
              model: delegateModel,
              promptTokens: delegatePromptTokens,
              completionTokens: delegateCompletionTokens,
            })
          : null;
        const costLabel =
          mainCostLabel || delegateCostLabel
            ? ` · Cost: ${mainCostLabel ?? 'n/a'}${showDelegateSetup ? ` (delegate: ${delegateCostLabel ?? 'n/a'})` : ''}`
            : '';
        const performanceLabel =
          metrics.tokensPerSecond != null ||
          metrics.inputTokensPerSecond != null ||
          metrics.outputTokensPerSecond != null
            ? `⚡ Performance: Output ${formatPerformanceTokensPerSecond(metrics.outputTokensPerSecond, metrics.outputTokensPerSecondStddev)} · Input ${formatPerformanceTokensPerSecond(metrics.inputTokensPerSecond, metrics.inputTokensPerSecondStddev)} · Total ${formatPerformanceTokensPerSecond(metrics.tokensPerSecond, metrics.tokensPerSecondStddev)}`
            : null;
        const queueLabel = `${delegationStatus.active} active / ${delegationStatus.queued} queued`;
        const proactiveQueued = getQueuedProactiveMessageCount();
        const cacheKnown =
          metrics.cacheReadTokens != null || metrics.cacheWriteTokens != null;
        const cacheHitLabel = formatPercent(
          cacheKnown ? (metrics.cacheHitPercent ?? 0) : metrics.cacheHitPercent,
        );
        const contextLabel =
          contextSnapshot.contextUsedTokens != null &&
          contextSnapshot.contextBudgetTokens != null
            ? `${formatCompactNumber(contextSnapshot.contextUsedTokens)}/${formatCompactNumber(contextSnapshot.contextBudgetTokens)} (${formatPercent(contextSnapshot.contextUsagePercent)})`
            : contextSnapshot.contextUsedTokens != null
              ? `${formatCompactNumber(contextSnapshot.contextUsedTokens)}/? (window unknown)`
              : 'n/a';
        const sandboxMode = status.sandbox?.mode || 'container';
        const sandboxLabel = `${sandboxMode} (${status.sandbox?.activeSessions ?? status.activeContainers} active)`;
        const turnRuntimeLabel =
          resolveModelProvider(sessionModel) === 'openai-codex' &&
          getRuntimeConfig().codex.turnRuntime === 'app-server'
            ? 'codex'
            : 'hybridclaw';
        const activeSandboxSessionIds = status.sandbox?.activeSessionIds || [];
        const fullAutoState = getFullAutoRuntimeState(session.id);
        const fullAutoLabel = isFullAutoEnabled(session)
          ? `on (${fullAutoState?.turns ?? 0} turns, ${fullAutoState?.consecutiveErrors ?? 0} errors)`
          : 'off';
        const showMode = normalizeSessionShowMode(session.show_mode);
        const liveness = status.coworkerLiveness;
        const unhealthyLiveness =
          liveness?.probes.filter((probe) => probe.state !== 'green') ?? [];
        const coworkerHealthLabel = liveness
          ? `${liveness.totals.green} green / ${liveness.totals.amber} amber / ${liveness.totals.red} red`
          : 'unavailable';
        const coworkerHealthLines =
          unhealthyLiveness.length > 0
            ? unhealthyLiveness.slice(0, 5).map((probe) => {
                return `  ${probe.agentId}: ${probe.state} (${probe.reasonCodes.join(', ')})`;
              })
            : [];
        const lines = [
          `🦞 HybridClaw v${status.version}${commitShort ? ` (${commitShort})` : ''}`,
          `🧠 Model: ${formatModelForDisplay(sessionModel)}${showDelegateSetup ? ` (delegate: ${formatModelForDisplay(delegateModel)})` : ''}`,
          `🧮 Tokens: ${formatCompactNumber(metrics.promptTokens)} in / ${formatCompactNumber(metrics.completionTokens)} out${showDelegateSetup ? ` (delegate: ${formatCompactNumber(delegatePromptTokens)} in / ${formatCompactNumber(delegateCompletionTokens)} out)` : ''}${localTokenLabel}${costLabel}`,
          ...(performanceLabel ? [performanceLabel] : []),
          cacheKnown
            ? `🗄️ Cache: ${cacheHitLabel} hit · ${formatCompactNumber(metrics.cacheReadTokens)} cached, ${formatCompactNumber(metrics.cacheWriteTokens)} new`
            : '🗄️ Cache: n/a (provider did not report cache stats)',
          `📚 Context: ${contextLabel} · 🧹 Compactions: ${contextSnapshot.compactionCount}`,
          `📊 Usage: uptime ${formatUptime(status.uptime)} · sessions ${status.sessions} · sandbox ${sandboxLabel}`,
          ...(activeSandboxSessionIds.length > 0
            ? [
                `🧱 Sandbox sessions: ${activeSandboxSessionIds.slice(0, 5).join(', ')}${activeSandboxSessionIds.length > 5 ? ` (+${activeSandboxSessionIds.length - 5} more)` : ''}`,
              ]
            : []),
          `🧵 Session: ${session.id} • updated ${formatRelativeTime(session.last_active)}`,
          `🤖 Agent: ${runtime.agentId}`,
          `📁 CWD: ${runtime.workspacePath}`,
          ...(status.sandbox?.mode === 'container' && status.sandbox.image
            ? [
                `🐳 Container: ${status.sandbox.image} · ${[
                  containerImageStatus?.version
                    ? `v${containerImageStatus.version}`
                    : 'version unavailable',
                  containerImageStatus?.shortId
                    ? `id ${containerImageStatus.shortId}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}`,
              ]
            : []),
          `⚙️ Runtime: ${turnRuntimeLabel} · Sandbox: ${sandboxMode} · RAG: ${session.enable_rag ? 'on' : 'off'} · Ralph: ${formatRalphIterations(resolveSessionRalphIterations(session))} · Show: ${showMode}`,
          `🤖 Full-auto: ${fullAutoLabel}`,
          `👥 Activation: ${resolveActivationModeLabel()} · 🪢 Queue: ${queueLabel} · 📬 Proactive queued: ${proactiveQueued}`,
          `🩺 Agents: ${coworkerHealthLabel}`,
          ...coworkerHealthLines,
        ];
        return infoCommand('Status', lines.join('\n'));
      }

      case 'sessions': {
        const sub = parseLowerArg(req.args, 1);
        if (sub === 'active') {
          const activeSessionIds = getActiveExecutorSessionIds();
          if (activeSessionIds.length === 0) {
            return plainCommand('No active sandbox sessions.');
          }
          return infoCommand(
            'Active Sandbox Sessions',
            [`Count: ${activeSessionIds.length}`, ...activeSessionIds].join(
              '\n',
            ),
          );
        }
        if (sub === 'clear-active') {
          const activeSessionIds = getActiveExecutorSessionIds();
          if (activeSessionIds.length === 0) {
            return plainCommand('No active sandbox sessions to stop.');
          }
          stopAllExecutions();
          return infoCommand(
            'Stopped Sandbox Sessions',
            [
              `Stopped ${activeSessionIds.length} active sandbox session${activeSessionIds.length === 1 ? '' : 's'}.`,
              ...activeSessionIds,
            ].join('\n'),
          );
        }
        if (sub === 'prune') {
          const parsed = parseSessionPruneOptions(req.args.slice(2));
          if ('error' in parsed) {
            return badCommand(
              'Usage',
              `${parsed.error}\n${SESSION_PRUNE_USAGE}`,
            );
          }

          const activeSessionIds = new Set(getActiveExecutorSessionIds());
          const plan = buildSessionPrunePlan({
            activeSessionIds,
            currentSessionId: session.id,
            nowMs: Date.now(),
            olderThanMs: parsed.options.olderThanMs,
            sessions: getAllSessions(),
          });
          const lines = formatSessionPrunePlanLines(plan, parsed.options);

          if (!parsed.options.confirm) {
            return infoCommand(
              'Sessions Prune Dry Run',
              [
                ...lines,
                '',
                'No sessions were deleted.',
                `Run \`sessions prune --older-than ${parsed.options.olderThanLabel} --confirm\` to delete matched sessions.`,
                ...formatSessionPruneSample(plan),
              ].join('\n'),
            );
          }

          let deleted = 0;
          let deletedMessages = 0;
          let deletedTasks = 0;
          let deletedSemanticMemories = 0;
          let deletedUsageEvents = 0;
          let deletedAuditEntries = 0;
          let deletedApprovalEntries = 0;

          for (const { session: targetSession } of plan.candidates) {
            const result = deleteGatewayAdminSession(targetSession.id);
            if (!result.deleted) continue;
            deleted += 1;
            deletedMessages += result.deletedMessages;
            deletedTasks += result.deletedTasks;
            deletedSemanticMemories += result.deletedSemanticMemories;
            deletedUsageEvents += result.deletedUsageEvents;
            deletedAuditEntries +=
              result.deletedAuditEntries + result.deletedStructuredAuditEntries;
            deletedApprovalEntries += result.deletedApprovalEntries;
          }

          recordAuditEvent({
            sessionId: session.id,
            runId: makeAuditRunId('cmd'),
            event: {
              type: 'session.prune',
              source: 'command',
              olderThan: parsed.options.olderThanLabel,
              cutoff: new Date(plan.cutoffMs).toISOString(),
              matchedCount: plan.candidates.length,
              deletedCount: deleted,
              protectedSkipped: plan.protectedSkipped,
              invalidTimestampSkipped: plan.invalidTimestampSkipped,
              deletedRows: {
                messages: deletedMessages,
                tasks: deletedTasks,
                semanticMemories: deletedSemanticMemories,
                usageEvents: deletedUsageEvents,
                auditEntries: deletedAuditEntries,
                approvals: deletedApprovalEntries,
              },
              userId: boundAuditActorField(req.userId),
              username: boundAuditActorField(req.username),
            },
          });

          return infoCommand(
            'Pruned Sessions',
            [
              ...lines,
              '',
              `Deleted: ${formatCompactNumber(deleted)} session${deleted === 1 ? '' : 's'}`,
              `Deleted rows: ${[
                `${formatCompactNumber(deletedMessages)} messages`,
                `${formatCompactNumber(deletedTasks)} tasks`,
                `${formatCompactNumber(deletedSemanticMemories)} semantic memories`,
                `${formatCompactNumber(deletedUsageEvents)} usage events`,
                `${formatCompactNumber(deletedAuditEntries)} audit entries`,
                `${formatCompactNumber(deletedApprovalEntries)} approvals`,
              ].join(', ')}`,
            ].join('\n'),
          );
        }
        if (sub) {
          return badCommand(
            'Usage',
            `Usage: \`sessions\`, \`sessions active\`, \`sessions clear-active\`, or ${SESSION_PRUNE_USAGE.replace(
              'Usage: ',
              '',
            )}`,
          );
        }
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
        const activeSessionIds = getActiveExecutorSessionIds();
        return infoCommand(
          'Sessions',
          [
            ...(activeSessionIds.length > 0
              ? [
                  `Active sandbox sessions: ${activeSessionIds.length}`,
                  'Use `sessions active` to inspect or `sessions clear-active` to stop them.',
                  '',
                ]
              : []),
            list,
          ].join('\n'),
        );
      }

      case 'usage': {
        const sub = parseLowerArg(req.args, 1, { defaultValue: 'summary' });
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
          const maybeWindow = parseLowerArg(req.args, 2);
          const window =
            maybeWindow === 'daily' || maybeWindow === 'monthly'
              ? maybeWindow
              : 'monthly';
          const modelAgentId =
            maybeWindow === 'daily' || maybeWindow === 'monthly'
              ? parseIdArg(req.args, 3)
              : parseIdArg(req.args, 2);
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
        const sub = parseLowerArg(req.args, 1, { defaultValue: 'session' });
        if (sub !== 'session' && sub !== 'trace') {
          return badCommand(
            'Usage',
            'Usage: `export session [sessionId]` or `export trace [sessionId|all|--all]`',
          );
        }
        const parsedTrace =
          sub === 'trace'
            ? parseExportTraceTarget(req.args, session.id)
            : {
                targetSessionId: parseIdArg(req.args, 2) || session.id,
                exportAll: false,
                selector: null,
                error: null,
              };
        if (parsedTrace.error) {
          return badCommand(
            'Usage',
            `${parsedTrace.error}\nUsage: \`export trace [sessionId|all|--all] [--turn <n>|--run <runId>]\``,
          );
        }
        const exportAllTraces = sub === 'trace' && parsedTrace.exportAll;
        const targetSessionId = exportAllTraces
          ? ''
          : parsedTrace.targetSessionId;
        if (!exportAllTraces && !targetSessionId) {
          return badCommand(
            'Usage',
            sub === 'trace'
              ? 'Usage: `export trace [sessionId|all|--all] [--turn <n>|--run <runId>]`'
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
          const exported = await exportTraceForSession(
            targetSession,
            parsedTrace.selector,
          );
          if (!exported) {
            return badCommand(
              'Export Failed',
              parsedTrace.selector
                ? 'Failed to write focused turn trace export JSONL file. Check that the selected turn exists, then check gateway logs for details.'
                : 'Failed to write ATIF-compatible trace export JSONL file. Check gateway logs for details.',
            );
          }
          return infoCommand(
            'Trace Exported',
            [
              `File: ${exported.path}`,
              `Trace ID: ${exported.traceId}`,
              `Steps: ${exported.stepCount}`,
              ...(parsedTrace.selector
                ? [
                    `Turns: ${exported.turnCount}`,
                    `Runs: ${exported.runIds.join(', ') || '(none)'}`,
                  ]
                : []),
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
        const parsedAudit = parseAuditTraceCommand(req.args, session.id);
        if (parsedAudit.error) {
          return badCommand(
            'Usage',
            `${parsedAudit.error}\nUsage: \`audit [sessionId] | audit last | audit turn <n> | audit run <runId> | audit <sessionId> [--turn <n>|--run <runId>]\``,
          );
        }
        const targetSessionId = parsedAudit.targetSessionId;
        if (!targetSessionId) {
          return badCommand(
            'Usage',
            'Usage: `audit [sessionId] | audit last | audit turn <n> | audit run <runId>`',
          );
        }
        if (!parsedAudit.recentOnly && parsedAudit.selector) {
          const trace = formatAuditTurnTrace({
            sessionId: targetSessionId,
            auditEntries: getStructuredAuditForSession(targetSessionId),
            selector: parsedAudit.selector,
          });
          if ('error' in trace) {
            return plainCommand(trace.error);
          }
          return infoCommand(trace.title, trace.text);
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
        return await handleSkillCommand({
          args: req.args,
          sessionAgentId: resolveSessionAgentId(session),
          guildId: req.guildId,
          channelId: req.channelId,
          badCommand,
          infoCommand: (title, text) => infoCommand(title, text),
          plainCommand,
        });
      }

      case 'schedule': {
        const sub = parseLowerArg(req.args, 1);
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
            const taskId = createJob({
              kind: 'scheduled_task',
              sessionId: session.id,
              channelId: req.channelId,
              cronExpr: '',
              prompt,
              runAt: parsedDate.toISOString(),
            });
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
            const taskId = createJob({
              kind: 'scheduled_task',
              sessionId: session.id,
              channelId: req.channelId,
              cronExpr: '',
              prompt,
              everyMs,
            });
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
          const taskId = createJob({
            kind: 'scheduled_task',
            sessionId: session.id,
            channelId: req.channelId,
            cronExpr,
            prompt,
          });
          rearmScheduler();
          return plainCommand(
            `Task #${taskId} created: cron \`${cronExpr}\` — ${prompt}`,
          );
        }

        if (sub === 'list') {
          const tasks = getAllJobs({
            kind: 'scheduled_task',
            sessionId: session.id,
          });
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
          const taskId = parseIntegerArg(req.args, 2);
          if (!taskId)
            return badCommand('Usage', 'Usage: `schedule remove <id>`');
          deleteJob(taskId);
          rearmScheduler();
          return plainCommand(`Task #${taskId} removed.`);
        }

        if (sub === 'toggle') {
          const taskId = parseIntegerArg(req.args, 2);
          if (!taskId)
            return badCommand('Usage', 'Usage: `schedule toggle <id>`');
          const tasks = getAllJobs({
            kind: 'scheduled_task',
            sessionId: session.id,
          });
          const task = tasks.find((t) => t.id === taskId);
          if (!task)
            return badCommand(
              'Not Found',
              `Task #${taskId} was not found in this session.`,
            );
          if (task.enabled) {
            setJobEnabled(taskId, false);
          } else {
            setJobEnabled(taskId, true);
          }
          rearmScheduler();
          return plainCommand(
            `Task #${taskId} ${task.enabled ? 'disabled' : 'enabled'}.`,
          );
        }

        return badCommand('Usage', 'Usage: `schedule add|list|remove|toggle`');
      }

      case 'eval': {
        const localEvalChannelIds = new Set(['web', 'tui', 'cli']);
        if (req.guildId !== null || !localEvalChannelIds.has(req.channelId)) {
          return badCommand(
            'Eval Restricted',
            'The `eval` command is only available from local TUI, web, or CLI sessions.',
          );
        }

        const evalModule = await import('../evals/eval-command.js');
        const runtime = resolveAgentForRequest({ session });
        return evalModule.handleEvalCommand({
          args: req.args.slice(1),
          channelId: req.channelId,
          dataDir: DATA_DIR,
          gatewayBaseUrl: GATEWAY_CLIENT_BASE_URL,
          webApiToken: WEB_API_TOKEN,
          gatewayApiToken: GATEWAY_API_TOKEN,
          effectiveAgentId: runtime.agentId,
          effectiveModel: runtime.model,
        });
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
