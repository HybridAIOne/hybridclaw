import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { v5 as uuidv5 } from 'uuid';
import * as yazl from 'yazl';
import {
  EXTRACT_TEXT_PREVIEW_FUNCTION_SOURCE,
  EXTRACT_TWO_FACTOR_PAGE_STATE_FUNCTION_SOURCE,
} from '../../container/shared/two-factor-detection.js';
import {
  extractA2AMtlsPublicKeyPem,
  handleA2AHttpEnvelopeInbound,
  handleA2AJsonRpcInbound,
  resolveA2AAgentCardPeerTrust,
} from '../a2a/a2a-inbound.js';
import { getA2AOutboxDeliveryStatus } from '../a2a/a2a-outbox-persistence.js';
import {
  isA2ALocalModeAdminRequest,
  isA2ALocalModeEnabled,
  isA2ALocalModePublicA2ARequest,
} from '../a2a/local-mode.js';
import { handleA2APairingRequestInbound } from '../a2a/pairing.js';
import {
  handleA2AWebhookInbound,
  parseA2AWebhookInboundPath,
} from '../a2a/webhook-inbound.js';
import { runAgent } from '../agent/agent.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import {
  getAgentById,
  resolveAgentConfig,
  resolveAgentForRequest,
} from '../agents/agent-registry.js';
import {
  type AgentProxyConfig,
  type AgentRoutingConfig,
  DEFAULT_AGENT_ID,
  normalizeAgentProxyConfig,
  normalizeAgentRoutingConfig,
  resolveSnakeCamelAlias,
} from '../agents/agent-types.js';
import {
  deriveAppTitle,
  extractHtmlDocument,
  generateApp,
} from '../apps/app-generator.js';
import { appendAuditEvent } from '../audit/audit-trail.js';
import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import { getBoardBudgetSummaries } from '../board/budget-chip.js';
import {
  addEdge,
  type BoardCardActorInput,
  type BoardCardEdgeKind,
  type BoardCardMutationContext,
  isBlocked,
  listEdgeRevisions,
  listEdges,
  removeEdge,
  restoreEdgeRevision,
} from '../board/card-store.js';
import { startLocalManagedBrowserPool } from '../browser/managed-browser-pool-launcher.js';
import { checkManagedBrowserPoolHealth } from '../browser/managed-cloud-doctor.js';
import type {
  BrowserFillInput,
  BrowserProvider,
  BrowserSession,
  BrowserTwoFactorState,
  BrowserWaypointEvent,
} from '../browser/provider.js';
import { createBrowserProvider } from '../browser/provider-factory.js';
import { browserSessionConfigSignature } from '../browser/session-config-signature.js';
import {
  type DiscordToolActionRequest,
  normalizeDiscordToolAction,
} from '../channels/discord/tool-actions.js';
import { normalizeEmailAddress } from '../channels/email/allowlist.js';
import { handleIMessageWebhook } from '../channels/imessage/runtime.js';
import { runMessageToolAction } from '../channels/message/tool-actions.js';
import {
  getSignalLinkState,
  startSignalLink,
} from '../channels/signal/pairing.js';
import {
  handleVoiceUpgrade,
  handleVoiceWebhook,
} from '../channels/voice/runtime.js';
import { resolveVoiceWebhookPaths } from '../channels/voice/twilio-manager.js';
import { parseLowerArg } from '../command-parsing.js';
import {
  DATA_DIR,
  GATEWAY_API_TOKEN,
  getSandboxAutoDetectionState,
  HEALTH_HOST,
  HEALTH_PORT,
  HYBRIDAI_BASE_URL,
  IMESSAGE_WEBHOOK_PATH,
  MSTEAMS_WEBHOOK_PATH,
  refreshRuntimeSecretsFromEnv,
  WEB_API_TOKEN,
} from '../config/config.js';
import type {
  RuntimeBrowserProviderKind,
  RuntimeConfig,
  RuntimeDiscordChannelConfig,
  RuntimeMSTeamsChannelConfig,
} from '../config/runtime-config.js';
import {
  getRuntimeConfig,
  onRuntimeConfigChange,
  parseSchedulerBoardStatus,
  reloadRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger, syncLoggerLevelFromRuntimeConfig } from '../logger.js';
import { summarizeMediaFilenames } from '../media/media-summary.js';
import { normalizeMimeType } from '../media/mime-utils.js';
import {
  resolveUploadedMediaCacheHostDir,
  UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
  writeUploadedMediaCacheFile,
} from '../media/uploaded-media-cache.js';
import {
  createApp,
  deleteApp,
  getApp,
  listApps,
  type StoredApp,
  updateAppVisibility,
  upsertAppArtifact,
} from '../memory/apps.js';
import {
  claimQueuedProactiveMessages,
  enqueueProactiveMessage,
  setMessageActivityTrace,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { listLoadedPluginCommands } from '../plugins/plugin-manager.js';
import { isPluginInboundWebhookPath } from '../plugins/plugin-webhooks.js';
import {
  type AdminRbacAction,
  collectAdminActionClaims,
  isAdminActionAllowed,
  resolveAdminRbacAction,
} from '../security/admin-rbac.js';
import {
  createApiToken,
  isApiTokenString,
  verifyApiToken,
} from '../security/api-tokens.js';
import {
  type AppPublicationMetadata,
  type AppPublicationPolicy,
  createPasswordPublicationPolicy,
  createPublication,
  getPublicationPolicyTtlMs,
  isPublicationPasswordMatch,
  listPublicationsForApp,
  revokePublication,
  revokePublicationsForApp,
  verifyPublicationToken,
} from '../security/app-publications.js';
import { redactSecretsDeep } from '../security/redact.js';
import { createSecretHandle } from '../security/secret-handles.js';
import type { SecretInput } from '../security/secret-refs.js';
import { hardenSecretRef } from '../security/secret-refs.js';
import {
  normalizeRecentChatSearchQuery,
  normalizeRecentChatSessionLimit,
} from '../session/recent-chat-search.js';
import {
  buildSessionKey,
  classifySessionKeyShape,
} from '../session/session-key.js';
import {
  buildTuiSlashMenuEntries,
  rankTuiSlashMenuEntries,
} from '../tui-slash-menu.js';
import { ActivityTraceBuilder } from '../types/activity-trace.js';
import type { MediaContextItem } from '../types/container.js';
import type {
  PendingApproval,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import {
  normalizeOptionalTrimmedString as normalizeOptionalString,
  normalizeTrimmedUniqueStringArray,
} from '../utils/normalized-strings.js';
import {
  AdminTerminalCapacityError,
  type AdminTerminalStartOptions,
  createAdminTerminalManager,
} from './admin-terminal.js';
import type { AdminTerminalServerMessage } from './admin-terminal-protocol.js';
import {
  getSessionAuthPayload,
  hasLocalWebSessionAuth,
  hasSessionAuth,
  hasSharedAuthSecret,
  safeEqualToken,
  setLocalWebSessionCookie,
  setSessionCookie,
  verifyLaunchToken,
} from './auth-token.js';
import {
  extractGatewayChatApprovalEvent,
  formatGatewayChatApprovalSummary,
} from './chat-approval.js';
import {
  filterChatResultForSession,
  hasMessageSendToolExecution,
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from './chat-result.js';
import { escapeHtml, serveDocs } from './docs.js';
import {
  completeGatewayAdminConnectorOAuthCallback,
  getGatewayAdminConnectorsWithPlatformState,
  logoutGatewayAdminConnector,
  saveGatewayAdminHybridAIConnectorApiKey,
  startGatewayAdminConnectorOAuth,
  testGatewayAdminConnector,
} from './gateway-admin-connectors.js';
import {
  getGatewayAdminSecrets,
  overwriteGatewayAdminSecret,
  recordGatewayAdminSecretMutationFailure,
  unsetGatewayAdminSecret,
} from './gateway-admin-secrets.js';
import {
  createGatewayAdminToken,
  getGatewayAdminTokens,
  revokeGatewayAdminToken,
} from './gateway-admin-tokens.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import {
  deleteGatewayAdminDistillCorpusDocument,
  getGatewayAdminDistill,
  getGatewayAdminDistillCorpusDocument,
  recordGatewayAdminDistillConsent,
  registerGatewayAdminDistillAgent,
  runGatewayAdminDistillPipeline,
  uploadGatewayAdminDistillSource,
  upsertGatewayAdminDistillSubject,
} from './gateway-distill-service.js';
import {
  deleteGatewayAdminFleetTopologyInstance,
  getGatewayAdminFleetTopology,
  upsertGatewayAdminFleetTopologyInstance,
} from './gateway-fleet-topology.js';
import { handleApiHttpRequest } from './gateway-http-proxy.js';
import {
  parsePositiveInteger,
  readJsonBody,
  readRequestBody,
  sendJson,
} from './gateway-http-utils.js';
import { getGatewayAdminLogs } from './gateway-log-service.js';
import {
  getGatewayAdminPlugins,
  handleGatewayPluginWebhook,
  runGatewayPluginTool,
} from './gateway-plugin-service.js';
import { requestGatewayRestart } from './gateway-restart.js';
import {
  getGatewayAdminScheduler,
  moveGatewayAdminSchedulerJob,
  removeGatewayAdminSchedulerJob,
  setGatewayAdminSchedulerJobPaused,
  upsertGatewayAdminSchedulerJob,
} from './gateway-scheduled-task-service.js';
import { handleApiSecretInject } from './gateway-secret-injection.js';
import {
  applyGatewayAdminPolicyPreset,
  approveGatewayAdminA2APairingRequest,
  cleanupGatewayNoUserChatSessions,
  completeGatewayMcpOAuthCallback,
  createGatewayAdminAgent,
  createGatewayAdminSkill,
  declineGatewayAdminA2APairingRequest,
  deleteGatewayAdminA2ATrustPeer,
  deleteGatewayAdminAgent,
  deleteGatewayAdminEmailMessage,
  deleteGatewayAdminPolicyRule,
  deleteGatewayAdminSession,
  ensureGatewayBootstrapAutostart,
  getGatewayA2AAgentCard,
  getGatewayAdminA2AInbox,
  getGatewayAdminA2ATrust,
  getGatewayAdminAgentMarkdownFile,
  getGatewayAdminAgentMarkdownRevision,
  getGatewayAdminAgentScoreboard,
  getGatewayAdminAgents,
  getGatewayAdminApprovals,
  getGatewayAdminAudit,
  getGatewayAdminChannels,
  getGatewayAdminConfig,
  getGatewayAdminEmailFolder,
  getGatewayAdminEmailMailbox,
  getGatewayAdminEmailMessage,
  getGatewayAdminHybridAIBots,
  getGatewayAdminJobsContext,
  getGatewayAdminMcp,
  getGatewayAdminMcpOAuthStatus,
  getGatewayAdminModels,
  getGatewayAdminOverview,
  getGatewayAdminSessions,
  getGatewayAdminSkillInvocations,
  getGatewayAdminSkillPackageFile,
  getGatewayAdminSkillPackageFiles,
  getGatewayAdminSkills,
  getGatewayAdminStatistics,
  getGatewayAdminTeamStructure,
  getGatewayAdminTeamStructureRevision,
  getGatewayAdminTools,
  getGatewayAdminTunnelConfig,
  getGatewayAgentList,
  getGatewayAgents,
  getGatewayBootstrapAutostartState,
  getGatewayHistory,
  getGatewayHistorySummary,
  getGatewayRecentChatSessions,
  getGatewaySessionContextUsage,
  getGatewayStatus,
  handleGatewayCommand,
  logoutGatewayAdminMcpOAuth,
  previewGatewayAdminA2APairing,
  reconnectGatewayAdminTunnel,
  removeGatewayAdminChannel,
  removeGatewayAdminMcpServer,
  resolveGatewayChatbotId,
  restoreGatewayAdminAgentMarkdownRevision,
  restoreGatewayAdminTeamStructureRevision,
  revokeGatewayAdminA2ATrustPeer,
  saveGatewayAdminA2AE2EERequired,
  saveGatewayAdminA2ALocalMode,
  saveGatewayAdminAgentMarkdownFile,
  saveGatewayAdminConfig,
  saveGatewayAdminDiscordWebhookTarget,
  saveGatewayAdminModels,
  saveGatewayAdminPolicyDefault,
  saveGatewayAdminPolicyLanHttpAccess,
  saveGatewayAdminPolicyRule,
  saveGatewayAdminSkillPackageFile,
  saveGatewayAdminSlackWebhookTarget,
  saveGatewayAdminTunnelConfig,
  setGatewayAdminSkillEnabled,
  startGatewayAdminA2APairing,
  startGatewayAdminMcpOAuth,
  stopGatewayAdminTunnel,
  unblockGatewayAdminSkill,
  updateGatewayAdminAgent,
  uploadGatewayAdminSkillZip,
  upsertGatewayAdminA2ATrustPeer,
  upsertGatewayAdminChannel,
  upsertGatewayAdminMcpServer,
} from './gateway-service.js';
import type {
  GatewayAdminA2APairingDecisionRequest,
  GatewayAdminA2APairingStartRequest,
  GatewayAdminA2ATrustUpsertRequest,
  GatewayAdminDiscordWebhookTargetRequest,
  GatewayAdminFleetTopologyUpsertRequest,
  GatewayAdminSlackWebhookTargetRequest,
  GatewayChatBranchRequestBody,
  GatewayChatRequest,
  GatewayChatRequestBody,
  GatewayChatResult,
  GatewayChatResultMessageRole,
  GatewayCommandRequest,
} from './gateway-types.js';
import { normalizeHttpOrigin } from './gateway-url-utils.js';
import {
  extensionToMimeType,
  resolveWorkspaceRelativePath,
} from './gateway-utils.js';
import {
  clearOperatorReturn,
  consumeOperatorReturn,
  createSuspendedSession,
  detectTwoFactorChallenge,
  emitInteractionNeededEvent,
  findPendingSuspendedSessionForOperator,
  formatInteractionRequest,
  INTERACTION_MODALITIES,
  type InteractionModality,
  type OperatorReturn,
  parseOperatorReturnText,
  peekOperatorReturn,
  resumeWith,
  resumeWithText,
} from './interactive-escalation.js';
import { consumeGatewayMediaUploadQuota } from './media-upload-quota.js';
import {
  isMSTeamsTabViewerAllowed,
  type MSTeamsTabSsoConfig,
  MSTeamsTabTokenError,
  type MSTeamsTabViewer,
  resolveMSTeamsTabConfig,
  TEAMS_APP_ENTITY_ID,
  TEAMS_DESKTOP_CLIENT_ID,
  TEAMS_FRAME_ANCESTORS,
  TEAMS_JS_SDK_URL,
  TEAMS_TAB_SCOPE,
  TEAMS_WEB_CLIENT_ID,
  validateMSTeamsTabIdToken,
} from './msteams-tab.js';
import {
  handleOpenAICompatibleChatCompletions,
  handleOpenAICompatibleCompletionRetrieve,
  handleOpenAICompatibleModelList,
} from './openai-compatible.js';
import {
  getGatewayAdminOutputGuardProfile,
  previewGatewayAdminOutputGuardProfile,
  updateGatewayAdminOutputGuardProfile,
} from './output-guard-admin.js';
import {
  isSupportedProactiveChannelId,
  shouldSuppressProactiveMessage,
} from './proactive-delivery.js';
import { renderQrSvg } from './qr-svg.js';
import {
  ResponseRatingNotFoundError,
  submitResponseRating,
} from './response-ratings.js';
import {
  detectCliSecretSetCommand,
  renderCliSecretSetCommandWarning,
} from './secret-command-guard.js';
import {
  handleTextChannelApprovalCommand,
  renderTextChannelCommandResult,
  resolveTextChannelSlashCommands,
} from './text-channel-commands.js';

const SITE_DIR = resolveInstallPath('docs');
const CONSOLE_DIST_DIR = resolveInstallPath('console', 'dist');
const TEAMS_COLOR_ICON_PATH = resolveInstallPath(
  'docs',
  'static',
  'teams-color.png',
);
const TEAMS_OUTLINE_ICON_PATH = resolveInstallPath(
  'docs',
  'static',
  'teams-outline.png',
);
const AGENT_ARTIFACT_ROOT = path.resolve(path.join(DATA_DIR, 'agents'));
const HARNESS_EVOLUTION_ALLOWED_ROOTS = [
  path.join(DATA_DIR, 'harness-evolution'),
  ...(process.env.HYBRIDCLAW_HARNESS_EVOLUTION_ROOTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
].map((entry) => path.resolve(entry));
let resolvedHarnessEvolutionAllowedRootsPromise: Promise<string[]> | null =
  null;
const DISCORD_MEDIA_CACHE_ROOT_DISPLAY = '/discord-media-cache';
const DISCORD_MEDIA_CACHE_DIR = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);
const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;
const HYBRIDAI_LOGIN_PATH = '/login?context=hybridclaw&next=/admin_api_keys';
const HISTORY_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIVE_APP_BRIDGE_MAX_ARGS_BYTES = 64 * 1024;
const LIVE_APP_BRIDGE_TIMEOUT_MS = 120_000;
const LIVE_APP_BRIDGE_INACTIVITY_TIMEOUT_MS = 60_000;
const LIVE_APP_BRIDGE_MAX_TOOL_NAME_LENGTH = 512;
const LIVE_APP_BRIDGE_READ_ONLY_TOOL_PREFIXES = new Set([
  'describe',
  'fetch',
  'find',
  'get',
  'list',
  'lookup',
  'query',
  'read',
  'retrieve',
  'search',
]);
const APP_PUBLICATION_VIEW_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1000;
const APP_PUBLICATION_SESSION_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const APP_PUBLICATION_SESSION_RATE_LIMIT_MAX_FAILURES = 8;
const APP_PUBLICATION_SHELL_SCRIPT_PATH = '/pub-shell.js';
const APP_PUBLICATION_OIDC_CALLBACK_PATH = '/pub-oidc-callback';
const TEAMS_MANIFEST_UUID_NAMESPACE = '9aeaf9e5-ffb9-47c0-8f2f-a496047e1a26';

const publicationSessionFailures = new Map<
  string,
  { count: number; resetAt: number }
>();

const SITE_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.m4v': extensionToMimeType('.m4v'),
  '.mov': extensionToMimeType('.mov'),
  '.mp4': extensionToMimeType('.mp4'),
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const SAFE_INLINE_ARTIFACT_MIME_TYPES: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4v': extensionToMimeType('.m4v'),
  '.mov': extensionToMimeType('.mov'),
  '.mp4': extensionToMimeType('.mp4'),
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.webm': extensionToMimeType('.webm'),
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const ALLOWED_MEDIA_UPLOAD_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/xml',
]);

type ApiChatRequestBody = GatewayChatRequestBody & { stream?: boolean };
type ApiChatBranchRequestBody = Partial<GatewayChatBranchRequestBody>;
type ApiMessageActionRequestBody = Partial<DiscordToolActionRequest>;
type ApiAdminTerminalRequestBody = {
  cols?: number;
  rows?: number;
};
type ApiAdminPolicyRequestBody = {
  agentId?: unknown;
  index?: unknown;
  defaultAction?: unknown;
  lanHttpAccessMode?: unknown;
  presetName?: unknown;
  rule?: unknown;
};

type GatewayBrowserSessionEntry = {
  provider: BrowserProvider;
  providerKind: RuntimeBrowserProviderKind;
  configSignature: string;
  session: BrowserSession;
  skillName: string;
};

const gatewayBrowserSessions = new Map<string, GatewayBrowserSessionEntry>();

async function handleApiAdminBrowserPoolHealth(
  res: ServerResponse,
): Promise<void> {
  const browserConfig = getRuntimeConfig().browser;
  if (browserConfig.provider !== 'managed-cloud') {
    sendJson(res, 200, {
      ok: false,
      status: 'disabled',
      endpointUrl: browserConfig.managedCloud.endpointUrl,
      nodeCount: 0,
      healthyNodeCount: 0,
      message: 'Browser provider is not managed-cloud.',
    });
    return;
  }
  const health = await checkManagedBrowserPoolHealth(
    browserConfig.managedCloud.endpointUrl,
  );
  sendJson(res, 200, {
    ...health,
    status: health.ok ? 'online' : 'offline',
  });
}

async function handleApiAdminBrowserPoolStart(
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, await startLocalManagedBrowserPool());
}

function normalizeGatewayBrowserSessionId(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new GatewayRequestError(400, 'Missing `sessionId`.');
  return normalized;
}

function normalizeGatewayBrowserAgentId(value: unknown): string {
  const normalized = String(value || '').trim();
  return normalized || DEFAULT_AGENT_ID;
}

function gatewayBrowserTextPreviewHint(params: {
  contentLength: number;
  hasNoscript: boolean;
  rootShell: boolean;
}): string {
  if (params.contentLength > 0) return 'ok';
  if (params.hasNoscript) return 'javascript_required';
  if (params.rootShell) return 'spa_shell_only';
  return 'empty_extraction';
}

function normalizeGatewayBrowserSkillName(value: unknown): string {
  const normalized = String(value || '').trim();
  return normalized || 'browser';
}

function getGatewayBrowserSelector(
  args: Record<string, unknown>,
  opts?: { allowAtRef?: boolean },
): string {
  const selector = String(args.selector || '').trim();
  if (selector) return selector;
  const ref = String(args.ref || '').trim();
  if (!ref) return '';
  if (ref.startsWith('@') && opts?.allowAtRef !== true) return '';
  return ref;
}

function getGatewayBrowserActionSelector(
  active: GatewayBrowserSessionEntry,
  args: Record<string, unknown>,
): string {
  return getGatewayBrowserSelector(args, {
    allowAtRef: isMacCuaGatewaySession(active),
  });
}

async function getGatewayBrowserResumeSelector(
  active: GatewayBrowserSessionEntry,
  args: Record<string, unknown>,
): Promise<string> {
  const explicitSelector = getGatewayBrowserActionSelector(active, args);
  if (explicitSelector) return explicitSelector;
  if (!isMacCuaGatewaySession(active)) return '';
  const state = await active.session.inspectTwoFactorChallenge?.();
  return state?.selectors?.[0] || '';
}

function parseGatewayBrowserCoordinate(
  args: Record<string, unknown>,
): { x: number; y: number } | null {
  const ref = String(args.ref || '').trim();
  const refMatch = ref.match(/^@?viewport-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/i);
  const rawX = refMatch ? refMatch[1] : args.x;
  const rawY = refMatch ? refMatch[2] : args.y;
  if (rawX == null && rawY == null) return null;
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new GatewayRequestError(
      400,
      'x and y must be non-negative viewport coordinates.',
    );
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function browserRendererFunction<T>(source: string): () => T {
  return new Function(`return (${source});`)() as () => T;
}

function unsupportedGatewayBrowserTool(toolName: string): never {
  throw new GatewayRequestError(
    400,
    `${toolName} is not supported by the configured browser provider.`,
  );
}

function isMacCuaGatewaySession(active: GatewayBrowserSessionEntry): boolean {
  return active.providerKind === 'mac-cua';
}

function sanitizeGatewayUploadName(value: unknown, index: number): string {
  const basename = path.basename(String(value || '').trim());
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${index + 1}-${sanitized || 'upload'}`;
}

function writeGatewayBrowserUploadFiles(args: Record<string, unknown>): {
  dir: string;
  paths: string[];
} {
  const payloads = Array.isArray(args.filePayloads) ? args.filePayloads : [];
  if (payloads.length === 0) {
    throw new GatewayRequestError(
      400,
      'browser_upload requires filePayloads when using managed-cloud.',
    );
  }
  const dir = path.join(
    DATA_DIR,
    'tmp',
    'managed-browser-uploads',
    randomUUID(),
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  try {
    payloads.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new GatewayRequestError(
          400,
          'Invalid browser_upload file payload.',
        );
      }
      const record = entry as Record<string, unknown>;
      const dataBase64 = String(record.dataBase64 || '');
      if (!dataBase64) {
        throw new GatewayRequestError(
          400,
          'Invalid browser_upload file payload: missing dataBase64.',
        );
      }
      const filePath = path.join(
        dir,
        sanitizeGatewayUploadName(record.name, index),
      );
      fs.writeFileSync(filePath, Buffer.from(dataBase64, 'base64'), {
        mode: 0o600,
      });
      paths.push(filePath);
    });
    return { dir, paths };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function normalizeGatewayBrowserWaypoint(
  toolName: string,
): BrowserWaypointEvent {
  if (
    toolName === 'browser_await_two_factor' ||
    toolName === 'browser_resume_interaction'
  ) {
    return toolName;
  }
  throw new GatewayRequestError(400, `Invalid browser waypoint: ${toolName}`);
}

function safeGatewayBrowserUrlHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

async function readGatewayBrowserTwoFactorPageState(
  active: GatewayBrowserSessionEntry,
): Promise<{
  url: string;
  title: string;
  preview: string;
  selectors: string[];
  nativeDetection?: BrowserTwoFactorState;
}> {
  if (isMacCuaGatewaySession(active)) {
    const nativeDetection = await active.session.inspectTwoFactorChallenge?.();
    return {
      url: nativeDetection?.url || 'about:blank',
      title: nativeDetection?.title || '',
      preview: nativeDetection?.preview || '',
      selectors: nativeDetection?.selectors || [],
      ...(nativeDetection ? { nativeDetection } : {}),
    };
  }
  const pageState = await active.session.evaluate(
    browserRendererFunction<{
      url: string;
      title: string;
      preview: string;
      selectors: string[];
    }>(EXTRACT_TWO_FACTOR_PAGE_STATE_FUNCTION_SOURCE),
  );
  return {
    url: pageState.url,
    title: pageState.title,
    preview: pageState.preview,
    selectors: pageState.selectors,
  };
}

async function parkGatewayBrowserTwoFactor(params: {
  active: GatewayBrowserSessionEntry;
  activeSseResponses: Set<ServerResponse>;
  sessionId: string;
  agentId: string;
  args: Record<string, unknown>;
  pageState?: {
    url: string;
    title: string;
    preview: string;
    selectors: string[];
    nativeDetection?: BrowserTwoFactorState;
  };
}): Promise<Record<string, unknown> | null> {
  const pageState =
    params.pageState ||
    (await readGatewayBrowserTwoFactorPageState(params.active));
  const detection = pageState.nativeDetection?.detected
    ? {
        detected: true,
        modality: pageState.nativeDetection.modality || 'totp',
        signals: pageState.nativeDetection.signals || ['native 2fa signal'],
        selectors: pageState.nativeDetection.selectors || [],
        ...(pageState.preview ? { textPreview: pageState.preview } : {}),
      }
    : detectTwoFactorChallenge({
        args: params.args,
        title: pageState.title,
        text: pageState.preview,
        selectors: pageState.selectors,
      });
  if (!detection.detected) return null;

  const modality = parseInteractionModality(
    params.args.modality || detection.modality || 'totp',
  );
  const prompt =
    normalizeOptionalString(params.args.prompt) ||
    `A ${modality} challenge needs operator input.`;
  const targetChannel = normalizeOptionalString(params.args.escalationChannel);
  const targetRecipient = normalizeOptionalString(
    params.args.escalationRecipient,
  );
  const escalationTarget =
    targetChannel && targetRecipient
      ? { channel: targetChannel, recipient: targetRecipient }
      : undefined;
  const image = await params.active.session.screenshot({
    fullPage: true,
    type: 'png',
  });
  const screenshotBase64 = Buffer.from(image).toString('base64');
  const screenshotRef = `managed-browser://${params.sessionId}/two-factor-${randomUUID()}.png`;
  const session = createSuspendedSession({
    prompt,
    userId:
      normalizeOptionalString(params.args.userId) ||
      escalationTarget?.recipient ||
      'operator',
    modality,
    frameSnapshot: {
      url: pageState.url || 'about:blank',
      title: pageState.title || '',
      browserSessionKey: params.sessionId,
      screenshotRef,
    },
    context: {
      host: safeGatewayBrowserUrlHost(pageState.url || ''),
      pageTitle: pageState.title || null,
      url: pageState.url || 'about:blank',
    },
    agentId: params.agentId,
    skillId: normalizeOptionalString(params.args.skillId) || null,
    escalationTarget,
    ttlMs:
      typeof params.args.ttlMs === 'number' &&
      Number.isFinite(params.args.ttlMs)
        ? params.args.ttlMs
        : null,
    artifacts: {
      screenshotBase64,
    },
  });
  await params.active.session.waypoint?.('browser_await_two_factor', {
    modality,
    prompt,
    sessionId: session.sessionId,
  });
  emitInteractionNeededEvent({ session });
  const notification = queueInteractionNotification(session);
  const payload = { session, notification };
  broadcastSseEvent(params.activeSseResponses, 'interaction_needed', payload);
  return {
    parked: true,
    modality,
    suspended_session_id: session.sessionId,
    approval_id: session.approvalId,
    two_factor_detection: detection,
    detected_selectors: pageState.selectors,
    text_preview: pageState.preview,
    screenshot: session.frameSnapshot.screenshotRef || null,
    interaction: payload,
  };
}

async function sendGatewayBrowserActionJson(
  res: ServerResponse,
  params: {
    active: GatewayBrowserSessionEntry;
    activeSseResponses: Set<ServerResponse>;
    sessionId: string;
    agentId: string;
    args: Record<string, unknown>;
    fields: Record<string, unknown>;
  },
): Promise<void> {
  const parked = await parkGatewayBrowserTwoFactor(params);
  sendJson(res, 200, {
    success: true,
    ...params.fields,
    ...(parked || {}),
  });
}

async function getGatewayBrowserSession(
  sessionId: string,
  agentId: string,
  opts?: { headed?: boolean; skillName?: string },
): Promise<GatewayBrowserSessionEntry> {
  const browserConfig = getRuntimeConfig().browser;
  const configSignature = browserSessionConfigSignature(browserConfig);
  const existing = gatewayBrowserSessions.get(sessionId);
  if (existing) {
    if (existing.configSignature === configSignature) return existing;
    try {
      await existing.provider.closeSession(existing.session);
    } catch (err) {
      logger.warn(
        { err, sessionId },
        'Failed to close stale gateway browser session after browser config change',
      );
    }
    gatewayBrowserSessions.delete(sessionId);
  }
  const provider = createBrowserProvider(browserConfig);
  const skillName = normalizeGatewayBrowserSkillName(opts?.skillName);
  const session = await provider.launchSession({
    headed: opts?.headed,
    timeoutMs: 60_000,
    metering: {
      sessionId,
      agentId,
      auditRunId: `gateway_browser_${randomUUID().replace(/-/g, '')}`,
      skillName,
    },
  });
  const entry = {
    provider,
    providerKind: browserConfig.provider,
    configSignature,
    session,
    skillName,
  };
  gatewayBrowserSessions.set(sessionId, entry);
  return entry;
}

async function handleApiBrowserTool(
  req: IncomingMessage,
  res: ServerResponse,
  activeSseResponses: Set<ServerResponse>,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const toolName = String(body.toolName || '').trim();
  const sessionId = normalizeGatewayBrowserSessionId(body.sessionId);
  const agentId = normalizeGatewayBrowserAgentId(body.agentId);
  const args =
    body.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};

  if (toolName === 'browser_close') {
    const active = gatewayBrowserSessions.get(sessionId);
    if (active) {
      await active.provider.closeSession(active.session);
      gatewayBrowserSessions.delete(sessionId);
    }
    sendJson(res, 200, { success: true, closed: true });
    return;
  }

  if (toolName === 'browser_navigate') {
    const url = String(args.url || '').trim();
    if (!url) throw new GatewayRequestError(400, 'Missing `args.url`.');
    const active = await getGatewayBrowserSession(sessionId, agentId, {
      headed: args.headed === true || args.headful === true,
    });
    if (isMacCuaGatewaySession(active)) {
      await active.session.navigate(url);
      await sendGatewayBrowserActionJson(res, {
        active,
        activeSseResponses,
        sessionId,
        agentId,
        args,
        fields: {
          url,
          title: '',
          content_text_length: 0,
          content_preview_truncated: false,
          ready_state: 'native',
          read_extraction_hint: 'native_browser',
        },
      });
      return;
    }
    await active.session.navigate(url, {
      timeoutMs: 60_000,
      waitUntil: 'domcontentloaded',
    });
    const pageState = await active.session.evaluate(
      browserRendererFunction<{
        url: string;
        title: string;
        text_length: number;
        preview: string;
        preview_truncated: boolean;
        has_noscript: boolean;
        root_shell: boolean;
        ready_state: string;
      }>(EXTRACT_TEXT_PREVIEW_FUNCTION_SOURCE),
    );
    await sendGatewayBrowserActionJson(res, {
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args,
      fields: {
        url: pageState.url || url,
        title: pageState.title || '',
        content_text_length: pageState.text_length || 0,
        ...(pageState.preview ? { content_preview: pageState.preview } : {}),
        content_preview_truncated: pageState.preview_truncated === true,
        ready_state: pageState.ready_state || '',
        read_extraction_hint: gatewayBrowserTextPreviewHint({
          contentLength: pageState.text_length || 0,
          hasNoscript: pageState.has_noscript === true,
          rootShell: pageState.root_shell === true,
        }),
      },
    });
    return;
  }

  if (toolName === 'browser_screenshot') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    const image = await active.session.screenshot({
      fullPage: args.fullPage === true,
      type: 'png',
    });
    sendJson(res, 200, {
      success: true,
      imageBase64: Buffer.from(image).toString('base64'),
    });
    return;
  }

  if (toolName === 'browser_snapshot') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    if (isMacCuaGatewaySession(active)) {
      await sendGatewayBrowserActionJson(res, {
        active,
        activeSseResponses,
        sessionId,
        agentId,
        args,
        fields: {
          snapshot:
            'Native macOS browser provider does not expose a DOM snapshot. Use browser_screenshot for visual state and AX selectors such as ax:1 or query text for actions.',
          truncated: false,
          element_count: 0,
          url: '',
          title: '',
          mode: String(args.mode || 'default'),
          frames: [],
          two_factor_detection: { detected: false, signals: [] },
        },
      });
      return;
    }
    const pageState = await active.session.evaluate(() => {
      const bodyText = document.body
        ? String(document.body.innerText || '')
        : '';
      const normalized = bodyText
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const elements = Array.from(
        document.querySelectorAll(
          'a,button,input,textarea,select,summary,[role="button"],[role="link"]',
        ),
      )
        .slice(0, 100)
        .map((element, index) => {
          const tag = String(element.tagName || '').toLowerCase();
          const label = String(
            element.getAttribute('aria-label') ||
              element.getAttribute('placeholder') ||
              element.textContent ||
              element.getAttribute('value') ||
              '',
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
          const id = element.id ? `#${element.id}` : '';
          const name = element.getAttribute('name') || '';
          return `@managed-${index + 1} ${tag}${id}${name ? ` [name="${name}"]` : ''}${label ? ` - ${label}` : ''}`;
        });
      const snapshot = [
        `URL: ${String(window.location.href || '')}`,
        `Title: ${String(document.title || '')}`,
        '',
        normalized.slice(0, 12_000),
        elements.length ? '\nInteractive elements:' : '',
        ...elements,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        url: String(window.location.href || ''),
        title: String(document.title || ''),
        snapshot,
        truncated: normalized.length > 12_000,
        elementCount: elements.length,
      };
    });
    await sendGatewayBrowserActionJson(res, {
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args,
      fields: {
        snapshot: pageState.snapshot,
        truncated: pageState.truncated === true,
        element_count: pageState.elementCount || 0,
        url: pageState.url || '',
        title: pageState.title || '',
        mode: String(args.mode || 'default'),
        frames: [],
        two_factor_detection: { detected: false, signals: [] },
      },
    });
    return;
  }

  if (toolName === 'browser_click') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    const selector = getGatewayBrowserActionSelector(active, args);
    const text = String(args.text || '').trim();
    const coordinate = parseGatewayBrowserCoordinate(args);
    if (selector) {
      await active.session.click(selector, { timeoutMs: 30_000 });
      await sendGatewayBrowserActionJson(res, {
        active,
        activeSseResponses,
        sessionId,
        agentId,
        args,
        fields: { selector },
      });
      return;
    }
    if (text) {
      if (isMacCuaGatewaySession(active)) {
        await active.session.click(text, { timeoutMs: 30_000 });
        await sendGatewayBrowserActionJson(res, {
          active,
          activeSseResponses,
          sessionId,
          agentId,
          args,
          fields: { text },
        });
        return;
      }
      const clicked = await active.session.evaluate(
        browserRendererFunction<boolean>(`
          () => {
            const needle = ${JSON.stringify(text.toLowerCase())};
            const candidates = Array.from(document.querySelectorAll('a,button,input,summary,[role="button"],[role="link"],label'));
            const target = candidates.find((element) => {
              const value = String(
                element.getAttribute('aria-label') ||
                element.getAttribute('value') ||
                element.textContent ||
                '',
              ).replace(/\\s+/g, ' ').trim().toLowerCase();
              return value === needle || value.includes(needle);
            });
            if (!target) return false;
            if (typeof target.scrollIntoView === 'function') {
              target.scrollIntoView({ block: 'center', inline: 'center' });
            }
            if (typeof target.click === 'function') {
              target.click();
              return true;
            }
            return false;
          }
        `),
      );
      if (!clicked) {
        throw new GatewayRequestError(
          404,
          `No managed browser element matched text: ${text}`,
        );
      }
      await sendGatewayBrowserActionJson(res, {
        active,
        activeSseResponses,
        sessionId,
        agentId,
        args,
        fields: { text },
      });
      return;
    }
    if (coordinate) {
      if (isMacCuaGatewaySession(active)) {
        throw new GatewayRequestError(
          400,
          'mac-cua requires AX or query targeting; raw x/y coordinates are only available as provider-controlled pixel fallback.',
        );
      }
      const clicked = await active.session.evaluate(
        browserRendererFunction<boolean>(`
          () => {
            const element = document.elementFromPoint(${coordinate.x}, ${coordinate.y});
            if (!element || typeof element.click !== 'function') return false;
            element.click();
            return true;
          }
        `),
      );
      if (!clicked) {
        throw new GatewayRequestError(
          404,
          `No managed browser element found at ${coordinate.x},${coordinate.y}`,
        );
      }
      await sendGatewayBrowserActionJson(res, {
        active,
        activeSseResponses,
        sessionId,
        agentId,
        args,
        fields: { x: coordinate.x, y: coordinate.y },
      });
      return;
    }
    throw new GatewayRequestError(
      400,
      'browser_click requires selector, text, or x/y coordinates.',
    );
  }

  if (toolName === 'browser_type' || toolName === 'browser_secret_type') {
    const skillName = normalizeGatewayBrowserSkillName(args.skillName);
    const active = await getGatewayBrowserSession(sessionId, agentId, {
      skillName,
    });
    const selector = getGatewayBrowserActionSelector(active, args);
    if (!selector) {
      throw new GatewayRequestError(
        400,
        `${toolName} requires a selector when using the configured browser provider.`,
      );
    }
    const value: SecretInput =
      toolName === 'browser_secret_type'
        ? {
            source: 'store',
            id: String(args.secretName || '').trim(),
          }
        : String(args.text || '');
    if (
      toolName === 'browser_secret_type' &&
      !String(args.secretName || '').trim()
    ) {
      throw new GatewayRequestError(
        400,
        'browser_secret_type requires secretName.',
      );
    }
    const preFillParked = await parkGatewayBrowserTwoFactor({
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args,
    });
    if (preFillParked) {
      sendJson(res, 200, {
        success: true,
        selector,
        typed_chars: 0,
        secret_injected: false,
        code_injected: false,
        ...preFillParked,
      });
      return;
    }
    await active.session.fill(selector, value);
    await sendGatewayBrowserActionJson(res, {
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args,
      fields: {
        selector,
        typed_chars:
          toolName === 'browser_secret_type'
            ? 0
            : String(args.text || '').length,
        secret_injected: toolName === 'browser_secret_type',
      },
    });
    return;
  }

  if (toolName === 'browser_scroll') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    const direction = String(args.direction || 'down').toLowerCase();
    if (
      direction !== 'up' &&
      direction !== 'down' &&
      direction !== 'left' &&
      direction !== 'right'
    ) {
      throw new GatewayRequestError(
        400,
        'browser_scroll direction must be up, down, left, or right.',
      );
    }
    const rawPixels = Number(args.pixels);
    const pixels =
      Number.isFinite(rawPixels) && rawPixels > 0 ? Math.floor(rawPixels) : 800;
    await active.session.scroll({
      direction,
      deltaY: direction === 'up' ? -pixels : direction === 'down' ? pixels : 0,
      deltaX:
        direction === 'left' ? -pixels : direction === 'right' ? pixels : 0,
    });
    await sendGatewayBrowserActionJson(res, {
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args,
      fields: { direction, pixels },
    });
    return;
  }

  if (toolName === 'browser_back') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    if (isMacCuaGatewaySession(active)) {
      await active.session.back();
      await sendGatewayBrowserActionJson(res, {
        active,
        activeSseResponses,
        sessionId,
        agentId,
        args,
        fields: { url: '' },
      });
      return;
    }
    await active.session.back({
      timeoutMs: 30_000,
      waitUntil: 'domcontentloaded',
    });
    const url = await active.session.evaluate(() =>
      String(window.location.href || ''),
    );
    await sendGatewayBrowserActionJson(res, {
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args,
      fields: { url },
    });
    return;
  }

  if (toolName === 'browser_press') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    const key = String(args.key || '').trim();
    if (!key) throw new GatewayRequestError(400, 'browser_press requires key.');
    if (isMacCuaGatewaySession(active)) {
      if (!active.session.press) unsupportedGatewayBrowserTool(toolName);
      await active.session.press(key);
      await sendGatewayBrowserActionJson(res, {
        active,
        activeSseResponses,
        sessionId,
        agentId,
        args,
        fields: { key },
      });
      return;
    }
    const pressed = await active.session.evaluate(
      browserRendererFunction<boolean>(`
        () => {
          const key = ${JSON.stringify(key)};
          const target = document.activeElement;
          if (!target) return false;
          const eventInit = { key, bubbles: true, cancelable: true };
          target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
          target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
          return true;
        }
      `),
    );
    if (!pressed) unsupportedGatewayBrowserTool(toolName);
    await sendGatewayBrowserActionJson(res, {
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args,
      fields: { key },
    });
    return;
  }

  if (toolName === 'browser_get_images') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    if (isMacCuaGatewaySession(active)) {
      unsupportedGatewayBrowserTool(toolName);
    }
    const images = await active.session.evaluate(() =>
      Array.from(document.images)
        .map((img) => ({
          src: String(img.currentSrc || img.src || ''),
          alt: String(img.alt || ''),
          width: Number(img.naturalWidth || img.width || 0),
          height: Number(img.naturalHeight || img.height || 0),
        }))
        .filter((img) => img.src),
    );
    sendJson(res, 200, {
      success: true,
      count: images.length,
      images,
    });
    return;
  }

  if (toolName === 'browser_network') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    if (isMacCuaGatewaySession(active)) {
      unsupportedGatewayBrowserTool(toolName);
    }
    const filter = String(args.filter || '').trim();
    const entries = await active.session.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => ({
          url: String(entry.name || ''),
          method: 'GET',
          status: null,
          type: String(
            (entry as PerformanceResourceTiming).initiatorType || '',
          ),
          startTime: Number(entry.startTime || 0),
          duration: Number(entry.duration || 0),
        }))
        .filter((entry) => entry.url),
    );
    const requests = filter
      ? entries.filter((entry) => entry.url.includes(filter))
      : entries;
    sendJson(res, 200, {
      success: true,
      requests,
      count: requests.length,
      source: 'performance',
    });
    return;
  }

  if (toolName === 'browser_upload') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    if (!active.session.upload) unsupportedGatewayBrowserTool(toolName);
    const selector = getGatewayBrowserSelector(args);
    if (!selector) {
      throw new GatewayRequestError(
        400,
        'browser_upload requires a CSS selector when using managed-cloud.',
      );
    }
    const upload = writeGatewayBrowserUploadFiles(args);
    try {
      await active.session.upload(selector, upload.paths);
      sendJson(res, 200, {
        success: true,
        selector,
        target: selector,
        uploaded_count: upload.paths.length,
      });
    } finally {
      fs.rmSync(upload.dir, { recursive: true, force: true });
    }
    return;
  }

  if (toolName === 'browser_pdf') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    if (!active.session.pdf) unsupportedGatewayBrowserTool(toolName);
    const pdf = await active.session.pdf({
      printBackground: args.printBackground !== false,
      format: typeof args.format === 'string' ? args.format : undefined,
    });
    sendJson(res, 200, {
      success: true,
      pdfBase64: Buffer.from(pdf).toString('base64'),
    });
    return;
  }

  if (toolName === 'browser_console') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    if (!active.session.consoleMessages)
      unsupportedGatewayBrowserTool(toolName);
    const rawLimit = Number(args.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 500)
        : 200;
    const messages = await active.session.consoleMessages({
      clear: args.clear === true,
      limit,
    });
    sendJson(res, 200, {
      success: true,
      messages,
      count: messages.length,
      cleared: args.clear === true,
    });
    return;
  }

  if (toolName === 'browser_await_two_factor') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    const payload = await parkGatewayBrowserTwoFactor({
      active,
      activeSseResponses,
      sessionId,
      agentId,
      args: { ...args, expects_2fa: true },
    });
    if (!payload) {
      throw new GatewayRequestError(409, 'No 2FA challenge was detected.');
    }
    sendJson(res, 200, {
      success: true,
      ...payload,
    });
    return;
  }

  if (toolName === 'browser_resume_interaction') {
    const active = await getGatewayBrowserSession(sessionId, agentId);
    const waypoint = normalizeGatewayBrowserWaypoint(toolName);
    const suspendedSessionId =
      normalizeOptionalString(args.sessionId) || sessionId;
    const response = peekOperatorReturn(suspendedSessionId);
    if (!response) {
      throw new GatewayRequestError(
        404,
        'No operator response is available for this suspended session.',
      );
    }
    if (response.kind === 'code') {
      const explicitSelector = getGatewayBrowserActionSelector(active, args);
      const selector = explicitSelector
        ? explicitSelector
        : await getGatewayBrowserResumeSelector(active, args);
      let filledSelector = selector;
      let fillStrategy = selector ? 'selector' : '';
      let codeSubmitted = false;
      if (explicitSelector || selector) {
        await active.session.fill(
          selector,
          createOperatorReturnCodeHandle(response.value),
        );
      } else if (active.session.fillTwoFactorCode) {
        const result = await active.session.fillTwoFactorCode(
          createOperatorReturnCodeHandle(response.value),
        );
        filledSelector = result.selector || '';
        fillStrategy = result.strategy;
        codeSubmitted = result.submitted === true;
      } else {
        throw new GatewayRequestError(
          400,
          'browser_resume_interaction requires selector for code injection with managed-cloud.',
        );
      }
      await active.session.waypoint?.(waypoint, {
        sessionId: suspendedSessionId,
        responseKind: response.kind,
      });
      clearOperatorReturn(suspendedSessionId);
      sendJson(res, 200, {
        success: true,
        resumed: true,
        response_kind: 'code',
        code_injected: true,
        ...(filledSelector ? { selector: filledSelector } : {}),
        fill_strategy: fillStrategy,
        ...(codeSubmitted ? { code_submitted: true } : {}),
      });
      return;
    }
    await active.session.waypoint?.(waypoint, {
      sessionId: suspendedSessionId,
      responseKind: response.kind,
    });
    clearOperatorReturn(suspendedSessionId);
    sendJson(res, 200, {
      success: true,
      resumed: true,
      response_kind: response.kind,
      operator_completed_challenge:
        response.kind === 'approved' || response.kind === 'scanned',
    });
    return;
  }

  throw new GatewayRequestError(
    400,
    `Unsupported gateway browser tool: ${toolName}`,
  );
}

function normalizeStringListInput(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? [normalized] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function parseEmailRecipientListInput(
  value: unknown,
  label: 'cc' | 'bcc',
): string[] | undefined {
  const normalized = normalizeStringListInput(value);
  if (!normalized) return undefined;

  const recipients: string[] = [];
  for (const entry of normalized) {
    const address = normalizeEmailAddress(entry);
    if (!address) {
      throw new Error(`Invalid \`${label}\` email address: ${entry}`);
    }
    recipients.push(address);
  }
  return recipients.length > 0 ? recipients : undefined;
}

function parseOptionalStringInput(
  value: unknown,
  label: 'inReplyTo',
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`\`${label}\` must be a string.`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function parseThreadReferenceListInput(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? [normalized] : undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('`references` must be a string or array of strings.');
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('`references` must be a string or array of strings.');
    }
    const candidate = entry.trim();
    if (!candidate) continue;
    normalized.push(candidate);
  }

  if (normalized.length === 0) return undefined;
  return [...new Set(normalized)];
}

type ApiPluginToolRequestBody = {
  toolName?: unknown;
  args?: unknown;
  sessionId?: unknown;
  channelId?: unknown;
};

type ApiChatMobileQrRequestBody = {
  userId?: unknown;
  sessionId?: unknown;
  baseUrl?: unknown;
};

const MOBILE_LAUNCH_TTL_MS = 10 * 60 * 1000;
const MOBILE_LAUNCH_TOKEN_MAX_ENTRIES = 10_000;
type MobileLaunchTokenEntry = {
  userId: string;
  sessionId: string;
  authPayload: Record<string, unknown>;
  expiresAt: number;
};
const mobileLaunchTokens = new Map<string, MobileLaunchTokenEntry>();
let deploymentPublicUrl = getRuntimeConfig().deployment.public_url;
onRuntimeConfigChange((next) => {
  deploymentPublicUrl = next.deployment.public_url;
});

function parseApiAdminPolicyIndex(value: unknown): number {
  const parsed = parsePositiveInteger(value);
  if (parsed == null) {
    throw new GatewayRequestError(400, 'Expected positive integer `index`.');
  }
  return parsed;
}

function parseApiAdminPolicyStringList(
  value: unknown,
  label: 'methods' | 'paths',
): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const normalized = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!Array.isArray(value)) {
    throw new GatewayRequestError(
      400,
      `Expected \`${label}\` to be a string or array of strings.`,
    );
  }
  const normalized = value
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new GatewayRequestError(
          400,
          `Expected \`${label}\` to be a string or array of strings.`,
        );
      }
      return entry.trim();
    })
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function parseApiAdminPolicyPort(value: unknown): number | '*' {
  if (value == null) return '*';
  if (value === '*') return '*';
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0 && value <= 65_535) {
      return value;
    }
    throw new GatewayRequestError(
      400,
      'Expected `port` to be `*` or an integer from 1 to 65535.',
    );
  }
  if (typeof value !== 'string') {
    throw new GatewayRequestError(
      400,
      'Expected `port` to be `*` or an integer from 1 to 65535.',
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized === '*') return '*';
  if (!/^\d+$/.test(normalized)) {
    throw new GatewayRequestError(
      400,
      'Expected `port` to be `*` or an integer from 1 to 65535.',
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new GatewayRequestError(
      400,
      'Expected `port` to be `*` or an integer from 1 to 65535.',
    );
  }
  return parsed;
}

function parseApiAdminPolicyRuleInput(value: unknown): {
  action: 'allow' | 'deny';
  host: string;
  port: number | '*';
  methods: string[];
  paths: string[];
  agent: string;
  comment?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayRequestError(
      400,
      'Expected object `rule` in request body.',
    );
  }
  const raw = value as Record<string, unknown>;
  const rawAction = String(raw.action || '')
    .trim()
    .toLowerCase();
  if (rawAction !== 'allow' && rawAction !== 'deny') {
    throw new GatewayRequestError(
      400,
      'Expected `rule.action` to be `allow` or `deny`.',
    );
  }
  const host = normalizeOptionalString(raw.host);
  if (!host) {
    throw new GatewayRequestError(400, 'Expected non-empty `rule.host`.');
  }
  if (raw.agent != null && typeof raw.agent !== 'string') {
    throw new GatewayRequestError(
      400,
      'Expected `rule.agent` to be a string when provided.',
    );
  }
  if (raw.comment != null && typeof raw.comment !== 'string') {
    throw new GatewayRequestError(
      400,
      'Expected `rule.comment` to be a string when provided.',
    );
  }
  const agent = normalizeOptionalString(raw.agent) || '*';
  const comment = normalizeOptionalString(raw.comment);
  return {
    action: rawAction,
    host,
    port: parseApiAdminPolicyPort(raw.port),
    methods: parseApiAdminPolicyStringList(raw.methods, 'methods') || ['*'],
    paths: parseApiAdminPolicyStringList(raw.paths, 'paths') || ['/**'],
    agent,
    ...(comment ? { comment } : {}),
  };
}

function generateDefaultWebSessionId(agentId?: string | null): string {
  return buildSessionKey(
    String(agentId || '').trim() || resolveDefaultAgentId(getRuntimeConfig()),
    'web',
    'dm',
    randomUUID().replace(/-/g, '').slice(0, 16),
  );
}

async function resolveApiChatSlashCommandResult(
  chatRequest: GatewayChatRequest,
): Promise<GatewayChatResult | null> {
  const slashCommands = resolveTextChannelSlashCommands(chatRequest.content);
  if (!slashCommands) return null;

  const textParts: string[] = [];
  const artifacts: NonNullable<GatewayChatResult['artifacts']> = [];
  let pendingApproval:
    | NonNullable<GatewayChatResult['pendingApproval']>
    | undefined;
  let sessionId = chatRequest.sessionId;
  let sessionKey: string | undefined;
  let mainSessionKey: string | undefined;
  let handledApprovalCommand = false;
  let messageRole: GatewayChatResultMessageRole = 'command';

  for (const args of slashCommands) {
    if (parseLowerArg(args, 0) === 'approve') {
      const handled = await handleTextChannelApprovalCommand({
        sessionId,
        guildId: chatRequest.guildId,
        channelId: chatRequest.channelId,
        userId: chatRequest.userId,
        username: chatRequest.username,
        args,
      });
      if (!handled) continue;
      handledApprovalCommand = true;
      messageRole = handled.messageRole;
      sessionId = handled.sessionId || sessionId;
      sessionKey = handled.sessionKey || sessionKey;
      mainSessionKey = handled.mainSessionKey || mainSessionKey;
      if (handled.text?.trim()) {
        textParts.push(handled.text);
      }
      if (handled.artifacts.length > 0) {
        artifacts.push(...handled.artifacts);
      }
      if (handled.pendingApproval) {
        pendingApproval = handled.pendingApproval;
      }
      continue;
    }

    const gatewayCommandResult = await handleGatewayCommand({
      sessionId,
      sessionMode: chatRequest.sessionMode,
      guildId: chatRequest.guildId,
      channelId: chatRequest.channelId,
      args,
      userId: chatRequest.userId,
      username: chatRequest.username,
    });
    sessionId = gatewayCommandResult.sessionId || sessionId;
    sessionKey = gatewayCommandResult.sessionKey || sessionKey;
    mainSessionKey = gatewayCommandResult.mainSessionKey || mainSessionKey;
    const text = renderTextChannelCommandResult(gatewayCommandResult).trim();
    if (text) {
      textParts.push(text);
    }
  }

  const renderedText = textParts.join('\n\n').trim();
  if (!renderedText && !handledApprovalCommand) {
    logger.debug(
      {
        sessionId,
        channelId: chatRequest.channelId,
        slashCommands,
      },
      'Expanded web slash commands produced no visible output',
    );
  }

  const contextUsage = getGatewaySessionContextUsage(sessionId);
  const resolvedModel = contextUsage.snapshot?.model?.trim() || undefined;

  return {
    status: 'success',
    // A command with no visible output returns an empty result; the web console
    // renders nothing for it (like a shell command that succeeds silently)
    // rather than a "Done." block. Approvals keep an explicit confirmation.
    result:
      renderedText || (handledApprovalCommand ? 'Approval submitted.' : ''),
    toolsUsed: [],
    messageRole,
    sessionId,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(mainSessionKey ? { mainSessionKey } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(pendingApproval ? { pendingApproval } : {}),
  };
}

function resolveApiChatSecretCommandGuardResult(
  chatRequest: GatewayChatRequest,
): GatewayChatResult | null {
  const command = detectCliSecretSetCommand(chatRequest.content);
  if (!command) return null;
  return {
    status: 'success',
    result: renderCliSecretSetCommandWarning(command),
    toolsUsed: [],
    messageRole: 'command',
    sessionId: chatRequest.sessionId,
  };
}

async function resolveApiChatLocalCommandResult(
  chatRequest: GatewayChatRequest,
): Promise<GatewayChatResult | null> {
  return (
    resolveApiChatSecretCommandGuardResult(chatRequest) ||
    (await resolveApiChatSlashCommandResult(chatRequest))
  );
}

function isMalformedCanonicalSessionId(value: string | undefined): boolean {
  return (
    classifySessionKeyShape(String(value || '').trim()) ===
    'canonical_malformed'
  );
}

function isRuntimeDiscordChannelConfig(
  value: unknown,
): value is RuntimeDiscordChannelConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === 'off' || mode === 'mention' || mode === 'free';
}

function isRuntimeMSTeamsChannelConfig(
  value: unknown,
): value is RuntimeMSTeamsChannelConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const typed = value as {
    requireMention?: unknown;
    replyStyle?: unknown;
    groupPolicy?: unknown;
    allowFrom?: unknown;
    tools?: unknown;
  };
  if (
    typed.requireMention !== undefined &&
    typeof typed.requireMention !== 'boolean'
  ) {
    return false;
  }
  if (
    typed.replyStyle !== undefined &&
    typed.replyStyle !== 'thread' &&
    typed.replyStyle !== 'top-level'
  ) {
    return false;
  }
  if (
    typed.groupPolicy !== undefined &&
    typed.groupPolicy !== 'open' &&
    typed.groupPolicy !== 'allowlist' &&
    typed.groupPolicy !== 'disabled'
  ) {
    return false;
  }
  if (
    typed.allowFrom !== undefined &&
    !(
      Array.isArray(typed.allowFrom) &&
      typed.allowFrom.every((entry) => typeof entry === 'string')
    )
  ) {
    return false;
  }
  if (
    typed.tools !== undefined &&
    !(
      Array.isArray(typed.tools) &&
      typed.tools.every((entry) => typeof entry === 'string')
    )
  ) {
    return false;
  }
  return true;
}

function resolveQueryTokenAuthContext(url: URL): ResolvedAuthContext | null {
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return null;
  if (WEB_API_TOKEN && safeEqualToken(token, WEB_API_TOKEN)) {
    return { kind: 'master', payload: null };
  }
  if (GATEWAY_API_TOKEN && safeEqualToken(token, GATEWAY_API_TOKEN)) {
    return { kind: 'master', payload: null };
  }
  if (!isApiTokenString(token)) return null;
  const verified = verifyApiToken(token);
  if (!verified) return null;
  return {
    kind: 'apiToken',
    payload: verified.claims,
    tokenId: verified.id,
    tokenLabel: verified.label,
  };
}

function hasBearerToken(authHeader: string, token: string): boolean {
  return Boolean(token) && safeEqualToken(authHeader, `Bearer ${token}`);
}

function isLoopbackSocketAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  if (address.startsWith('::ffff:')) {
    const mappedAddress = address.slice('::ffff:'.length);
    return (
      mappedAddress === '127.0.0.1' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mappedAddress)
    );
  }
  if (address === '127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (!host) return false;
  if (host === 'localhost') return true;
  return isLoopbackSocketAddress(host);
}

function hasForwardingHeaders(req: IncomingMessage): boolean {
  return (
    req.headers.forwarded !== undefined ||
    req.headers['x-forwarded-for'] !== undefined ||
    req.headers['x-forwarded-host'] !== undefined ||
    req.headers['x-forwarded-proto'] !== undefined
  );
}

function extractHostnameFromHostHeader(
  value: string | string[] | undefined,
): string | null {
  const host = normalizeHeaderValue(value);
  if (!host) return null;
  if (host.startsWith('[')) {
    const endIndex = host.indexOf(']');
    if (endIndex === -1) return null;
    return host.slice(1, endIndex).trim().toLowerCase() || null;
  }
  const colonIndex = host.indexOf(':');
  return (colonIndex === -1 ? host : host.slice(0, colonIndex))
    .trim()
    .toLowerCase();
}

function isLocalWebSessionAllowed(req: IncomingMessage): boolean {
  return isLoopbackHost(HEALTH_HOST) && isLoopbackWebRequest(req);
}

function isLoopbackWebRequest(req: IncomingMessage): boolean {
  const requestHost = extractHostnameFromHostHeader(req.headers.host);
  return (
    isLoopbackSocketAddress(req.socket.remoteAddress) &&
    !hasForwardingHeaders(req) &&
    Boolean(requestHost && isLoopbackHost(requestHost))
  );
}

function requestUsesHttps(req: IncomingMessage): boolean {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto) return forwardedProto === 'https';
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

function hasSameGatewayOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return false;
  if (origin === resolveRequestOrigin(req)) return true;

  // Browsers set this header from the actual page/request relationship. It
  // keeps cookie-backed writes working behind TLS-terminating proxies even
  // when the backend cannot reconstruct the public origin exactly.
  return (
    String(req.headers['sec-fetch-site'] || '')
      .trim()
      .toLowerCase() === 'same-origin'
  );
}

type ResolvedAuthKind =
  | 'master'
  | 'apiToken'
  | 'session'
  | 'localSession'
  | 'none';

interface ResolvedAuthContext {
  kind: ResolvedAuthKind;
  payload: Record<string, unknown> | null;
  tokenId?: string;
  tokenLabel?: string;
}

interface ResolveAuthContextOptions {
  allowApiTokens?: boolean;
  allowLocalWebSession?: boolean;
  allowQueryToken?: boolean;
  allowSessionCookie?: boolean;
  requireSameOrigin?: boolean;
}

function extractBearerToken(req: IncomingMessage): string {
  const authHeader = normalizeHeaderValue(req.headers.authorization) || '';
  if (authHeader.length <= 'Bearer '.length) return '';
  if (authHeader.slice(0, 'Bearer'.length).toLowerCase() !== 'bearer') {
    return '';
  }
  const separator = authHeader.charAt('Bearer'.length);
  if (separator !== ' ' && separator !== '\t') return '';
  return authHeader.slice('Bearer'.length + 1).trim();
}

function resolveAuthContext(
  req: IncomingMessage,
  url?: URL,
  opts?: ResolveAuthContextOptions,
): ResolvedAuthContext {
  if (opts?.allowQueryToken && url) {
    const queryTokenAuth = resolveQueryTokenAuthContext(url);
    if (queryTokenAuth) return queryTokenAuth;
  }

  const authHeader = req.headers.authorization || '';
  const bearer = extractBearerToken(req);
  const hasWebBearer = hasBearerToken(authHeader, WEB_API_TOKEN);
  const hasGatewayBearer = hasBearerToken(authHeader, GATEWAY_API_TOKEN);
  const hasMasterBearer = hasWebBearer || hasGatewayBearer;
  if (opts?.allowApiTokens !== false && bearer && isApiTokenString(bearer)) {
    const verified = verifyApiToken(bearer);
    if (verified) {
      return {
        kind: 'apiToken',
        payload: verified.claims,
        tokenId: verified.id,
        tokenLabel: verified.label,
      };
    }
  }

  if (
    opts?.allowSessionCookie &&
    (!opts.requireSameOrigin || hasSameGatewayOrigin(req) || hasMasterBearer)
  ) {
    const sessionPayload = getSessionAuthPayload(req);
    if (sessionPayload) {
      return { kind: 'session', payload: sessionPayload };
    }
  }
  if (
    opts?.allowLocalWebSession &&
    isLocalWebSessionAllowed(req) &&
    hasLocalWebSessionAuth(req) &&
    (!opts.requireSameOrigin || hasSameGatewayOrigin(req))
  ) {
    return { kind: 'localSession', payload: null };
  }
  if (hasMasterBearer) {
    return { kind: 'master', payload: null };
  }
  return { kind: 'none', payload: null };
}

function hasGatewayApiAuth(req: IncomingMessage): boolean {
  const authHeader = req.headers.authorization || '';
  return hasBearerToken(authHeader, GATEWAY_API_TOKEN);
}

function hasApiTokenValue(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (WEB_API_TOKEN && safeEqualToken(trimmed, WEB_API_TOKEN)) return true;
  return (
    Boolean(GATEWAY_API_TOKEN) && safeEqualToken(trimmed, GATEWAY_API_TOKEN)
  );
}

function readRecordProperty(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function resolveAdminSessionActor(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  const value = readRecordProperty(payload, [
    'actor',
    'sub',
    'email',
    'userId',
    'user_id',
    'username',
  ]);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveAdminSessionAuditId(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  const value = readRecordProperty(payload, [
    'sessionId',
    'sid',
    'jti',
    'sub',
    'actor',
  ]);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveApiTokenActor(context: ResolvedAuthContext): string | null {
  if (context.kind !== 'apiToken' || !context.tokenId) return null;
  const label = context.tokenLabel?.trim();
  return label
    ? `apiToken:${context.tokenId}:${label}`
    : `apiToken:${context.tokenId}`;
}

function resolveAdminSecretAuditContext(
  req: IncomingMessage,
  authContext: ResolvedAuthContext,
): {
  sessionId?: string;
  actor?: string | null;
  sourceIp?: string | null;
} {
  const apiTokenActor = resolveApiTokenActor(authContext);
  return {
    sessionId:
      resolveAdminSessionAuditId(authContext.payload) ||
      apiTokenActor ||
      undefined,
    actor: apiTokenActor || resolveAdminSessionActor(authContext.payload),
    sourceIp: req.socket.remoteAddress || null,
  };
}

function shouldDeferAdminRbacToHandler(action: AdminRbacAction): boolean {
  return action.startsWith('secret.');
}

function isAdminRouteActionAllowed(
  authContext: ResolvedAuthContext,
  action: AdminRbacAction,
): boolean {
  return isAdminActionAllowed(authContext.payload, action);
}

function isAdminPath(pathname: string): boolean {
  return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

function hasFullApiTokenWildcard(context: ResolvedAuthContext): boolean {
  if (context.kind !== 'apiToken') return false;
  return collectAdminActionClaims(context.payload)?.has('*') === true;
}

function isApiTokenAllowedForRoute(
  context: ResolvedAuthContext,
  pathname: string,
  method: string,
): boolean {
  if (context.kind !== 'apiToken') return true;
  const action = resolveAdminRbacAction(pathname, method);
  if (!action) return hasFullApiTokenWildcard(context);
  return isAdminActionAllowed(context.payload, action);
}

function isApiTokenAllowedForApp(
  context: ResolvedAuthContext,
  appId: string,
): boolean {
  if (context.kind !== 'apiToken') return true;
  const appIds = context.payload?.appIds;
  if (!Array.isArray(appIds)) return false;
  return appIds.some(
    (entry) => typeof entry === 'string' && entry.trim() === appId,
  );
}

function enforceAdminRouteRbac(
  authContext: ResolvedAuthContext,
  res: ServerResponse,
  pathname: string,
  method: string,
): boolean {
  const action = resolveAdminRbacAction(pathname, method);
  if (authContext.kind === 'apiToken') {
    if (!action && hasFullApiTokenWildcard(authContext)) return true;
    if (!action) {
      sendJson(res, 403, { error: 'Forbidden.' });
      return false;
    }
    if (shouldDeferAdminRbacToHandler(action)) return true;
    if (isAdminRouteActionAllowed(authContext, action)) return true;
    sendJson(res, 403, { error: 'Forbidden.' });
    return false;
  }
  if (!isAdminPath(pathname)) return true;
  if (!action || shouldDeferAdminRbacToHandler(action)) return true;
  if (isAdminRouteActionAllowed(authContext, action)) return true;
  sendJson(res, 403, { error: 'Forbidden.' });
  return false;
}

function resolveApiMediaUploadQuotaKey(req: IncomingMessage): string {
  const authHeader = req.headers.authorization || '';
  if (hasBearerToken(authHeader, WEB_API_TOKEN)) {
    return 'web-token';
  }
  if (hasBearerToken(authHeader, GATEWAY_API_TOKEN)) {
    return 'gateway-token';
  }
  return 'authenticated';
}

function dispatchWebhookRoute(
  res: ServerResponse,
  handler: () => Promise<unknown>,
): void {
  void handler().catch((error) => {
    logger.error({ err: error }, 'Webhook handler failed');
    sendJson(res, 500, {
      error: 'Internal server error',
    });
  });
}

function sendText(res: ServerResponse, statusCode: number, text: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendRedirect(
  res: ServerResponse,
  statusCode: number,
  location: string,
): void {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    Location: location,
  });
  res.end();
}

function resolveLocalRedirectPath(value: string | null): string | undefined {
  if (!value?.startsWith('/') || value.startsWith('//')) return undefined;
  try {
    const base = new URL('http://hybridclaw.local');
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) return undefined;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return undefined;
  }
}

function escapeInlineScriptValue(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function cleanupExpiredMobileLaunchTokens(now = Date.now()): void {
  for (const [token, entry] of mobileLaunchTokens) {
    if (entry.expiresAt <= now) mobileLaunchTokens.delete(token);
  }
}

function evictOldestMobileLaunchTokens(): void {
  while (mobileLaunchTokens.size >= MOBILE_LAUNCH_TOKEN_MAX_ENTRIES) {
    const oldestToken = mobileLaunchTokens.keys().next().value;
    if (!oldestToken) return;
    mobileLaunchTokens.delete(oldestToken);
  }
}

function createMobileLaunchToken(params: {
  userId: string;
  sessionId: string;
  authPayload: Record<string, unknown>;
}): string {
  cleanupExpiredMobileLaunchTokens();
  evictOldestMobileLaunchTokens();
  const token = randomUUID();
  mobileLaunchTokens.set(token, {
    userId: params.userId,
    sessionId: params.sessionId,
    authPayload: params.authPayload,
    expiresAt: Date.now() + MOBILE_LAUNCH_TTL_MS,
  });
  return token;
}

function resolveMobileLaunchToken(token: string):
  | {
      userId: string;
      sessionId: string;
      authPayload: Record<string, unknown>;
    }
  | undefined {
  cleanupExpiredMobileLaunchTokens();
  const normalizedToken = token.trim();
  const entry = mobileLaunchTokens.get(normalizedToken);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    mobileLaunchTokens.delete(normalizedToken);
    return undefined;
  }
  mobileLaunchTokens.delete(normalizedToken);
  return {
    userId: entry.userId,
    sessionId: entry.sessionId,
    authPayload: entry.authPayload,
  };
}

function resolveRequestOrigin(
  req: IncomingMessage,
  bodyBaseUrl?: unknown,
): string {
  const explicitBaseUrl = normalizeHttpOrigin(bodyBaseUrl);
  if (explicitBaseUrl) return explicitBaseUrl;

  const configuredPublicUrl = normalizeHttpOrigin(deploymentPublicUrl);
  if (configuredPublicUrl) return configuredPublicUrl;

  const activeTunnelUrl = normalizeHttpOrigin(
    getGatewayAdminTunnelConfig().tunnel.publicUrl,
  );
  if (activeTunnelUrl) return activeTunnelUrl;

  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    ?.trim();
  const proto = requestUsesHttps(req) ? 'https' : 'http';
  const host = forwardedHost || req.headers.host || `127.0.0.1:${HEALTH_PORT}`;
  return `${proto}://${host}`;
}

function resolveA2AAgentCardOrigin(req: IncomingMessage): string | null {
  const configuredPublicUrl = deploymentPublicUrl.trim();
  if (configuredPublicUrl) {
    const origin = normalizeHttpOrigin(configuredPublicUrl);
    if (origin) return origin;
    logger.warn(
      { publicUrl: configuredPublicUrl },
      'Invalid deployment.public_url for A2A Agent Card',
    );
    return null;
  }
  return resolveRequestOrigin(req);
}

function buildMobileLaunchUrl(params: {
  origin: string;
  token: string;
}): string {
  const url = new URL('/chat/continue', params.origin);
  url.searchParams.set('token', params.token);
  return url.toString();
}

function resolveHybridAILoginUrl(): string | null {
  const baseUrl = HYBRIDAI_BASE_URL.trim().replace(/\/+$/, '');
  if (!baseUrl) return null;
  return `${baseUrl}${HYBRIDAI_LOGIN_PATH}`;
}

function isConsoleSpaPath(pathname: string): boolean {
  return (
    pathname === '/agents' ||
    pathname.startsWith('/agents/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/chat' ||
    pathname.startsWith('/chat/') ||
    pathname === '/apps' ||
    pathname.startsWith('/apps/')
  );
}

function resolveConsolePageTitle(pathname: string): string {
  if (pathname === '/chat' || pathname.startsWith('/chat/')) {
    return 'HybridClaw Chat';
  }

  if (pathname === '/apps' || pathname.startsWith('/apps/')) {
    return 'HybridClaw Apps';
  }

  if (pathname === '/agents' || pathname.startsWith('/agents/')) {
    return 'HybridClaw Agents';
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return 'HybridClaw Admin';
  }

  return 'HybridClaw';
}

function isLocalWebSurfacePath(pathname: string): boolean {
  return (
    isConsoleSpaPath(pathname) ||
    pathname === '/agents' ||
    pathname === '/agents.html'
  );
}

function requiresSessionAuth(pathname: string): boolean {
  if (!getSandboxAutoDetectionState().runningInsideContainer) {
    return false;
  }

  return (
    pathname === '/agents' ||
    pathname === '/agents.html' ||
    isConsoleSpaPath(pathname)
  );
}

function ensureSessionAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (hasSessionAuth(req)) return true;

  const loginUrl = resolveHybridAILoginUrl();
  if (!loginUrl) {
    sendText(
      res,
      401,
      'Unauthorized. Sign in via HybridAI before accessing the web console.',
    );
    return false;
  }

  sendRedirect(res, 302, loginUrl);
  return false;
}

function resolveSessionAuthenticatedUserId(
  req: IncomingMessage,
): string | undefined {
  const payload = getSessionAuthPayload(req);
  return normalizeOptionalString(payload?.sub);
}

function resolveGatewayRequestUserId(params: {
  req: IncomingMessage;
  channelId?: string | null;
  requestedUserId?: string | null;
  fallbackUserId?: string | null;
}): string | undefined {
  const channelId = String(params.channelId || '')
    .trim()
    .toLowerCase();
  if (channelId === 'web') {
    return (
      resolveSessionAuthenticatedUserId(params.req) ||
      normalizeOptionalString(params.requestedUserId) ||
      normalizeOptionalString(params.fallbackUserId)
    );
  }
  return (
    normalizeOptionalString(params.requestedUserId) ||
    normalizeOptionalString(params.fallbackUserId)
  );
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

async function resolvePathForContainmentCheck(
  filePath: string,
): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveDisplayPathAlias(
  rawPath: string,
  displayRoot: string,
  hostRoot: string,
): string | null {
  const normalized = rawPath.replace(/\\/g, '/').trim();
  const cleanDisplayRoot = displayRoot.replace(/\/+$/, '');
  if (
    normalized !== cleanDisplayRoot &&
    !normalized.startsWith(`${cleanDisplayRoot}/`)
  ) {
    return null;
  }

  const relative = path.posix
    .normalize(normalized.slice(cleanDisplayRoot.length).replace(/^\/+/, ''))
    .replace(/^\/+/, '');
  if (relative === '..' || relative.startsWith('../')) {
    return null;
  }
  return relative ? path.resolve(hostRoot, relative) : path.resolve(hostRoot);
}

function matchesDisplayPathAlias(
  rawPath: string,
  displayRoot: string,
): boolean {
  const normalized = rawPath.replace(/\\/g, '/').trim();
  const cleanDisplayRoot = displayRoot.replace(/\/+$/, '');
  return (
    normalized === cleanDisplayRoot ||
    normalized.startsWith(`${cleanDisplayRoot}/`)
  );
}

function getUploadedMediaCacheDirOrNull(): string | null {
  try {
    return resolveUploadedMediaCacheHostDir();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'uploaded_media_cache_dir_unavailable'
    ) {
      return null;
    }
    throw error;
  }
}

function resolveArtifactRequestPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const uploadedMediaCacheDir = getUploadedMediaCacheDirOrNull();
  if (matchesDisplayPathAlias(trimmed, UPLOADED_MEDIA_CACHE_ROOT_DISPLAY)) {
    if (!uploadedMediaCacheDir) {
      throw new GatewayRequestError(503, 'Uploaded media cache unavailable.');
    }
    return resolveDisplayPathAlias(
      trimmed,
      UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
      uploadedMediaCacheDir,
    );
  }
  return (
    resolveDisplayPathAlias(
      trimmed,
      DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
      DISCORD_MEDIA_CACHE_DIR,
    ) || path.resolve(trimmed)
  );
}

async function resolveValidatedApiChatMediaHostPath(
  rawPath: string,
): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (matchesDisplayPathAlias(trimmed, DISCORD_MEDIA_CACHE_ROOT_DISPLAY)) {
    const resolved = resolveDisplayPathAlias(
      trimmed,
      DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
      DISCORD_MEDIA_CACHE_DIR,
    );
    return resolved ? await resolvePathForContainmentCheck(resolved) : null;
  }

  const uploadedMediaCacheDir = getUploadedMediaCacheDirOrNull();
  if (matchesDisplayPathAlias(trimmed, UPLOADED_MEDIA_CACHE_ROOT_DISPLAY)) {
    if (!uploadedMediaCacheDir) {
      throw new GatewayRequestError(503, 'Uploaded media cache unavailable.');
    }
    const resolved = resolveDisplayPathAlias(
      trimmed,
      UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
      uploadedMediaCacheDir,
    );
    return resolved ? await resolvePathForContainmentCheck(resolved) : null;
  }

  if (!path.isAbsolute(trimmed)) {
    return null;
  }

  return resolvePathForContainmentCheck(trimmed);
}

async function isAllowedApiChatMediaHostPath(
  hostPath: string,
): Promise<boolean> {
  const uploadedMediaCacheDir = getUploadedMediaCacheDirOrNull();
  const [normalizedHostPath, discordMediaCacheDir, uploadedMediaCacheRoot] =
    await Promise.all([
      resolvePathForContainmentCheck(hostPath),
      resolvePathForContainmentCheck(DISCORD_MEDIA_CACHE_DIR),
      uploadedMediaCacheDir
        ? resolvePathForContainmentCheck(uploadedMediaCacheDir)
        : Promise.resolve(null),
    ]);

  if (isWithinRoot(normalizedHostPath, discordMediaCacheDir)) {
    return true;
  }

  if (!uploadedMediaCacheRoot) {
    return false;
  }
  return isWithinRoot(normalizedHostPath, uploadedMediaCacheRoot);
}

async function normalizeApiChatMediaItems(
  raw: unknown,
): Promise<MediaContextItem[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new GatewayRequestError(400, 'Invalid `media` in request body.');
  }
  if (raw.length === 0) return [];

  const normalized: MediaContextItem[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      throw new GatewayRequestError(400, `Invalid \`media[${index}]\` item.`);
    }
    const mediaItem = item as Record<string, unknown>;

    const pathValue = normalizeOptionalString(mediaItem.path);
    const url = normalizeOptionalString(mediaItem.url);
    const originalUrl = normalizeOptionalString(mediaItem.originalUrl);
    const filename = normalizeOptionalString(mediaItem.filename);
    if (!pathValue) {
      throw new GatewayRequestError(400, `Missing \`media[${index}].path\`.`);
    }
    if (!url) {
      throw new GatewayRequestError(400, `Missing \`media[${index}].url\`.`);
    }
    if (!originalUrl) {
      throw new GatewayRequestError(
        400,
        `Missing \`media[${index}].originalUrl\`.`,
      );
    }
    if (!filename) {
      throw new GatewayRequestError(
        400,
        `Missing \`media[${index}].filename\`.`,
      );
    }

    const resolvedHostPath =
      await resolveValidatedApiChatMediaHostPath(pathValue);
    if (
      !resolvedHostPath ||
      !(await isAllowedApiChatMediaHostPath(resolvedHostPath))
    ) {
      throw new GatewayRequestError(
        400,
        `Invalid \`media[${index}].path\`. Only uploaded or Discord media cache files are accepted.`,
      );
    }

    const rawSizeBytes = mediaItem.sizeBytes;
    if (rawSizeBytes != null && typeof rawSizeBytes !== 'number') {
      throw new GatewayRequestError(
        400,
        `Invalid \`media[${index}].sizeBytes\`.`,
      );
    }
    if (typeof rawSizeBytes === 'number' && !Number.isFinite(rawSizeBytes)) {
      throw new GatewayRequestError(
        400,
        `Invalid \`media[${index}].sizeBytes\`.`,
      );
    }

    const rawMimeType = mediaItem.mimeType;
    if (rawMimeType != null && typeof rawMimeType !== 'string') {
      throw new GatewayRequestError(
        400,
        `Invalid \`media[${index}].mimeType\`.`,
      );
    }

    normalized.push({
      path: pathValue,
      url,
      originalUrl,
      filename,
      sizeBytes:
        typeof rawSizeBytes === 'number'
          ? Math.max(0, Math.floor(rawSizeBytes))
          : 0,
      mimeType:
        typeof rawMimeType === 'string'
          ? normalizeMimeType(rawMimeType.trim())
          : null,
    });
  }
  return normalized;
}

async function resolveArtifactFile(url: URL): Promise<string | null> {
  const raw = (url.searchParams.get('path') || '').trim();
  if (!raw) return null;
  const resolved = resolveArtifactRequestPath(raw);
  if (!resolved) return null;
  const uploadedMediaCacheDir = getUploadedMediaCacheDirOrNull();
  let realFilePath: string;
  try {
    realFilePath = await fs.promises.realpath(resolved);
  } catch {
    return null;
  }
  const allowedRoots = [
    AGENT_ARTIFACT_ROOT,
    DISCORD_MEDIA_CACHE_DIR,
    ...(uploadedMediaCacheDir ? [uploadedMediaCacheDir] : []),
  ];
  const allowedRootPaths = await Promise.all(
    allowedRoots.map((root) => resolvePathForContainmentCheck(root)),
  );
  if (
    !allowedRootPaths.some((allowedRoot) =>
      isWithinRoot(realFilePath, allowedRoot),
    )
  ) {
    return null;
  }
  try {
    const stats = await fs.promises.stat(realFilePath);
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  return realFilePath;
}

function resolveAgentAvatarFile(url: URL): string | null {
  const agentId =
    (url.searchParams.get('agentId') || '').trim() || DEFAULT_AGENT_ID;
  const agent = getAgentById(agentId) ?? resolveAgentConfig(agentId);
  const imageAsset = String(agent.imageAsset || '').trim();
  return resolveWorkspaceRelativePath(agentWorkspaceDir(agentId), imageAsset, {
    requireExistingFile: false,
  });
}

function streamStaticFile(
  res: ServerResponse,
  filePath: string,
  options?: {
    cacheControl?: string;
    dispositionType?: 'inline' | 'attachment';
  },
): void {
  fs.stat(filePath, (statError, stats) => {
    if (statError) {
      const code = (statError as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        sendJson(res, 404, { error: 'Artifact not found.' });
        return;
      }
      logger.warn(
        { filePath, error: statError },
        'Failed to stat file before streaming',
      );
      sendJson(res, 500, { error: 'Failed to read artifact.' });
      return;
    }

    if (!stats.isFile()) {
      sendJson(res, 404, { error: 'Artifact not found.' });
      return;
    }

    const mimeType = resolveStaticFileMimeType(filePath, options);
    const dispositionType = options?.dispositionType || 'inline';
    const filename = path.basename(filePath);
    const stream = fs.createReadStream(filePath);

    stream.on('open', () => {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Disposition': `${dispositionType}; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': options?.cacheControl || 'no-store',
        'Content-Length': String(stats.size),
        'X-Content-Type-Options': 'nosniff',
        ...(dispositionType === 'attachment'
          ? {
              'Content-Security-Policy': "sandbox; default-src 'none'",
            }
          : {}),
      });
    });

    stream.on('data', (chunk) => {
      res.write(chunk);
    });

    stream.on('end', () => {
      if (!res.writableEnded) res.end();
    });

    stream.on('error', (error) => {
      logger.warn({ filePath, error }, 'Failed to stream file');
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Failed to read artifact.' });
        return;
      }
      if (typeof res.destroy === 'function') {
        res.destroy(error);
        return;
      }
      if (!res.writableEnded) res.end();
    });
  });
}

function resolveStaticFileMimeType(
  filePath: string,
  options?: {
    dispositionType?: 'inline' | 'attachment';
  },
): string {
  const ext = path.extname(filePath).toLowerCase();
  const siteMimeType =
    options?.dispositionType === 'attachment'
      ? null
      : SITE_MIME_TYPES[ext]?.split(';')[0]?.trim();
  const inlineMimeType = SAFE_INLINE_ARTIFACT_MIME_TYPES[ext] || siteMimeType;
  return inlineMimeType || 'application/octet-stream';
}

function normalizeHeaderValue(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) {
    return normalizeHeaderValue(value[0]);
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildMediaOnlyPromptContent(media: { filename: string }[]): string {
  if (media.length === 0) return '';
  const summary = summarizeMediaFilenames(media.map((item) => item.filename));
  return media.length === 1
    ? `Attached file: ${summary}`
    : `Attached files: ${summary}`;
}

function isAllowedMediaUploadMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('image/') ||
    ALLOWED_MEDIA_UPLOAD_MIME_TYPES.has(mimeType)
  );
}

function resolveSiteFile(pathname: string): string | null {
  return resolveStaticFile(
    SITE_DIR,
    pathname === '/' ? '/index.html' : pathname,
  );
}

function resolveStaticFile(rootDir: string, pathname: string): string | null {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(cleanPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = path.resolve(rootDir, `.${normalized}`);
  if (!candidate.startsWith(rootDir)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile())
    return null;
  return candidate;
}

function serveStatic(url: URL, res: ServerResponse): boolean {
  const pathname = url.pathname;
  if (serveDocs(url, res)) return true;
  const filePath = resolveSiteFile(
    pathname === '/agents'
      ? '/agents.html'
      : pathname === '/about' || pathname === '/about/'
        ? '/index.html'
        : pathname,
  );
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(fs.readFileSync(filePath));
  return true;
}

function serveConsoleFile(
  filePath: string | null,
  res: ServerResponse,
  options?: {
    title?: string;
  },
): boolean {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  const isIndex = filePath.endsWith('index.html');
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Cache-Control': isIndex
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Some browsers apply frame-ancestors to PDF blob previews created here.
    // X-Frame-Options keeps the console unframeable without blocking its blobs.
    'X-Frame-Options': 'DENY',
    ...(isIndex
      ? {
          'Content-Security-Policy':
            "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:",
        }
      : {}),
  });
  if (isIndex && options?.title) {
    const html = fs
      .readFileSync(filePath, 'utf-8')
      .replace(/<title>.*?<\/title>/, `<title>${options.title}</title>`);
    res.end(html);
    return true;
  }

  res.end(fs.readFileSync(filePath));
  return true;
}

function serveConsoleAsset(pathname: string, res: ServerResponse): boolean {
  return serveConsoleFile(resolveStaticFile(CONSOLE_DIST_DIR, pathname), res);
}

function serveConsoleIndex(pathname: string, res: ServerResponse): boolean {
  return serveConsoleFile(
    resolveStaticFile(CONSOLE_DIST_DIR, '/index.html'),
    res,
    {
      title: resolveConsolePageTitle(pathname),
    },
  );
}

async function handleApiChat(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<ApiChatRequestBody>;
  const wantsStream = body.stream === true;
  const media = await normalizeApiChatMediaItems(body.media);

  const content = body.content?.trim() || buildMediaOnlyPromptContent(media);
  if (!content) {
    sendJson(res, 400, {
      error: 'Missing `content` or `media` in request body.',
    });
    return;
  }

  const sessionId =
    normalizeOptionalString(body.sessionId) ||
    generateDefaultWebSessionId(body.agentId);
  if (isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }
  const channelId = body.channelId || 'web';
  const chatRequest: GatewayChatRequest = {
    sessionId,
    sessionMode:
      body.sessionMode === 'resume' || body.sessionMode === 'new'
        ? body.sessionMode
        : undefined,
    guildId: body.guildId ?? null,
    channelId,
    userId:
      resolveGatewayRequestUserId({
        req,
        channelId,
        requestedUserId: normalizeOptionalString(body.userId),
        fallbackUserId: sessionId,
      }) || sessionId,
    username: body.username ?? 'web',
    content,
    ...(media.length > 0 ? { media } : {}),
    agentId: body.agentId,
    chatbotId: body.chatbotId,
    enableRag: body.enableRag,
    model: body.model,
    ...(body.appBuild ? { appBuild: true } : {}),
    ...(typeof body.appCategory === 'string'
      ? { appCategory: body.appCategory }
      : {}),
    ...(body.appKind === 'live' || body.appKind === 'web'
      ? { appKind: body.appKind }
      : {}),
  };
  logger.debug(
    {
      sessionId: chatRequest.sessionId,
      channelId: chatRequest.channelId,
      guildId: chatRequest.guildId,
      model: chatRequest.model || null,
      stream: wantsStream,
      contentLength: chatRequest.content.length,
      mediaCount: media.length,
    },
    'Received gateway API chat request',
  );

  if (wantsStream) {
    await handleApiChatStream(req, res, chatRequest);
    return;
  }

  const processedResult =
    (await resolveApiChatLocalCommandResult(chatRequest)) ||
    normalizePendingApprovalReply(
      normalizePlaceholderToolReply(
        normalizeSilentMessageSendReply(
          await handleGatewayMessage(chatRequest),
        ),
      ),
    );
  const result = filterChatResultForSession(
    processedResult.sessionId || chatRequest.sessionId,
    processedResult,
  );
  const capturedApps = await maybeCaptureChatArtifacts(chatRequest, result);
  if (capturedApps.length > 0) result.apps = capturedApps;
  sendJson(res, result.status === 'success' ? 200 : 500, result);
}

async function handleApiChatBranch(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiChatBranchRequestBody;
  const sessionId = normalizeOptionalString(body.sessionId);
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` in request body.' });
    return;
  }
  if (isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }
  const beforeMessageId = parsePositiveInteger(body.beforeMessageId);
  if (beforeMessageId == null) {
    sendJson(res, 400, {
      error:
        'Missing valid positive integer `beforeMessageId` in request body.',
    });
    return;
  }

  try {
    const branch = memoryService.forkSessionBranch({
      sessionId,
      beforeMessageId,
    });
    sendJson(res, 200, {
      sessionId: branch.session.id,
      sessionKey: branch.session.session_key,
      mainSessionKey: branch.session.main_session_key,
      copiedMessageCount: branch.copiedMessageCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, /was not found/i.test(message) ? 404 : 500, {
      error: message,
    });
  }
}

async function handleApiChatRating(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    sessionId?: unknown;
    messageId?: unknown;
    userId?: unknown;
    rating?: unknown;
  };
  const sessionId = normalizeOptionalString(body.sessionId);
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` in request body.' });
    return;
  }
  if (isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }
  const messageId = parsePositiveInteger(body.messageId);
  if (messageId == null) {
    sendJson(res, 400, {
      error: 'Missing valid positive integer `messageId` in request body.',
    });
    return;
  }
  if (!Object.hasOwn(body, 'rating')) {
    sendJson(res, 400, { error: 'Missing `rating` in request body.' });
    return;
  }
  const rating =
    body.rating === 'up' || body.rating === 'down' ? body.rating : null;
  if (body.rating !== null && rating === null) {
    sendJson(res, 400, {
      error: '`rating` must be "up", "down", or null.',
    });
    return;
  }

  const operatorUserId =
    resolveGatewayRequestUserId({
      req,
      channelId: 'web',
      requestedUserId: normalizeOptionalString(body.userId),
      fallbackUserId: 'web',
    }) || 'web';

  try {
    const result = submitResponseRating({
      sessionId,
      messageId,
      operatorUserId,
      rating,
    });
    sendJson(res, 200, {
      sessionId: result.sessionId,
      messageId: result.messageId,
      rating: result.rating,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, error instanceof ResponseRatingNotFoundError ? 404 : 400, {
      error: message,
    });
  }
}

async function handleApiMediaUpload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const encodedFilename = normalizeHeaderValue(
    req.headers['x-hybridclaw-filename'],
  );
  if (!encodedFilename) {
    sendJson(res, 400, {
      error: 'Missing `X-Hybridclaw-Filename` header.',
    });
    return;
  }

  let decodedFilename = encodedFilename;
  try {
    decodedFilename = decodeURIComponent(encodedFilename);
  } catch {
    sendJson(res, 400, {
      error: 'Invalid `X-Hybridclaw-Filename` header.',
    });
    return;
  }

  const buffer = await readRequestBody(req, MAX_MEDIA_UPLOAD_BYTES);
  if (buffer.length === 0) {
    sendJson(res, 400, { error: 'Uploaded file is empty.' });
    return;
  }

  const mimeType =
    normalizeMimeType(normalizeHeaderValue(req.headers['content-type'])) ||
    'application/octet-stream';
  if (!isAllowedMediaUploadMimeType(mimeType)) {
    sendJson(res, 415, {
      error: `Unsupported media type: ${mimeType}.`,
    });
    return;
  }

  const quotaDecision = consumeGatewayMediaUploadQuota({
    key: resolveApiMediaUploadQuotaKey(req),
    bytes: buffer.length,
  });
  if (!quotaDecision.allowed) {
    res.setHeader(
      'Retry-After',
      String(Math.max(1, Math.ceil(quotaDecision.retryAfterMs / 1_000))),
    );
    sendJson(res, 429, {
      error: 'Media upload quota exceeded. Try again later.',
    });
    return;
  }

  let stored: Awaited<ReturnType<typeof writeUploadedMediaCacheFile>>;
  try {
    stored = await writeUploadedMediaCacheFile({
      attachmentName: decodedFilename,
      buffer,
      mimeType,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'uploaded_media_cache_dir_unavailable'
    ) {
      sendJson(res, 503, { error: 'Uploaded media cache unavailable.' });
      return;
    }
    throw error;
  }
  const artifactUrl = `/api/artifact?path=${encodeURIComponent(stored.runtimePath)}`;

  sendJson(res, 200, {
    media: {
      path: stored.runtimePath,
      url: artifactUrl,
      originalUrl: artifactUrl,
      mimeType,
      sizeBytes: buffer.length,
      filename: stored.filename,
    },
  });
}

async function handleApiChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  chatRequest: GatewayChatRequest,
): Promise<void> {
  const sendEvent = (payload: object): void => {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(payload)}\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const localCommandResult =
    await resolveApiChatLocalCommandResult(chatRequest);
  if (localCommandResult) {
    const filteredResult = filterChatResultForSession(
      localCommandResult.sessionId || chatRequest.sessionId,
      localCommandResult,
    );
    sendEvent({
      type: 'result',
      result: filteredResult,
    });
    res.end();
    return;
  }

  // Accumulate draft/thinking/tool events into an ordered trace, then persist it
  // against the assistant message so a reload can replay the same collapsed run
  // activity the live web chat rendered.
  const traceStartedAt = Date.now();
  const traceBuilder = new ActivityTraceBuilder();
  let streamedTextBeforeNextTool = '';

  const pushStreamedTextDraft = (): void => {
    traceBuilder.pushDraft(streamedTextBeforeNextTool);
    streamedTextBeforeNextTool = '';
  };

  const onToolProgress = (event: ToolProgressEvent): void => {
    if (event.phase === 'start') {
      pushStreamedTextDraft();
      traceBuilder.startTool(event.toolName, event.preview);
    } else {
      traceBuilder.finishTool(event.toolName, event.durationMs, event.preview);
    }
    sendEvent({
      type: 'tool',
      toolName: event.toolName,
      phase: event.phase,
      preview: event.preview,
      durationMs: event.durationMs,
    });
  };

  const streamFilter = createSilentReplyStreamFilter();
  const assistantBubblePresentation = {
    segmentKind: 'final' as const,
    visible: true,
    displaySurface: 'assistant_bubble' as const,
  };
  const onTextDelta = (delta: string): void => {
    const filteredDelta = streamFilter.push(delta);
    if (!filteredDelta) return;
    streamedTextBeforeNextTool += filteredDelta;
    sendEvent({
      type: 'text',
      delta: filteredDelta,
      outputPresentation: assistantBubblePresentation,
    });
  };
  const onThinkingDelta = (delta: string): void => {
    if (!delta) return;
    traceBuilder.pushThinking(delta);
    sendEvent({
      type: 'thinking',
      delta,
    });
  };
  let streamedApprovalId: string | null = null;
  const onApprovalProgress = (approval: PendingApproval): void => {
    streamedApprovalId = approval.approvalId;
    sendEvent({
      type: 'approval',
      ...approval,
      summary: formatGatewayChatApprovalSummary(approval),
    });
  };

  try {
    let result = normalizePlaceholderToolReply(
      normalizeSilentMessageSendReply(
        await handleGatewayMessage({
          ...chatRequest,
          onTextDelta,
          onThinkingDelta,
          onToolProgress,
          onApprovalProgress,
        }),
      ),
    );
    result = normalizePendingApprovalReply(result);
    if (result.status === 'success') {
      const bufferedDelta = streamFilter.flush();
      if (bufferedDelta) {
        sendEvent({
          type: 'text',
          delta: bufferedDelta,
          outputPresentation: assistantBubblePresentation,
        });
      }
      if (streamFilter.isSilent() && hasMessageSendToolExecution(result)) {
        result = {
          ...result,
          result: 'Message sent.',
        };
      }
    }
    const filteredResult = filterChatResultForSession(
      result.sessionId || chatRequest.sessionId,
      result,
    );
    const pendingApproval = extractGatewayChatApprovalEvent(filteredResult);
    if (pendingApproval && pendingApproval.approvalId !== streamedApprovalId) {
      sendEvent(pendingApproval);
    }
    const capturedApps = await maybeCaptureChatArtifacts(
      chatRequest,
      filteredResult,
    );
    if (capturedApps.length > 0) filteredResult.apps = capturedApps;
    traceBuilder.setRouting(filteredResult.routing);
    sendEvent({
      type: 'result',
      result: filteredResult,
    });
    // Best-effort: persistence failure must never corrupt the already-sent
    // response, so it is swallowed after logging.
    const assistantMessageId = result.assistantMessageId;
    if (typeof assistantMessageId === 'number' && !traceBuilder.isEmpty()) {
      const trace = traceBuilder.build(Date.now() - traceStartedAt);
      if (trace) {
        try {
          // Tool arg/result previews and thinking text are now stored at rest;
          // redact any secrets echoed in them before they land in SQLite.
          setMessageActivityTrace(assistantMessageId, redactSecretsDeep(trace));
        } catch (traceError) {
          logger.warn(
            { error: traceError, sessionId: chatRequest.sessionId },
            'Failed to persist chat activity trace',
          );
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendEvent({
      type: 'result',
      result: {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: errorMessage,
      },
    });
    logger.error(
      { error, reqUrl: '/api/chat' },
      'Gateway streaming chat failed',
    );
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }

  req.on('close', () => {
    if (!res.writableEnded) {
      res.end();
    }
  });
}

async function handleApiCommand(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<GatewayCommandRequest>;
  const sessionId = normalizeOptionalString(body.sessionId);
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` in request body.' });
    return;
  }
  if (isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }
  const args = Array.isArray(body.args)
    ? body.args.map((value) => String(value))
    : [];
  if (args.length === 0) {
    sendJson(res, 400, {
      error: 'Missing command. Provide non-empty `args` array.',
    });
    return;
  }

  const commandRequest: GatewayCommandRequest = {
    sessionId,
    sessionMode:
      body.sessionMode === 'resume' || body.sessionMode === 'new'
        ? body.sessionMode
        : undefined,
    guildId: body.guildId ?? null,
    channelId: body.channelId || 'web',
    args,
    userId:
      resolveGatewayRequestUserId({
        req,
        channelId: body.channelId || 'web',
        requestedUserId: normalizeOptionalString(body.userId),
        fallbackUserId: sessionId,
      }) || sessionId,
    username: body.username ?? null,
  };
  const result = await handleGatewayCommand(commandRequest);
  sendJson(res, result.kind === 'error' ? 400 : 200, result);
}

async function handleApiMessageAction(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiMessageActionRequestBody;
  const action =
    typeof body.action === 'string'
      ? normalizeDiscordToolAction(body.action)
      : null;
  if (!action) {
    sendJson(res, 400, {
      error:
        'Invalid `action`. Allowed: "read", "member-info", "channel-info", "send", "react", "quote-reply", "edit", "delete", "pin", "unpin", "thread-create", "thread-reply".',
    });
    return;
  }

  let cc: string[] | undefined;
  let bcc: string[] | undefined;
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  try {
    cc = parseEmailRecipientListInput(body.cc, 'cc');
    bcc = parseEmailRecipientListInput(body.bcc, 'bcc');
    inReplyTo = parseOptionalStringInput(body.inReplyTo, 'inReplyTo');
    references = parseThreadReferenceListInput(body.references);
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const request: DiscordToolActionRequest = {
    action,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
    guildId: typeof body.guildId === 'string' ? body.guildId : undefined,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    memberId: typeof body.memberId === 'string' ? body.memberId : undefined,
    username: typeof body.username === 'string' ? body.username : undefined,
    user: typeof body.user === 'string' ? body.user : undefined,
    resolveAmbiguous:
      body.resolveAmbiguous === 'best' || body.resolveAmbiguous === 'error'
        ? body.resolveAmbiguous
        : undefined,
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    before: typeof body.before === 'string' ? body.before : undefined,
    after: typeof body.after === 'string' ? body.after : undefined,
    around: typeof body.around === 'string' ? body.around : undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    subject: typeof body.subject === 'string' ? body.subject : undefined,
    cc,
    bcc,
    inReplyTo,
    references,
    filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
    components:
      Array.isArray(body.components) ||
      (body.components !== null && typeof body.components === 'object')
        ? body.components
        : undefined,
    contextChannelId:
      typeof body.contextChannelId === 'string'
        ? body.contextChannelId
        : undefined,
    messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
    emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    autoArchiveDuration:
      typeof body.autoArchiveDuration === 'number'
        ? body.autoArchiveDuration
        : undefined,
  };

  const result = await runMessageToolAction(request);
  sendJson(res, 200, result);
}

async function handleApiPluginTool(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiPluginToolRequestBody;
  const toolName =
    typeof body.toolName === 'string' ? body.toolName.trim() : '';
  if (!toolName) {
    sendJson(res, 400, { error: 'Missing `toolName` in request body.' });
    return;
  }
  const args =
    body.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};
  try {
    const result = await runGatewayPluginTool({
      toolName,
      args,
      sessionId:
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
      channelId:
        typeof body.channelId === 'string' ? body.channelId : undefined,
    });
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    throw new GatewayRequestError(
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleApiHistory(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` query parameter.' });
    return;
  }
  if (isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }
  const parsedLimit = parseInt(url.searchParams.get('limit') || '40', 10);
  const parsedSummarySinceMs = parseInt(
    url.searchParams.get('summarySinceMs') || '',
    10,
  );
  const limit = Number.isNaN(parsedLimit) ? 40 : parsedLimit;
  const rawAgentId = url.searchParams.get('agentId')?.trim() || '';
  if (rawAgentId && !HISTORY_AGENT_ID_PATTERN.test(rawAgentId)) {
    sendJson(res, 400, { error: 'Invalid `agentId` query parameter.' });
    return;
  }
  const requestedAgentId = rawAgentId || undefined;
  if (requestedAgentId && !getAgentById(requestedAgentId)) {
    sendJson(res, 404, { error: 'Agent not found.' });
    return;
  }
  const operatorUserId = resolveGatewayRequestUserId({
    req,
    channelId: 'web',
    requestedUserId: url.searchParams.get('userId'),
    fallbackUserId: 'web',
  });
  void ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: operatorUserId,
    username: operatorUserId,
    agentId: requestedAgentId,
  }).catch((error) => {
    logger.warn(
      { sessionId, agentId: requestedAgentId ?? null, error },
      'Failed to start gateway bootstrap autostart',
    );
  });
  const historyPage = getGatewayHistory(sessionId, limit, {
    operatorUserId,
  });
  const summary = getGatewayHistorySummary(sessionId, {
    sinceMs: Number.isNaN(parsedSummarySinceMs) ? null : parsedSummarySinceMs,
  });
  const bootstrapAutostart = getGatewayBootstrapAutostartState({
    sessionId,
    channelId: 'web',
    agentId: requestedAgentId,
    allowExistingSessionMessages: true,
  });
  // These keys are returned only as chat-routing metadata for the web client.
  // Auth stays anchored to the existing API/session auth checks above, never to
  // sessionKey/mainSessionKey. If these fields ever become auth-sensitive,
  // remove them from this response instead of widening their meaning here.
  sendJson(res, 200, {
    sessionId: historyPage.sessionId,
    agentId: historyPage.agentId || undefined,
    sessionKey: historyPage.sessionKey || undefined,
    mainSessionKey: historyPage.mainSessionKey || undefined,
    history: historyPage.history,
    bootstrapAutostart,
    ...(historyPage.branchFamilies.length > 0
      ? { branchFamilies: historyPage.branchFamilies }
      : {}),
    summary,
  });
}

function handleApiAgentAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const authContext = resolveAuthContext(req, url, {
    allowLocalWebSession: true,
    allowSessionCookie: true,
  });
  if (authContext.kind === 'none') {
    sendJson(res, 401, {
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
    return;
  }
  if (
    !isApiTokenAllowedForRoute(authContext, url.pathname, req.method || 'GET')
  ) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  const filePath = resolveAgentAvatarFile(url);
  if (!filePath) {
    sendJson(res, 404, { error: 'Agent avatar not found.' });
    return;
  }
  if (
    !resolveStaticFileMimeType(filePath, {
      dispositionType: 'inline',
    }).startsWith('image/')
  ) {
    sendJson(res, 404, { error: 'Agent avatar not found.' });
    return;
  }
  streamStaticFile(res, filePath, {
    cacheControl: 'private, max-age=300',
    dispositionType: 'inline',
  });
}

function handleApiChatRecent(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const channelId = (url.searchParams.get('channelId') || 'web').trim();
  const query = normalizeRecentChatSearchQuery(url.searchParams.get('q'));
  const rawScope = (url.searchParams.get('scope') || '').trim().toLowerCase();
  const scope =
    rawScope === 'user' || rawScope === 'all' ? rawScope : undefined;
  const hasWebSessionUser =
    channelId.toLowerCase() === 'web' &&
    Boolean(resolveSessionAuthenticatedUserId(req));
  const userId = resolveGatewayRequestUserId({
    req,
    channelId,
    requestedUserId: url.searchParams.get('userId'),
  });
  if (!userId) {
    sendJson(res, 400, { error: 'Missing `userId` query parameter.' });
    return;
  }
  const parsedLimit = parseInt(url.searchParams.get('limit') || '10', 10);
  const limit = normalizeRecentChatSessionLimit(
    Number.isNaN(parsedLimit) ? undefined : parsedLimit,
  );
  sendJson(res, 200, {
    sessions: getGatewayRecentChatSessions({
      userId,
      channelId,
      limit,
      ...(query ? { query } : {}),
      ...(scope ? { includeScheduled: scope === 'all' } : {}),
      ...(scope === 'all' ||
      (!scope && channelId.toLowerCase() === 'web' && !hasWebSessionUser)
        ? { fallbackToChannelRecent: true }
        : {}),
    }),
  });
}

function handleApiChatCleanup(res: ServerResponse, url: URL): void {
  sendJson(
    res,
    200,
    cleanupGatewayNoUserChatSessions({
      channelId: url.searchParams.get('channelId') || 'web',
      keepSessionId: url.searchParams.get('keepSessionId'),
    }),
  );
}

async function handleApiChatMobileQr(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiChatMobileQrRequestBody;
  const userId = normalizeOptionalString(body.userId);
  const sessionId = normalizeOptionalString(body.sessionId);
  if (!userId) {
    sendJson(res, 400, { error: 'Missing `userId` in request body.' });
    return;
  }
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` in request body.' });
    return;
  }
  if (isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }

  const redirectPath = `/chat/${encodeURIComponent(sessionId)}`;
  const mobileSessionCookieRequired =
    requiresSessionAuth(redirectPath) || Boolean(WEB_API_TOKEN);
  if (mobileSessionCookieRequired && !hasSharedAuthSecret()) {
    sendJson(res, 500, {
      error:
        'Mobile launch QR code cannot establish a web session because HybridClaw auth secret is not configured.',
    });
    return;
  }

  const token = createMobileLaunchToken({
    userId,
    sessionId,
    authPayload: getSessionAuthPayload(req) ?? { sub: userId },
  });
  const launchUrl = buildMobileLaunchUrl({
    origin: resolveRequestOrigin(req, body.baseUrl),
    token,
  });
  sendJson(res, 200, {
    launchUrl,
    expiresAt: new Date(Date.now() + MOBILE_LAUNCH_TTL_MS).toISOString(),
    qrSvg: renderQrSvg(launchUrl),
  });
}

function handleChatMobileContinue(res: ServerResponse, url: URL): void {
  const token = normalizeOptionalString(url.searchParams.get('token'));
  const launch = token ? resolveMobileLaunchToken(token) : undefined;
  if (!launch) {
    sendText(res, 401, 'Mobile launch QR code is invalid or expired.');
    return;
  }

  const escapedUserId = escapeInlineScriptValue(launch.userId);
  const escapedSessionId = escapeInlineScriptValue(launch.sessionId);
  const redirectPath = `/chat/${encodeURIComponent(launch.sessionId)}`;
  const mobileSessionCookieRequired =
    requiresSessionAuth(redirectPath) || Boolean(WEB_API_TOKEN);
  try {
    setSessionCookie(res, launch.authPayload);
  } catch (err) {
    logger.warn({ err }, 'Failed to establish mobile launch web session');
    // WEB_API_TOKEN means mobile has no bearer-token path, so the session
    // cookie is required.
    if (mobileSessionCookieRequired) {
      sendText(
        res,
        500,
        'Mobile launch QR code could not establish a web session.',
      );
      return;
    }
  }
  const escapedRedirect = escapeInlineScriptValue(redirectPath);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(
    `<!DOCTYPE html><html><body><script>` +
      `localStorage.setItem('hybridclaw_user_id',${escapedUserId});` +
      `localStorage.setItem('hybridclaw_session',${escapedSessionId});` +
      `window.location.replace(${escapedRedirect});` +
      `</script></body></html>`,
  );
}

let cachedSlashMenuEntries: ReturnType<typeof buildTuiSlashMenuEntries> | null =
  null;
let cachedSlashMenuPluginKey = '';

function getSlashMenuEntries(): ReturnType<typeof buildTuiSlashMenuEntries> {
  const pluginCommands = listLoadedPluginCommands();
  const pluginKey = pluginCommands
    .map((c) => `${c.name}\x01${c.description}`)
    .join('\0');
  if (cachedSlashMenuEntries && pluginKey === cachedSlashMenuPluginKey) {
    return cachedSlashMenuEntries;
  }
  cachedSlashMenuEntries = buildTuiSlashMenuEntries(
    pluginCommands.map((command) => ({
      name: command.name,
      description: command.description,
    })),
    'web',
  );
  cachedSlashMenuPluginKey = pluginKey;
  return cachedSlashMenuEntries;
}

function handleApiChatContext(res: ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` query parameter.' });
    return;
  }
  if (isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }
  const result = getGatewaySessionContextUsage(sessionId);
  if (result.status === 'not_found' || !result.snapshot) {
    sendJson(res, 200, { sessionId, snapshot: null });
    return;
  }
  sendJson(res, 200, {
    sessionId: result.sessionId,
    snapshot: result.snapshot,
  });
}

function handleApiChatCommands(res: ServerResponse, url: URL): void {
  const query = (url.searchParams.get('q') ?? '').slice(0, 200);
  const ranked = rankTuiSlashMenuEntries(getSlashMenuEntries(), query);
  sendJson(res, 200, {
    commands: ranked.map((entry) => ({
      id: entry.id,
      label: entry.label,
      insertText: entry.insertText,
      description: entry.description,
      depth: entry.depth,
    })),
  });
}

async function handleApiAgents(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getGatewayAgents());
}

async function handleApiAgentList(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getGatewayAgentList());
}

function handleApiAdminJobsContext(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAdminJobsContext());
}

function parseJobBudgetAgentIds(url: URL): string[] | undefined {
  const values = url.searchParams
    .getAll('agentId')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function handleApiAdminJobsBudgets(res: ServerResponse, url: URL): void {
  sendJson(
    res,
    200,
    getBoardBudgetSummaries({
      agentIds: parseJobBudgetAgentIds(url),
    }),
  );
}

function normalizeBoardEdgeKind(value: unknown): BoardCardEdgeKind | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (
    normalized === 'blocks' ||
    normalized === 'blocked_by' ||
    normalized === 'related'
  ) {
    return normalized;
  }
  throw new GatewayRequestError(400, 'Invalid board edge kind.');
}

function normalizeBoardCardId(value: unknown, field: string): string {
  if (value == null)
    throw new GatewayRequestError(400, `Missing \`${field}\`.`);
  if (typeof value !== 'string') {
    throw new GatewayRequestError(400, `\`${field}\` must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) throw new GatewayRequestError(400, `Missing \`${field}\`.`);
  return normalized;
}

function normalizeBoardRevisionId(value: unknown): number {
  if (value == null) {
    throw new GatewayRequestError(400, 'Missing `revisionId`.');
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new GatewayRequestError(
      400,
      '`revisionId` must be a positive integer.',
    );
  }
  return value;
}

function normalizeBoardActorField(
  record: Record<string, unknown>,
  field: 'system' | 'userId' | 'agentId' | 'type' | 'id',
): string {
  const value = record[field];
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new GatewayRequestError(400, `\`actor.${field}\` must be a string.`);
  }
  return value.trim();
}

function normalizeBoardEdgeActor(
  value: unknown,
): BoardCardActorInput | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayRequestError(400, '`actor` must be an object.');
  }
  const record = value as Record<string, unknown>;
  const system = normalizeBoardActorField(record, 'system');
  const userId = normalizeBoardActorField(record, 'userId');
  const agentId = normalizeBoardActorField(record, 'agentId');
  const type = normalizeBoardActorField(record, 'type');
  const id = normalizeBoardActorField(record, 'id');
  const hasTypedActor = Boolean(type || id);
  const actorCount =
    [system, userId, agentId].filter(Boolean).length + (hasTypedActor ? 1 : 0);
  if (actorCount !== 1) {
    throw new GatewayRequestError(
      400,
      '`actor` must contain exactly one of system, userId, agentId, or type/id.',
    );
  }
  if (system) {
    if (system !== 'gateway') {
      throw new GatewayRequestError(400, '`actor.system` must be gateway.');
    }
    return { system };
  }
  if (userId) {
    logger.warn(
      'Deprecated board actor shape `userId` used; send `{ type: "user", id }` instead',
    );
    return { userId };
  }
  if (agentId) {
    logger.warn(
      'Deprecated board actor shape `agentId` used; send `{ type: "agent", id }` instead',
    );
    return { agentId };
  }
  if (type !== 'user' && type !== 'agent') {
    throw new GatewayRequestError(400, '`actor.type` must be user or agent.');
  }
  if (!id) {
    throw new GatewayRequestError(400, '`actor.id` is required.');
  }
  return { type, id };
}

function extractBoardEdgeContext(
  body: Record<string, unknown>,
): BoardCardMutationContext {
  return {
    actor: normalizeBoardEdgeActor(body.actor),
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    runId: typeof body.runId === 'string' ? body.runId : null,
  };
}

async function handleApiAdminJobsEdges(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method === 'GET') {
    const cardId = normalizeBoardCardId(
      url.searchParams.get('cardId'),
      'cardId',
    );
    const kind = normalizeBoardEdgeKind(url.searchParams.get('kind'));
    sendJson(res, 200, { edges: listEdges(cardId, kind) });
    return;
  }

  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const fromCardId = normalizeBoardCardId(body.fromCardId, 'fromCardId');
    const toCardId = normalizeBoardCardId(body.toCardId, 'toCardId');
    const kind = normalizeBoardEdgeKind(body.kind);
    if (!kind) throw new GatewayRequestError(400, 'Missing `kind`.');
    sendJson(res, 200, {
      edge: addEdge(fromCardId, toCardId, kind, extractBoardEdgeContext(body)),
    });
    return;
  }

  if (req.method === 'DELETE') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const id = normalizeBoardCardId(url.searchParams.get('id'), 'id');
    sendJson(res, 200, {
      edge: removeEdge(id, extractBoardEdgeContext(body)),
    });
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
}

async function handleApiAdminJobsEdgeRevisions(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method === 'GET') {
    const id = normalizeBoardCardId(url.searchParams.get('id'), 'id');
    sendJson(res, 200, { revisions: listEdgeRevisions(id) });
    return;
  }

  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const id = normalizeBoardCardId(body.id, 'id');
    const revisionId = normalizeBoardRevisionId(body.revisionId);
    sendJson(res, 200, {
      edge: restoreEdgeRevision(id, revisionId, extractBoardEdgeContext(body)),
    });
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
}

function handleApiAdminJobsBlocked(res: ServerResponse, url: URL): void {
  const cardId = normalizeBoardCardId(url.searchParams.get('cardId'), 'cardId');
  sendJson(res, 200, { cardId, blocked: isBlocked(cardId) });
}

function handleApiProactivePull(res: ServerResponse, url: URL): void {
  const channelId = (url.searchParams.get('channelId') || '').trim();
  if (!channelId) {
    sendJson(res, 400, { error: 'Missing `channelId` query parameter.' });
    return;
  }
  const parsedLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;
  const messages = claimQueuedProactiveMessages(channelId, limit).filter(
    (message) => !shouldSuppressProactiveMessage(message),
  );
  sendJson(res, 200, { channelId, messages });
}

function handleApiShutdown(res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    message: 'Gateway shutdown requested.',
  });
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 50);
}

function handleApiRestart(res: ServerResponse): void {
  const restart = requestGatewayRestart();
  if (!restart.restartSupported) {
    sendJson(res, 409, {
      error:
        restart.restartReason || 'Gateway restart is unavailable right now.',
    });
    return;
  }

  sendJson(res, 200, {
    status: 'ok',
    message: 'Gateway restart requested.',
  });
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 50);
}

function handleApiConfigReload(res: ServerResponse): void {
  try {
    refreshRuntimeSecretsFromEnv();
    reloadRuntimeConfig('admin-api');
    syncLoggerLevelFromRuntimeConfig('admin-api');
  } catch (error) {
    sendJson(res, 500, {
      error:
        error instanceof Error
          ? error.message
          : 'Gateway reload failed unexpectedly.',
    });
    return;
  }

  sendJson(res, 200, {
    status: 'ok',
    message: 'Gateway reloaded.',
  });
}

async function handleApiAdminLogs(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    sendJson(
      res,
      200,
      await getGatewayAdminLogs({
        fileId: url.searchParams.get('file'),
        tailBytes: url.searchParams.get('tailBytes'),
      }),
    );
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApiAdminOverview(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getGatewayAdminOverview());
}

function handleApiAdminSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  authContext: ResolvedAuthContext,
): void {
  if (!isAdminActionAllowed(authContext.payload, 'secret.list_metadata')) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  sendJson(
    res,
    200,
    getGatewayAdminSecrets({
      audit: resolveAdminSecretAuditContext(req, authContext),
      sessionPayload: authContext.payload,
    }),
  );
}

function parseApiAdminSecretName(pathname: string): string | null {
  const prefix = '/api/admin/secrets/';
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new GatewayRequestError(400, 'Invalid secret name in request path.');
  }
}

function readAdminSecretBodyValue(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return (body as { value?: unknown }).value;
  }
  return undefined;
}

function parseApiAdminTokenId(pathname: string): string | null {
  const prefix = '/api/admin/tokens/';
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new GatewayRequestError(400, 'Invalid token id in request path.');
  }
}

function resolveAdminTokenAuditContext(
  req: IncomingMessage,
  authContext: ResolvedAuthContext,
): {
  sessionId?: string;
  actor?: string | null;
  sourceIp?: string | null;
} {
  const apiTokenActor = resolveApiTokenActor(authContext);
  return {
    sessionId:
      resolveAdminSessionAuditId(authContext.payload) ||
      apiTokenActor ||
      undefined,
    actor: apiTokenActor || resolveAdminSessionActor(authContext.payload),
    sourceIp: req.socket.remoteAddress || null,
  };
}

function handleApiAdminTokens(
  res: ServerResponse,
  authContext: ResolvedAuthContext,
): void {
  if (!isAdminActionAllowed(authContext.payload, 'admin.tokens.read')) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  sendJson(
    res,
    200,
    getGatewayAdminTokens({
      authPayload: authContext.payload,
    }),
  );
}

async function handleApiAdminTokenCreate(
  req: IncomingMessage,
  res: ServerResponse,
  authContext: ResolvedAuthContext,
): Promise<void> {
  if (authContext.kind === 'apiToken') {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  if (!isAdminActionAllowed(authContext.payload, 'admin.tokens.create')) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  const body = await readJsonBody(req);
  sendJson(
    res,
    201,
    createGatewayAdminToken({
      body,
      audit: resolveAdminTokenAuditContext(req, authContext),
    }),
  );
}

function handleApiAdminTokenRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  authContext: ResolvedAuthContext,
): void {
  if (authContext.kind === 'apiToken') {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  if (!isAdminActionAllowed(authContext.payload, 'admin.tokens.revoke')) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  sendJson(
    res,
    200,
    revokeGatewayAdminToken({
      id,
      audit: resolveAdminTokenAuditContext(req, authContext),
    }),
  );
}

async function handleApiAdminSecretOverwrite(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  authContext: ResolvedAuthContext,
): Promise<void> {
  const audit = resolveAdminSecretAuditContext(req, authContext);
  if (!isAdminActionAllowed(authContext.payload, 'secret.overwrite')) {
    recordGatewayAdminSecretMutationFailure({
      type: 'secret.overwritten',
      name,
      audit,
      errorCode: 'forbidden',
    });
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    recordGatewayAdminSecretMutationFailure({
      type: 'secret.overwritten',
      name,
      audit,
      errorCode:
        error instanceof GatewayRequestError ? 'bad_request' : 'write_failed',
    });
    throw error;
  }
  const result = overwriteGatewayAdminSecret({
    name,
    value: readAdminSecretBodyValue(body),
    audit,
  });
  refreshRuntimeSecretsFromEnv();
  sendJson(res, 200, result);
}

async function handleApiAdminSecretUnset(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  authContext: ResolvedAuthContext,
): Promise<void> {
  const audit = resolveAdminSecretAuditContext(req, authContext);
  if (!isAdminActionAllowed(authContext.payload, 'secret.unset')) {
    recordGatewayAdminSecretMutationFailure({
      type: 'secret.unset',
      name,
      audit,
      errorCode: 'forbidden',
    });
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  const result = unsetGatewayAdminSecret({ name, audit });
  refreshRuntimeSecretsFromEnv();
  sendJson(res, 200, result);
}

function recordUnauthenticatedAdminSecretMutation(
  req: IncomingMessage,
  pathname: string,
  method: string,
): void {
  if (method !== 'PUT' && method !== 'DELETE') return;
  let name: string | null = null;
  try {
    name = parseApiAdminSecretName(pathname);
  } catch {
    return;
  }
  if (name === null) return;
  recordGatewayAdminSecretMutationFailure({
    type: method === 'PUT' ? 'secret.overwritten' : 'secret.unset',
    name,
    audit: {
      sourceIp: req.socket.remoteAddress || null,
    },
    errorCode: 'unauthorized',
  });
}

async function handleApiAdminTunnelReconnect(
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, { tunnel: await reconnectGatewayAdminTunnel() });
}

async function handleApiAdminTunnelStop(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { tunnel: await stopGatewayAdminTunnel() });
}

async function handleApiAdminTunnelConfig(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminTunnelConfig());
    return;
  }

  const body = await readJsonBody(req);
  sendJson(res, 200, saveGatewayAdminTunnelConfig(body));
}

function handleApiAdminStatistics(res: ServerResponse, url: URL): void {
  const daysRaw = url.searchParams.get('days') ?? undefined;
  sendJson(res, 200, getGatewayAdminStatistics({ days: daysRaw }));
}

async function handleApiAdminEmail(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getGatewayAdminEmailMailbox());
}

async function handleApiAdminEmailFolder(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const folder = url.searchParams.get('folder')?.trim() || '';
  if (!folder) {
    sendJson(res, 400, { error: '`folder` is required.' });
    return;
  }

  const limitRaw = url.searchParams.get('limit')?.trim() || '';
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if (
    limitRaw &&
    (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
  ) {
    sendJson(res, 400, { error: '`limit` must be a positive integer.' });
    return;
  }

  const offsetRaw = url.searchParams.get('offset')?.trim() || '';
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined;
  if (
    offsetRaw &&
    (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0)
  ) {
    sendJson(res, 400, { error: '`offset` must be a non-negative integer.' });
    return;
  }

  sendJson(
    res,
    200,
    await getGatewayAdminEmailFolder({
      folder,
      ...(typeof limit === 'number' ? { limit } : {}),
      ...(typeof offset === 'number' ? { offset } : {}),
    }),
  );
}

async function handleApiAdminEmailMessage(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const folder = url.searchParams.get('folder')?.trim() || '';
  if (!folder) {
    sendJson(res, 400, { error: '`folder` is required.' });
    return;
  }

  const uidRaw = url.searchParams.get('uid')?.trim() || '';
  const uid = Number.parseInt(uidRaw, 10);
  if (!uidRaw || !Number.isFinite(uid) || uid === 0) {
    sendJson(res, 400, { error: '`uid` must be a non-zero integer.' });
    return;
  }

  sendJson(res, 200, await getGatewayAdminEmailMessage({ folder, uid }));
}

async function handleApiAdminEmailMessageDelete(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const folder = url.searchParams.get('folder')?.trim() || '';
  if (!folder) {
    sendJson(res, 400, { error: '`folder` is required.' });
    return;
  }

  const uidRaw = url.searchParams.get('uid')?.trim() || '';
  const uid = Number.parseInt(uidRaw, 10);
  if (!uidRaw || !Number.isFinite(uid) || uid <= 0) {
    sendJson(res, 400, { error: '`uid` must be a positive integer.' });
    return;
  }

  sendJson(res, 200, await deleteGatewayAdminEmailMessage({ folder, uid }));
}

type ApiAdminAgentPayloadBody = {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  skills?: unknown;
  chatbotId?: unknown;
  enableRag?: unknown;
  archived?: unknown;
  proxy?: unknown;
  role?: unknown;
  reportsTo?: unknown;
  reports_to?: unknown;
  delegatesTo?: unknown;
  delegates_to?: unknown;
  peers?: unknown;
  workspace?: unknown;
  routing?: unknown;
};

type ApiAdminAgentPayload = {
  id?: string;
  name?: string;
  model?: string;
  skills?: string[] | null;
  chatbotId?: string;
  enableRag?: boolean;
  archived?: boolean;
  proxy?: AgentProxyConfig | null;
  role?: string;
  reportsTo?: string | null;
  delegatesTo?: string[] | null;
  peers?: string[] | null;
  workspace?: string;
  routing?: AgentRoutingConfig | null;
};

type ApiAdminAgentsRouteMatch =
  | { kind: 'collection'; isKnownPath: true }
  | { kind: 'agent'; isKnownPath: true; agentId: string }
  | { kind: 'file'; isKnownPath: true; agentId: string; fileName: string }
  | {
      kind: 'revision';
      isKnownPath: true;
      agentId: string;
      fileName: string;
      revisionId: string;
    }
  | {
      kind: 'restore';
      isKnownPath: true;
      agentId: string;
      fileName: string;
      revisionId: string;
    }
  | { kind: 'unknown'; isKnownPath: boolean };

function parseApiAdminAgentsRoute(url: URL): ApiAdminAgentsRouteMatch {
  const segments = url.pathname.split('/').filter(Boolean);
  const agentId = segments[3] ? decodeApiPathSegment(segments[3]).trim() : '';
  const fileName = segments[5] ? decodeApiPathSegment(segments[5]).trim() : '';
  const revisionId = segments[7]
    ? decodeApiPathSegment(segments[7]).trim()
    : '';
  const hasFilesPrefix = segments[4] === 'files';
  const hasRevisionsPrefix = segments[6] === 'revisions';

  if (segments.length === 3) {
    return { kind: 'collection', isKnownPath: true };
  }
  if (segments.length === 4 && agentId) {
    return { kind: 'agent', isKnownPath: true, agentId };
  }
  if (segments.length === 6 && hasFilesPrefix && agentId && fileName) {
    return { kind: 'file', isKnownPath: true, agentId, fileName };
  }
  if (
    segments.length === 8 &&
    hasFilesPrefix &&
    hasRevisionsPrefix &&
    agentId &&
    fileName &&
    revisionId
  ) {
    return {
      kind: 'revision',
      isKnownPath: true,
      agentId,
      fileName,
      revisionId,
    };
  }
  if (
    segments.length === 9 &&
    hasFilesPrefix &&
    hasRevisionsPrefix &&
    agentId &&
    fileName &&
    revisionId &&
    segments[8] === 'restore'
  ) {
    return {
      kind: 'restore',
      isKnownPath: true,
      agentId,
      fileName,
      revisionId,
    };
  }

  return {
    kind: 'unknown',
    isKnownPath:
      (segments.length === 5 && hasFilesPrefix) ||
      (segments.length === 7 && hasFilesPrefix && hasRevisionsPrefix),
  };
}

function sendApiAdminAgentError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const isKnownNotFoundMessage =
    /^Agent ["`].+["`] was not found\.$/.test(message) ||
    /^Revision ["`].+["`] was not found\.$/.test(message) ||
    /^Team structure revision \d+ was not found\.$/.test(message);
  const status =
    error instanceof GatewayRequestError
      ? error.statusCode
      : isKnownNotFoundMessage
        ? 404
        : 400;
  sendJson(res, status, { error: message });
}

function sendMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: 'Method Not Allowed' });
}

function requireAdminAgentIdPathValue(agentId: string): string {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    throw new GatewayRequestError(400, 'Missing agent id in request path.');
  }
  return normalizedAgentId;
}

function normalizeApiAdminAgentSkills(
  skills: unknown,
): string[] | null | undefined {
  if (skills === undefined) return undefined;
  if (skills === null) return null;
  if (!Array.isArray(skills)) {
    throw new GatewayRequestError(
      400,
      'Expected `skills` to be an array or null.',
    );
  }
  return normalizeTrimmedUniqueStringArray(skills);
}

function normalizeApiAdminAgentStringArray(
  fieldName: string,
  value: unknown,
): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new GatewayRequestError(
      400,
      `Expected \`${fieldName}\` to be an array or null.`,
    );
  }
  return normalizeTrimmedUniqueStringArray(value);
}

function normalizeApiAdminNullableStringAlias(
  value: object,
  camelKey: string,
  snakeKey: string,
): string | null | undefined {
  const input = resolveSnakeCamelAlias(value, camelKey, snakeKey);
  if (typeof input === 'string') return input;
  return input === null ? null : undefined;
}

function normalizeApiAdminAgentProxy(
  value: unknown,
): AgentProxyConfig | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return normalizeAgentProxyConfig(value, 'proxy') ?? null;
}

function normalizeApiAdminAgentRouting(
  value: unknown,
): AgentRoutingConfig | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return normalizeAgentRoutingConfig(value, 'routing') ?? null;
}

async function readApiAdminAgentPayload(
  req: IncomingMessage,
  options?: { requireId?: boolean },
): Promise<ApiAdminAgentPayload> {
  const body = (await readJsonBody(req)) as ApiAdminAgentPayloadBody;
  const delegatesToInput = resolveSnakeCamelAlias(
    body,
    'delegatesTo',
    'delegates_to',
  );
  const payload: ApiAdminAgentPayload = {
    id: String(body.id || '').trim() || undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    skills: normalizeApiAdminAgentSkills(body.skills),
    chatbotId: typeof body.chatbotId === 'string' ? body.chatbotId : undefined,
    enableRag: typeof body.enableRag === 'boolean' ? body.enableRag : undefined,
    archived: typeof body.archived === 'boolean' ? body.archived : undefined,
    proxy: normalizeApiAdminAgentProxy(body.proxy),
    role: typeof body.role === 'string' ? body.role : undefined,
    reportsTo: normalizeApiAdminNullableStringAlias(
      body,
      'reportsTo',
      'reports_to',
    ),
    delegatesTo: normalizeApiAdminAgentStringArray(
      'delegatesTo',
      delegatesToInput,
    ),
    peers: normalizeApiAdminAgentStringArray('peers', body.peers),
    workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
    routing: normalizeApiAdminAgentRouting(body.routing),
  };
  if (options?.requireId && !payload.id) {
    throw new GatewayRequestError(
      400,
      'Expected non-empty `id` in request body.',
    );
  }
  return payload;
}

async function handleApiAdminAgentCollectionResource(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<void> {
  if (method === 'GET') {
    sendJson(res, 200, getGatewayAdminAgents());
    return;
  }
  if (method === 'POST') {
    try {
      const payload = await readApiAdminAgentPayload(req, { requireId: true });
      sendJson(
        res,
        200,
        createGatewayAdminAgent({
          id: payload.id || '',
          name: payload.name,
          model: payload.model,
          skills: payload.skills,
          chatbotId: payload.chatbotId,
          enableRag: payload.enableRag,
          proxy: payload.proxy,
          role: payload.role,
          reportsTo: payload.reportsTo,
          delegatesTo: payload.delegatesTo,
          peers: payload.peers,
          workspace: payload.workspace,
          routing: payload.routing,
        }),
      );
    } catch (error) {
      sendApiAdminAgentError(res, error);
    }
    return;
  }
  sendMethodNotAllowed(res);
}

async function handleApiAdminAgentResource(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  agentId: string,
): Promise<void> {
  try {
    const normalizedAgentId = requireAdminAgentIdPathValue(agentId);
    if (method === 'DELETE') {
      sendJson(res, 200, deleteGatewayAdminAgent(normalizedAgentId));
      return;
    }
    if (method === 'PUT') {
      const payload = await readApiAdminAgentPayload(req);
      sendJson(
        res,
        200,
        updateGatewayAdminAgent(normalizedAgentId, {
          name: payload.name,
          model: payload.model,
          skills: payload.skills,
          chatbotId: payload.chatbotId,
          enableRag: payload.enableRag,
          archived: payload.archived,
          proxy: payload.proxy,
          role: payload.role,
          reportsTo: payload.reportsTo,
          delegatesTo: payload.delegatesTo,
          peers: payload.peers,
          workspace: payload.workspace,
          routing: payload.routing,
        }),
      );
      return;
    }
    sendMethodNotAllowed(res);
  } catch (error) {
    sendApiAdminAgentError(res, error);
  }
}

async function handleApiAdminAgentFileResource(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  params: {
    agentId: string;
    fileName: string;
  },
): Promise<void> {
  if (method === 'GET') {
    try {
      sendJson(
        res,
        200,
        getGatewayAdminAgentMarkdownFile(params.agentId, params.fileName),
      );
    } catch (error) {
      sendApiAdminAgentError(res, error);
    }
    return;
  }
  if (method === 'PUT') {
    try {
      const body = (await readJsonBody(req)) as { content?: unknown };
      if (typeof body.content !== 'string') {
        throw new GatewayRequestError(
          400,
          'Expected string `content` in request body.',
        );
      }
      sendJson(
        res,
        200,
        saveGatewayAdminAgentMarkdownFile({
          agentId: params.agentId,
          fileName: params.fileName,
          content: body.content,
        }),
      );
    } catch (error) {
      sendApiAdminAgentError(res, error);
    }
    return;
  }
  sendMethodNotAllowed(res);
}

async function handleApiAdminAgentRevisionResource(
  res: ServerResponse,
  method: string,
  params: {
    agentId: string;
    fileName: string;
    revisionId: string;
  },
): Promise<void> {
  if (method === 'GET') {
    try {
      sendJson(
        res,
        200,
        getGatewayAdminAgentMarkdownRevision({
          agentId: params.agentId,
          fileName: params.fileName,
          revisionId: params.revisionId,
        }),
      );
    } catch (error) {
      sendApiAdminAgentError(res, error);
    }
    return;
  }
  sendMethodNotAllowed(res);
}

async function handleApiAdminAgentRevisionRestoreResource(
  res: ServerResponse,
  method: string,
  params: {
    agentId: string;
    fileName: string;
    revisionId: string;
  },
): Promise<void> {
  if (method === 'POST') {
    try {
      sendJson(
        res,
        200,
        restoreGatewayAdminAgentMarkdownRevision({
          agentId: params.agentId,
          fileName: params.fileName,
          revisionId: params.revisionId,
        }),
      );
    } catch (error) {
      sendApiAdminAgentError(res, error);
    }
    return;
  }
  sendMethodNotAllowed(res);
}

async function handleApiAdminAgents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  const route = parseApiAdminAgentsRoute(url);

  switch (route.kind) {
    case 'collection':
      await handleApiAdminAgentCollectionResource(req, res, method);
      return;
    case 'agent':
      await handleApiAdminAgentResource(req, res, method, route.agentId);
      return;
    case 'file':
      await handleApiAdminAgentFileResource(req, res, method, {
        agentId: route.agentId,
        fileName: route.fileName,
      });
      return;
    case 'revision':
      await handleApiAdminAgentRevisionResource(res, method, {
        agentId: route.agentId,
        fileName: route.fileName,
        revisionId: route.revisionId,
      });
      return;
    case 'restore':
      await handleApiAdminAgentRevisionRestoreResource(res, method, {
        agentId: route.agentId,
        fileName: route.fileName,
        revisionId: route.revisionId,
      });
      return;
    case 'unknown':
      sendJson(res, route.isKnownPath ? 405 : 404, {
        error: route.isKnownPath ? 'Method Not Allowed' : 'Not Found',
      });
      return;
  }
}

async function handleApiAdminHybridAIBots(
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  if (method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  try {
    sendJson(
      res,
      200,
      await getGatewayAdminHybridAIBots({
        baseUrl: normalizeApiAdminHybridAIBaseUrl(url),
      }),
    );
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    sendJson(res, 502, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeApiAdminHybridAIBaseUrl(url: URL): string | undefined {
  const raw = url.searchParams.get('baseUrl');
  if (raw === null) return undefined;
  const normalized = raw.trim();
  if (!normalized) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new GatewayRequestError(400, 'baseUrl must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new GatewayRequestError(400, 'baseUrl must use HTTPS.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/g, '');
}

async function handleApiAdminTeamStructure(
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 3) {
    if (method === 'GET') {
      sendJson(res, 200, getGatewayAdminTeamStructure());
      return;
    }
    sendMethodNotAllowed(res);
    return;
  }

  const revisionId =
    segments.length >= 5 && segments[3] === 'revisions'
      ? parsePositiveInteger(decodeApiPathSegment(segments[4] || ''))
      : null;
  if (!revisionId) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  try {
    if (segments.length === 5 && method === 'GET') {
      sendJson(res, 200, getGatewayAdminTeamStructureRevision(revisionId));
      return;
    }
    if (
      segments.length === 6 &&
      segments[5] === 'restore' &&
      method === 'POST'
    ) {
      sendJson(res, 200, restoreGatewayAdminTeamStructureRevision(revisionId));
      return;
    }
    sendMethodNotAllowed(res);
  } catch (error) {
    sendApiAdminAgentError(res, error);
  }
}

function handleApiAdminSessions(res: ServerResponse): void {
  sendJson(res, 200, { sessions: getGatewayAdminSessions() });
}

function handleApiAdminSessionDelete(res: ServerResponse, url: URL): void {
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` query parameter.' });
    return;
  }
  sendJson(
    res,
    200,
    deleteGatewayAdminSession(sessionId, {
      onlyWithoutUserMessages: url.searchParams.get('ifNoUserMessages') === '1',
    }),
  );
}

async function handleApiAdminChannels(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminChannels());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const transport = (url.searchParams.get('transport') || '').trim();
    const guildId = (url.searchParams.get('guildId') || '').trim();
    const channelId = (url.searchParams.get('channelId') || '').trim();
    sendJson(
      res,
      200,
      removeGatewayAdminChannel({
        transport: transport === 'msteams' ? 'msteams' : 'discord',
        guildId,
        channelId,
      }),
    );
    return;
  }

  const body = (await readJsonBody(req)) as {
    transport?: string;
    guildId?: string;
    channelId?: string;
    config?: unknown;
  };
  const transport =
    typeof body.transport === 'string' && body.transport.trim() === 'msteams'
      ? 'msteams'
      : 'discord';
  if (typeof body.guildId !== 'string' || typeof body.channelId !== 'string') {
    sendJson(res, 400, {
      error: 'Expected `guildId` and `channelId`.',
    });
    return;
  }

  if (transport === 'discord' && !isRuntimeDiscordChannelConfig(body.config)) {
    sendJson(res, 400, {
      error:
        'Discord bindings require object `config` with `mode` set to off, mention, or free.',
    });
    return;
  }

  if (transport === 'msteams' && !isRuntimeMSTeamsChannelConfig(body.config)) {
    sendJson(res, 400, {
      error:
        'Teams bindings require object `config` containing Teams channel override fields.',
    });
    return;
  }

  if (transport === 'msteams') {
    sendJson(
      res,
      200,
      upsertGatewayAdminChannel({
        transport,
        guildId: body.guildId,
        channelId: body.channelId,
        config: body.config as RuntimeMSTeamsChannelConfig,
      }),
    );
    return;
  }

  sendJson(
    res,
    200,
    upsertGatewayAdminChannel({
      transport,
      guildId: body.guildId,
      channelId: body.channelId,
      config: body.config as RuntimeDiscordChannelConfig,
    }),
  );
}

async function handleApiAdminConfig(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminConfig());
    return;
  }

  const body = (await readJsonBody(req)) as { config?: unknown };
  if (
    !body.config ||
    typeof body.config !== 'object' ||
    Array.isArray(body.config)
  ) {
    sendJson(res, 400, { error: 'Expected object `config` in request body.' });
    return;
  }

  sendJson(res, 200, saveGatewayAdminConfig(body.config as RuntimeConfig));
}

async function handleApiAdminSlackWebhookTargets(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as
    | GatewayAdminSlackWebhookTargetRequest
    | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Expected Slack webhook target object.' });
    return;
  }

  sendJson(res, 200, saveGatewayAdminSlackWebhookTarget(body));
}

async function handleApiAdminDiscordWebhookTargets(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as
    | GatewayAdminDiscordWebhookTargetRequest
    | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Expected Discord webhook target object.' });
    return;
  }

  sendJson(res, 200, saveGatewayAdminDiscordWebhookTarget(body));
}

async function handleApiAdminA2ATrust(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  const actor =
    resolveGatewayRequestUserId({
      req,
      channelId: 'web',
      fallbackUserId: 'admin-console',
    }) || 'admin-console';
  if (method === 'GET') {
    sendJson(res, 200, getGatewayAdminA2ATrust());
    return;
  }

  if (method === 'POST' || method === 'PUT') {
    const body = (await readJsonBody(req).catch(() => ({}))) as
      | GatewayAdminA2ATrustUpsertRequest
      | undefined;
    try {
      sendJson(res, 200, upsertGatewayAdminA2ATrustPeer(body || {}, actor));
    } catch (error) {
      sendJson(
        res,
        error instanceof GatewayRequestError ? error.statusCode : 400,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return;
  }

  if (method !== 'DELETE') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const peerId = (url.searchParams.get('peerId') || '').trim();
  if (!peerId) {
    sendJson(res, 400, { error: 'Missing `peerId` query parameter.' });
    return;
  }
  const reason = (url.searchParams.get('reason') || '').trim() || undefined;
  const action = (url.searchParams.get('action') || '').trim();
  try {
    sendJson(
      res,
      200,
      action === 'delete'
        ? deleteGatewayAdminA2ATrustPeer({ peerId, actor })
        : revokeGatewayAdminA2ATrustPeer({ peerId, reason, actor }),
    );
  } catch (error) {
    sendJson(
      res,
      error instanceof GatewayRequestError ? error.statusCode : 400,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function handleApiAdminA2ALocalMode(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req).catch(() => ({}))) as {
    enabled?: unknown;
  };
  if (typeof body.enabled !== 'boolean') {
    sendJson(res, 400, { error: 'Expected boolean `enabled`.' });
    return;
  }
  const actor =
    resolveGatewayRequestUserId({
      req,
      channelId: 'web',
      fallbackUserId: 'admin-console',
    }) || 'admin-console';
  sendJson(
    res,
    200,
    saveGatewayAdminA2ALocalMode({ enabled: body.enabled, actor }),
  );
}

async function handleApiAdminA2AE2EERequired(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req).catch(() => ({}))) as {
    required?: unknown;
  };
  if (typeof body.required !== 'boolean') {
    sendJson(res, 400, { error: 'Expected boolean `required`.' });
    return;
  }
  const actor =
    resolveGatewayRequestUserId({
      req,
      channelId: 'web',
      fallbackUserId: 'admin-console',
    }) || 'admin-console';
  sendJson(
    res,
    200,
    saveGatewayAdminA2AE2EERequired({ required: body.required, actor }),
  );
}

async function handleApiAdminFleetTopology(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  try {
    if (method === 'GET') {
      sendJson(res, 200, await getGatewayAdminFleetTopology());
      return;
    }

    if (method === 'POST' || method === 'PUT') {
      const body = (await readJsonBody(req).catch(() => ({}))) as
        | GatewayAdminFleetTopologyUpsertRequest
        | undefined;
      sendJson(
        res,
        200,
        await upsertGatewayAdminFleetTopologyInstance(body || {}),
      );
      return;
    }

    if (method === 'DELETE') {
      const peerId = (url.searchParams.get('peerId') || '').trim();
      if (!peerId) {
        sendJson(res, 400, { error: 'Missing `peerId` query parameter.' });
        return;
      }
      sendJson(
        res,
        200,
        await deleteGatewayAdminFleetTopologyInstance({ peerId }),
      );
      return;
    }

    sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (error) {
    sendJson(
      res,
      error instanceof GatewayRequestError ? error.statusCode : 400,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function handleApiAdminA2APairing(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  const actor =
    resolveGatewayRequestUserId({
      req,
      channelId: 'web',
      fallbackUserId: 'admin-console',
    }) || 'admin-console';
  const body = (await readJsonBody(req).catch(() => ({}))) as
    | GatewayAdminA2APairingStartRequest
    | GatewayAdminA2APairingDecisionRequest
    | undefined;
  try {
    if (pathname === '/api/admin/a2a/pairing/approve') {
      sendJson(
        res,
        200,
        approveGatewayAdminA2APairingRequest(body || {}, actor),
      );
      return;
    }
    if (pathname === '/api/admin/a2a/pairing/decline') {
      sendJson(
        res,
        200,
        declineGatewayAdminA2APairingRequest(body || {}, actor),
      );
      return;
    }
    if (pathname === '/api/admin/a2a/pairing/preview') {
      sendJson(res, 200, await previewGatewayAdminA2APairing(body || {}));
      return;
    }
    sendJson(res, 200, await startGatewayAdminA2APairing(body || {}, actor));
  } catch (error) {
    sendJson(
      res,
      error instanceof GatewayRequestError ? error.statusCode : 400,
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function handleApiAdminA2AInbox(res: ServerResponse, url: URL): void {
  const threadId = (url.searchParams.get('threadId') || '').trim() || null;
  try {
    sendJson(res, 200, getGatewayAdminA2AInbox({ threadId }));
  } catch (error) {
    sendJson(
      res,
      error instanceof GatewayRequestError ? error.statusCode : 400,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function handleApiAdminA2AOutboxStatus(res: ServerResponse, url: URL): void {
  const messageId = (url.searchParams.get('messageId') || '').trim();
  if (!messageId) {
    sendJson(res, 400, { error: 'messageId query parameter is required' });
    return;
  }
  try {
    sendJson(res, 200, getA2AOutboxDeliveryStatus(messageId));
  } catch (error) {
    sendJson(
      res,
      error instanceof GatewayRequestError ? error.statusCode : 400,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function handleApiAdminSignalLink(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getSignalLinkState());
    return;
  }

  const body = (await readJsonBody(req).catch(() => ({}))) as {
    cliPath?: unknown;
    deviceName?: unknown;
  };
  try {
    sendJson(
      res,
      200,
      startSignalLink({
        cliPath: typeof body.cliPath === 'string' ? body.cliPath : undefined,
        deviceName:
          typeof body.deviceName === 'string' ? body.deviceName : undefined,
      }),
    );
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Signal link failed.',
    });
  }
}

function extractUpstreamError(payload: unknown, status: number): string {
  const record = payload as Record<string, unknown> | null;
  const nested = record?.error;
  return String(
    (typeof record?.message === 'string' && record.message) ||
      (typeof nested === 'string' && nested) ||
      (nested &&
        typeof nested === 'object' &&
        typeof (nested as Record<string, unknown>).message === 'string' &&
        (nested as Record<string, unknown>).message) ||
      `HybridAI API returned HTTP ${status}`,
  );
}

async function hybridAIFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  const contentType = response.headers.get('content-type') || '';
  let payload: unknown;
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => '');
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return { ok: response.ok, status: response.status, payload };
}

async function handleApiAdminEmailConfigFetch(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  let apiKey: string;
  try {
    apiKey = getHybridAIApiKey();
  } catch {
    sendJson(res, 400, {
      error:
        'HYBRIDAI_API_KEY is not configured. Run `hybridclaw auth login hybridai` first.',
    });
    return;
  }

  const baseUrl = (HYBRIDAI_BASE_URL || 'https://hybridai.one').replace(
    /\/+$/,
    '',
  );

  let handlesResult: { ok: boolean; status: number; payload: unknown };
  try {
    handlesResult = await hybridAIFetch(
      baseUrl,
      apiKey,
      '/api/v1/agent-handles/',
    );
  } catch (error) {
    sendJson(res, 502, {
      error: `Could not reach HybridAI API: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  if (!handlesResult.ok) {
    sendJson(res, 502, {
      error: extractUpstreamError(handlesResult.payload, handlesResult.status),
    });
    return;
  }

  const handlesPayload = handlesResult.payload as {
    handles?: Array<{ id?: string; handle?: string; status?: string }>;
  };
  const handles = Array.isArray(handlesPayload?.handles)
    ? handlesPayload.handles
    : [];

  if (handles.length === 0) {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { handles: [], credentials: null });
    return;
  }

  const requestedHandleId = (url.searchParams.get('handleId') || '').trim();
  const activeHandle = requestedHandleId
    ? handles.find(
        (h) => h.id === requestedHandleId || h.handle === requestedHandleId,
      )
    : handles.find((h) => h.status === 'active') || handles[0];

  if (requestedHandleId && !activeHandle) {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 404, {
      handles,
      credentials: null,
      error: `No HybridAI agent handle found for ${requestedHandleId}.`,
    });
    return;
  }
  if (!activeHandle) {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { handles, credentials: null });
    return;
  }

  const handleId = activeHandle.id || activeHandle.handle;

  if (!handleId) {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { handles, credentials: null });
    return;
  }

  let credResult: { ok: boolean; status: number; payload: unknown };
  try {
    credResult = await hybridAIFetch(
      baseUrl,
      apiKey,
      `/api/v1/agent-handles/${encodeURIComponent(handleId)}/mailbox/credentials`,
      'POST',
    );
  } catch (error) {
    sendJson(res, 502, {
      error: `Could not fetch mailbox credentials: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  if (!credResult.ok) {
    sendJson(res, 502, {
      error: extractUpstreamError(credResult.payload, credResult.status),
    });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    handles,
    credentials: credResult.payload,
    handleId,
  });
}

async function handleApiAdminModels(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, await getGatewayAdminModels());
    return;
  }

  const body = (await readJsonBody(req)) as {
    defaultModel?: unknown;
  };
  sendJson(res, 200, await saveGatewayAdminModels(body));
}

async function handleApiAdminScheduler(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminScheduler());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const source =
      (url.searchParams.get('source') || '').trim().toLowerCase() === 'task'
        ? 'task'
        : 'job';
    const rawId =
      source === 'task'
        ? (url.searchParams.get('taskId') || '').trim()
        : (url.searchParams.get('jobId') || '').trim();
    const jobId = (url.searchParams.get('jobId') || '').trim();
    sendJson(res, 200, removeGatewayAdminSchedulerJob(rawId || jobId, source));
    return;
  }

  if ((req.method || 'GET') === 'POST') {
    const body = (await readJsonBody(req)) as {
      jobId?: unknown;
      taskId?: unknown;
      source?: unknown;
      action?: unknown;
      beforeJobId?: unknown;
      boardStatus?: unknown;
    };
    const source =
      String(body.source || '')
        .trim()
        .toLowerCase() === 'task'
        ? 'task'
        : 'job';
    const jobId = String(
      source === 'task' ? body.taskId || '' : body.jobId || '',
    ).trim();
    const action = String(body.action || '')
      .trim()
      .toLowerCase();
    if (action === 'move') {
      let boardStatus: Parameters<
        typeof moveGatewayAdminSchedulerJob
      >[0]['boardStatus'];
      try {
        if ('boardStatus' in body) {
          boardStatus = parseSchedulerBoardStatus(body.boardStatus) ?? null;
        }
      } catch (error) {
        sendJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      sendJson(
        res,
        200,
        moveGatewayAdminSchedulerJob({
          jobId,
          beforeJobId: String(body.beforeJobId || '').trim() || null,
          ...('boardStatus' in body ? { boardStatus } : {}),
        }),
      );
      return;
    }
    if (action !== 'pause' && action !== 'resume') {
      sendJson(res, 400, {
        error: 'Expected scheduler action `pause`, `resume`, or `move`.',
      });
      return;
    }
    sendJson(
      res,
      200,
      setGatewayAdminSchedulerJobPaused({
        jobId,
        paused: action === 'pause',
        source,
      }),
    );
    return;
  }

  const body = (await readJsonBody(req)) as { job?: unknown };
  sendJson(res, 200, upsertGatewayAdminSchedulerJob({ job: body.job }));
}

async function handleApiAdminMcp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminMcp());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const name = (url.searchParams.get('name') || '').trim();
    sendJson(res, 200, removeGatewayAdminMcpServer(name));
    return;
  }

  const body = (await readJsonBody(req)) as {
    name?: unknown;
    config?: unknown;
  };
  sendJson(
    res,
    200,
    upsertGatewayAdminMcpServer({
      name: String(body.name || ''),
      config: body.config,
    }),
  );
}

async function handleApiAdminMcpOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const pathname = url.pathname;
  if (pathname === '/api/admin/mcp/oauth/status') {
    const name = (url.searchParams.get('name') || '').trim();
    sendJson(res, 200, getGatewayAdminMcpOAuthStatus(name));
    return;
  }
  const body = (await readJsonBody(req)) as { name?: unknown };
  const name = String(body.name || '').trim();
  if (pathname === '/api/admin/mcp/oauth/start') {
    sendJson(
      res,
      200,
      await startGatewayAdminMcpOAuth({
        name,
        requestBaseUrl: resolveRequestOrigin(req),
      }),
    );
    return;
  }
  sendJson(res, 200, logoutGatewayAdminMcpOAuth(name));
}

async function handleApiAdminConnectors(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const pathname = url.pathname;
  if (pathname === '/api/admin/connectors' && req.method === 'GET') {
    sendJson(
      res,
      200,
      await getGatewayAdminConnectorsWithPlatformState(
        resolveRequestOrigin(req),
      ),
    );
    return;
  }

  if (
    pathname === '/api/admin/connectors/hybridai/key' &&
    req.method === 'PUT'
  ) {
    const body = (await readJsonBody(req)) as { apiKey?: unknown };
    sendJson(
      res,
      200,
      saveGatewayAdminHybridAIConnectorApiKey(body, resolveRequestOrigin(req)),
    );
    return;
  }

  if (
    pathname === '/api/admin/connectors/oauth/start' &&
    req.method === 'POST'
  ) {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    sendJson(
      res,
      200,
      await startGatewayAdminConnectorOAuth({
        body,
        requestBaseUrl: resolveRequestOrigin(req),
      }),
    );
    return;
  }

  if (pathname === '/api/admin/connectors/logout' && req.method === 'POST') {
    const body = (await readJsonBody(req)) as { provider?: unknown };
    sendJson(
      res,
      200,
      logoutGatewayAdminConnector(body, resolveRequestOrigin(req)),
    );
    return;
  }

  if (pathname === '/api/admin/connectors/test' && req.method === 'POST') {
    const body = (await readJsonBody(req)) as { provider?: unknown };
    sendJson(res, 200, await testGatewayAdminConnector(body));
    return;
  }

  sendMethodNotAllowed(res);
}

function sendMcpOAuthCallbackPage(
  res: ServerResponse,
  status: number,
  title: string,
  detail: string,
  opts?: { autoClose?: boolean },
): void {
  // window.close() only works for script-opened tabs (the console's
  // window.open); for manually opened tabs it is a silent no-op.
  const autoClose = opts?.autoClose
    ? '<script>setTimeout(function(){window.close()},1500)</script>'
    : '';
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#101418;color:#e8eaed}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#9aa0a6}</style>' +
      `</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>${autoClose}</body></html>`,
  );
}

async function handleApiMcpOAuthCallback(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const error = (url.searchParams.get('error') || '').trim();
  if (error) {
    sendMcpOAuthCallbackPage(
      res,
      400,
      'MCP authorization failed',
      'The provider returned an authorization error. Please close this tab and try again.',
    );
    return;
  }
  const state = (url.searchParams.get('state') || '').trim();
  const code = (url.searchParams.get('code') || '').trim();
  if (!state || !code) {
    sendMcpOAuthCallbackPage(
      res,
      400,
      'MCP authorization failed',
      'The callback is missing the authorization code or state parameter.',
    );
    return;
  }
  try {
    await completeGatewayMcpOAuthCallback({ state, code });
    sendMcpOAuthCallbackPage(
      res,
      200,
      'MCP connected',
      'Authorization complete. You can close this tab and return to HybridClaw.',
      { autoClose: true },
    );
  } catch {
    sendMcpOAuthCallbackPage(
      res,
      400,
      'MCP authorization failed',
      'Authorization could not be completed. Please close this tab and try again.',
    );
  }
}

async function handleApiConnectorOAuthCallback(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const state = (url.searchParams.get('state') || '').trim();
  const code = (url.searchParams.get('code') || '').trim();
  const providerError = (url.searchParams.get('error') || '').trim();
  if (providerError) {
    sendMcpOAuthCallbackPage(
      res,
      400,
      'Connector authorization failed',
      'The provider returned an authorization error. Please close this tab and try again.',
    );
    return;
  }
  if (!state || !code) {
    sendMcpOAuthCallbackPage(
      res,
      400,
      'Connector authorization failed',
      'The callback is missing the authorization code or state parameter.',
    );
    return;
  }
  try {
    await completeGatewayAdminConnectorOAuthCallback({
      state,
      code,
    });
    sendMcpOAuthCallbackPage(
      res,
      200,
      'Connector connected',
      'Authorization complete. You can close this tab and return to HybridClaw.',
      { autoClose: true },
    );
  } catch {
    sendMcpOAuthCallbackPage(
      res,
      400,
      'Connector authorization failed',
      'Authorization could not be completed. Please close this tab and try again.',
    );
  }
}

function handleApiAdminAudit(res: ServerResponse, url: URL): void {
  const parsedLimit = parseInt(url.searchParams.get('limit') || '60', 10);
  const limit = Number.isNaN(parsedLimit) ? 60 : parsedLimit;
  const rawCursor = url.searchParams.get('cursor');
  const parsedCursor = rawCursor ? parseInt(rawCursor, 10) : Number.NaN;
  const cursor =
    Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0;
  sendJson(
    res,
    200,
    getGatewayAdminAudit({
      query: url.searchParams.get('query') || '',
      sessionId: url.searchParams.get('sessionId') || '',
      eventType: url.searchParams.get('eventType') || '',
      since: url.searchParams.get('since') || '',
      until: url.searchParams.get('until') || '',
      cursor,
      limit,
    }),
  );
}

function handleApiAdminApprovals(res: ServerResponse, url: URL): void {
  sendJson(
    res,
    200,
    getGatewayAdminApprovals({
      agentId: url.searchParams.get('agentId') || '',
    }),
  );
}

function parseInteractionModality(value: unknown): InteractionModality {
  const normalized = String(value || '').trim();
  if (INTERACTION_MODALITIES.includes(normalized as InteractionModality)) {
    return normalized as InteractionModality;
  }
  throw new GatewayRequestError(
    400,
    '`modality` must be one of totp, push, qr, sms, or recovery_code.',
  );
}

function parseInteractionFrameSnapshot(value: unknown): {
  url: string;
  title?: string | null;
  browserSessionKey?: string | null;
  screenshotRef?: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayRequestError(400, 'Expected object `frameSnapshot`.');
  }
  const raw = value as Record<string, unknown>;
  const url = normalizeOptionalString(raw.url);
  if (!url) {
    throw new GatewayRequestError(
      400,
      'Expected non-empty `frameSnapshot.url`.',
    );
  }
  return {
    url,
    title: normalizeOptionalString(raw.title) || null,
    browserSessionKey: normalizeOptionalString(raw.browserSessionKey) || null,
    screenshotRef: normalizeOptionalString(raw.screenshotRef) || null,
  };
}

const MAX_OPERATOR_RETURN_CODE_LENGTH = 16;
const MAX_OPERATOR_RETURN_REASON_LENGTH = 500;

function parseOperatorReturnCode(value: unknown): string | null {
  const code = normalizeOptionalString(value);
  if (!code) return null;
  const normalized = code.replace(/[\s-]/g, '');
  if (
    normalized.length > MAX_OPERATOR_RETURN_CODE_LENGTH ||
    !/^\d+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseOperatorReturnReason(value: unknown): string | null {
  const reason = normalizeOptionalString(value);
  if (!reason) return null;
  return reason.length <= MAX_OPERATOR_RETURN_REASON_LENGTH ? reason : null;
}

function parseOperatorReturn(value: unknown): OperatorReturn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = normalizeOptionalString(raw.kind);
  if (kind === 'code') {
    const code = parseOperatorReturnCode(raw.value);
    return code ? { kind, value: code } : null;
  }
  if (kind === 'approved' || kind === 'scanned' || kind === 'timeout') {
    return { kind };
  }
  if (kind === 'declined') {
    const reason = parseOperatorReturnReason(raw.reason);
    return reason ? { kind, reason } : { kind };
  }
  return null;
}

function createOperatorReturnCodeHandle(value: string): BrowserFillInput {
  return createSecretHandle(
    hardenSecretRef({
      source: 'store',
      id: `OPERATOR_RETURN_${randomUUID().replace(/-/g, '').toUpperCase()}`,
    }),
    value,
    'dom',
  );
}

function broadcastSseEvent(
  activeSseResponses: Set<ServerResponse>,
  event: string,
  payload: unknown,
): void {
  const data = JSON.stringify(payload);
  for (const sseRes of activeSseResponses) {
    try {
      if (!sseRes.writableEnded) {
        sseRes.write(`event: ${event}\n`);
        sseRes.write(`data: ${data}\n\n`);
      }
    } catch {
      // Ignore closed SSE clients.
    }
  }
}

type InteractiveHandlerBody = Record<string, unknown>;

function queueInteractionNotification(
  session: ReturnType<typeof createSuspendedSession>,
): {
  queued: boolean;
  channelId: string | null;
} {
  const targetChannel = session.escalationTarget?.channel?.trim() || '';
  if (!targetChannel || !isSupportedProactiveChannelId(targetChannel)) {
    return { queued: false, channelId: targetChannel || null };
  }
  try {
    enqueueProactiveMessage(
      targetChannel,
      formatInteractionRequest(session),
      'interactive-escalation',
      100,
    );
    return { queued: true, channelId: targetChannel };
  } catch (error) {
    logger.warn(
      { channelId: targetChannel, sessionId: session.sessionId, error },
      'Failed to queue interactive escalation notification',
    );
    return { queued: false, channelId: targetChannel };
  }
}

function sendApiInteractiveError(res: ServerResponse, error: unknown): void {
  const status = error instanceof GatewayRequestError ? error.statusCode : 500;
  sendJson(res, status, {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function readInteractiveBody(
  req: IncomingMessage,
): Promise<InteractiveHandlerBody> {
  return (await readJsonBody(req)) as InteractiveHandlerBody;
}

function handleApiListInteractiveEscalations(res: ServerResponse): void {
  sendJson(res, 200, {
    sessions: getGatewayAdminApprovals().suspendedSessions,
  });
}

async function handleApiResumeInteractiveEscalation(
  req: IncomingMessage,
  res: ServerResponse,
  activeSseResponses: Set<ServerResponse>,
): Promise<void> {
  try {
    const body = await readInteractiveBody(req);
    const sessionId = normalizeOptionalString(body.sessionId);
    if (!sessionId) {
      throw new GatewayRequestError(400, 'Expected non-empty `sessionId`.');
    }
    const response = parseOperatorReturn(body.response);
    const text = normalizeOptionalString(body.text);
    const result = response
      ? { response, session: resumeWith(sessionId, response) }
      : text
        ? resumeWithText(sessionId, text)
        : null;
    if (!result) {
      throw new GatewayRequestError(
        400,
        'Expected `response` object or typed reply `text`.',
      );
    }
    broadcastSseEvent(activeSseResponses, 'interaction_response', result);
    sendJson(res, 200, result);
  } catch (error) {
    sendApiInteractiveError(res, error);
  }
}

async function handleApiConsumeInteractiveEscalation(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readInteractiveBody(req);
    const sessionId = normalizeOptionalString(body.sessionId);
    if (!sessionId) {
      throw new GatewayRequestError(400, 'Expected non-empty `sessionId`.');
    }
    const response = consumeOperatorReturn(sessionId);
    if (!response) {
      throw new GatewayRequestError(
        404,
        'No operator response is available for this suspended session.',
      );
    }
    sendJson(res, 200, { response });
  } catch (error) {
    sendApiInteractiveError(res, error);
  }
}

async function handleApiSmsReplyInteractiveEscalation(
  req: IncomingMessage,
  res: ServerResponse,
  activeSseResponses: Set<ServerResponse>,
): Promise<void> {
  try {
    const body = await readInteractiveBody(req);
    const from = normalizeOptionalString(body.from);
    const text = normalizeOptionalString(body.text ?? body.body);
    if (!text) {
      throw new GatewayRequestError(400, 'Expected SMS reply `text`.');
    }
    const sessionId = normalizeOptionalString(body.sessionId);
    if (!sessionId && !from) {
      throw new GatewayRequestError(
        400,
        'Expected non-empty `sessionId` or `from` for SMS reply matching.',
      );
    }
    if (!sessionId && from && /\s/.test(from)) {
      throw new GatewayRequestError(
        400,
        'Expected a valid SMS reply `from` value.',
      );
    }
    const session = sessionId
      ? null
      : findPendingSuspendedSessionForOperator({
          userId: from,
          modality: 'sms',
        });
    const targetSessionId = sessionId || session?.sessionId || '';
    if (!targetSessionId) {
      throw new GatewayRequestError(
        404,
        'No pending SMS suspended session matched this reply.',
      );
    }
    const parsed = parseOperatorReturnText(text, ['code', 'declined']);
    if (!parsed) {
      throw new GatewayRequestError(400, 'Could not parse SMS reply.');
    }
    const resumed = resumeWith(targetSessionId, parsed);
    const result = { response: parsed, session: resumed };
    broadcastSseEvent(activeSseResponses, 'interaction_response', result);
    sendJson(res, 200, result);
  } catch (error) {
    sendApiInteractiveError(res, error);
  }
}

async function handleApiCreateInteractiveEscalation(
  req: IncomingMessage,
  res: ServerResponse,
  activeSseResponses: Set<ServerResponse>,
): Promise<void> {
  try {
    const body = await readInteractiveBody(req);
    const modality = parseInteractionModality(body.modality);
    const prompt = normalizeOptionalString(body.prompt);
    if (!prompt) {
      throw new GatewayRequestError(400, 'Expected non-empty `prompt`.');
    }
    const escalationTarget =
      body.escalationTarget &&
      typeof body.escalationTarget === 'object' &&
      !Array.isArray(body.escalationTarget)
        ? (body.escalationTarget as { channel: string; recipient: string })
        : undefined;
    const userId =
      normalizeOptionalString(body.userId) ||
      escalationTarget?.recipient ||
      'operator';
    const session = createSuspendedSession({
      sessionId: normalizeOptionalString(body.sessionId) || undefined,
      approvalId: normalizeOptionalString(body.approvalId) || undefined,
      prompt,
      userId,
      modality,
      frameSnapshot: parseInteractionFrameSnapshot(body.frameSnapshot),
      context:
        body.context && typeof body.context === 'object'
          ? (body.context as Record<string, string | null>)
          : {},
      agentId: normalizeOptionalString(body.agentId) || null,
      skillId: normalizeOptionalString(body.skillId) || null,
      escalationTarget,
      ttlMs:
        typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs)
          ? body.ttlMs
          : null,
      artifacts: {
        screenshotBase64: normalizeOptionalString(body.screenshotBase64),
      },
    });
    emitInteractionNeededEvent({ session });
    const notification = queueInteractionNotification(session);
    const payload = { session, notification };
    broadcastSseEvent(activeSseResponses, 'interaction_needed', payload);
    sendJson(res, 200, payload);
  } catch (error) {
    sendApiInteractiveError(res, error);
  }
}

function sendApiAdminPolicyError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, error instanceof GatewayRequestError ? error.statusCode : 400, {
    error: message,
  });
}

async function handleApiAdminPolicy(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';

  if (method === 'PUT') {
    try {
      const body = (await readJsonBody(req)) as ApiAdminPolicyRequestBody;
      if (body.presetName !== undefined) {
        const presetName = normalizeOptionalString(body.presetName);
        if (!presetName) {
          throw new GatewayRequestError(
            400,
            'Expected non-empty `presetName`.',
          );
        }
        sendJson(
          res,
          200,
          applyGatewayAdminPolicyPreset({
            agentId: normalizeOptionalString(body.agentId),
            presetName,
          }),
        );
        return;
      }
      if (body.defaultAction !== undefined) {
        const rawDefaultAction = String(body.defaultAction || '')
          .trim()
          .toLowerCase();
        if (rawDefaultAction !== 'allow' && rawDefaultAction !== 'deny') {
          throw new GatewayRequestError(
            400,
            'Expected `defaultAction` to be `allow` or `deny`.',
          );
        }
        sendJson(
          res,
          200,
          saveGatewayAdminPolicyDefault({
            agentId: normalizeOptionalString(body.agentId),
            defaultAction: rawDefaultAction,
          }),
        );
        return;
      }
      if (body.lanHttpAccessMode !== undefined) {
        const mode = String(body.lanHttpAccessMode || '')
          .trim()
          .toLowerCase();
        if (
          mode !== 'off' &&
          mode !== 'read-only' &&
          mode !== 'read-write' &&
          mode !== 'custom'
        ) {
          throw new GatewayRequestError(
            400,
            'Expected `lanHttpAccessMode` to be `off`, `read-only`, `read-write`, or `custom`.',
          );
        }
        sendJson(
          res,
          200,
          saveGatewayAdminPolicyLanHttpAccess({
            agentId: normalizeOptionalString(body.agentId),
            mode,
          }),
        );
        return;
      }
      sendJson(
        res,
        200,
        saveGatewayAdminPolicyRule({
          agentId: normalizeOptionalString(body.agentId),
          ...(body.index === undefined
            ? {}
            : { index: parseApiAdminPolicyIndex(body.index) }),
          rule: parseApiAdminPolicyRuleInput(body.rule),
        }),
      );
    } catch (error) {
      sendApiAdminPolicyError(res, error);
    }
    return;
  }

  if (method === 'DELETE') {
    try {
      sendJson(
        res,
        200,
        deleteGatewayAdminPolicyRule({
          agentId: url.searchParams.get('agentId') || '',
          index: parseApiAdminPolicyIndex(url.searchParams.get('index')),
        }),
      );
    } catch (error) {
      sendApiAdminPolicyError(res, error);
    }
    return;
  }

  sendMethodNotAllowed(res);
}

async function handleApiAdminTools(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getGatewayAdminTools());
}

async function handleApiAdminPlugins(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getGatewayAdminPlugins());
}

async function handleApiAdminOutputGuard(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method || 'GET';

  if (method === 'GET') {
    sendJson(res, 200, getGatewayAdminOutputGuardProfile());
    return;
  }

  if (method === 'PUT') {
    try {
      sendJson(
        res,
        200,
        await updateGatewayAdminOutputGuardProfile(await readJsonBody(req)),
      );
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  sendMethodNotAllowed(res);
}

async function handleApiAdminOutputGuardPreview(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }

  try {
    sendJson(
      res,
      200,
      await previewGatewayAdminOutputGuardProfile(await readJsonBody(req)),
    );
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApiAdminSkills(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method || 'GET';

  if (method === 'GET') {
    sendJson(res, 200, getGatewayAdminSkills());
    return;
  }

  if (method === 'POST') {
    const body = (await readJsonBody(req)) as {
      name?: unknown;
      description?: unknown;
      category?: unknown;
      shortDescription?: unknown;
      userInvocable?: unknown;
      disableModelInvocation?: unknown;
      tags?: unknown;
      body?: unknown;
      files?: unknown;
    };
    if (body.files != null && !Array.isArray(body.files)) {
      sendJson(res, 400, {
        error:
          'Expected `files` to be an array of objects with string `path` and optional string `content`.',
      });
      return;
    }
    const files = Array.isArray(body.files)
      ? body.files.map((file) => {
          if (
            file == null ||
            typeof file !== 'object' ||
            Array.isArray(file) ||
            typeof (file as Record<string, unknown>).path !== 'string'
          ) {
            throw new GatewayRequestError(
              400,
              'Expected each skill file to be an object with string `path` and optional string `content`.',
            );
          }
          const content = (file as Record<string, unknown>).content;
          if (content != null && typeof content !== 'string') {
            throw new GatewayRequestError(
              400,
              'Expected each skill file to be an object with string `path` and optional string `content`.',
            );
          }
          return {
            path: file.path,
            content: content ?? '',
          };
        })
      : undefined;
    if (
      files?.some((file) => {
        const filePath = file.path.trim();
        return (
          !filePath || filePath.endsWith('/') || filePath.endsWith(path.sep)
        );
      })
    ) {
      sendJson(res, 400, {
        error: 'Skill file paths must be non-empty and include a filename.',
      });
      return;
    }
    sendJson(
      res,
      201,
      createGatewayAdminSkill({
        name: String(body.name || ''),
        description: String(body.description || ''),
        category: String(body.category || ''),
        shortDescription: String(body.shortDescription || ''),
        userInvocable:
          typeof body.userInvocable === 'boolean'
            ? body.userInvocable
            : undefined,
        disableModelInvocation:
          typeof body.disableModelInvocation === 'boolean'
            ? body.disableModelInvocation
            : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        body: String(body.body || ''),
        files,
      }),
    );
    return;
  }

  if (method !== 'PUT') {
    sendJson(res, 405, { error: `Method ${method} is not allowed.` });
    return;
  }

  const body = (await readJsonBody(req)) as {
    name?: unknown;
    enabled?: unknown;
    channel?: unknown;
  };
  if (typeof body.enabled !== 'boolean') {
    sendJson(res, 400, {
      error: 'Expected boolean `enabled` in request body.',
    });
    return;
  }
  if (body.channel != null && typeof body.channel !== 'string') {
    sendJson(res, 400, {
      error: 'Expected string `channel` in request body.',
    });
    return;
  }
  sendJson(
    res,
    200,
    setGatewayAdminSkillEnabled({
      name: String(body.name || ''),
      enabled: body.enabled,
      channel: typeof body.channel === 'string' ? body.channel : undefined,
    }),
  );
}

function sendApiAdminSkillPackageError(
  res: ServerResponse,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, error instanceof GatewayRequestError ? error.statusCode : 400, {
    error: message,
  });
}

async function handleApiAdminSkillPackageFiles(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  const segments = url.pathname.split('/').filter(Boolean);
  const skillName = segments[3] ? decodeApiPathSegment(segments[3]).trim() : '';
  const hasInvocationsPrefix = segments[4] === 'invocations';
  const hasFilesPrefix = segments[4] === 'files';
  const action = segments[5] || '';

  if (!skillName || (!hasInvocationsPrefix && !hasFilesPrefix)) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  if (segments.length === 5 && hasInvocationsPrefix) {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    const parsedLimit = Number.parseInt(
      url.searchParams.get('limit') || '',
      10,
    );
    try {
      sendJson(
        res,
        200,
        getGatewayAdminSkillInvocations(skillName, { limit: parsedLimit }),
      );
    } catch (error) {
      sendApiAdminSkillPackageError(res, error);
    }
    return;
  }

  if (segments.length === 5) {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    try {
      sendJson(res, 200, getGatewayAdminSkillPackageFiles(skillName));
    } catch (error) {
      sendApiAdminSkillPackageError(res, error);
    }
    return;
  }

  if (segments.length === 6 && action === 'content') {
    const filePath = url.searchParams.get('path') || '';
    if (!filePath) {
      sendJson(res, 400, { error: 'Missing skill file path.' });
      return;
    }

    if (method === 'GET') {
      try {
        sendJson(
          res,
          200,
          getGatewayAdminSkillPackageFile({ skillName, path: filePath }),
        );
      } catch (error) {
        sendApiAdminSkillPackageError(res, error);
      }
      return;
    }

    if (method === 'PUT') {
      try {
        const body = (await readJsonBody(req)) as { content?: unknown };
        if (typeof body.content !== 'string') {
          throw new GatewayRequestError(
            400,
            'Expected string `content` in request body.',
          );
        }
        sendJson(
          res,
          200,
          saveGatewayAdminSkillPackageFile({
            skillName,
            path: filePath,
            content: body.content,
          }),
        );
      } catch (error) {
        sendApiAdminSkillPackageError(res, error);
      }
      return;
    }

    sendMethodNotAllowed(res);
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
}

async function handleApiAdminSkillUnblock(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method || 'GET';
  if (method !== 'POST') {
    sendJson(res, 405, { error: `Method ${method} is not allowed.` });
    return;
  }

  const body = (await readJsonBody(req)) as {
    name?: unknown;
  };
  sendJson(
    res,
    200,
    unblockGatewayAdminSkill({
      name: String(body.name || ''),
    }),
  );
}

function handleApiAdminAgentScoreboard(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAdminAgentScoreboard());
}

const MAX_DISTILL_SOURCE_UPLOAD_BYTES = 20 * 1024 * 1024;
const ADMIN_DISTILL_CORPUS_PATH_PREFIX = '/api/admin/distill/corpus/';

async function handleApiAdminDistill(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (pathname.startsWith(ADMIN_DISTILL_CORPUS_PATH_PREFIX)) {
    const rawDocumentId = pathname.slice(
      ADMIN_DISTILL_CORPUS_PATH_PREFIX.length,
    );
    let documentId = rawDocumentId;
    try {
      documentId = decodeURIComponent(rawDocumentId);
    } catch {
      sendJson(res, 400, { error: 'Invalid corpus document id.' });
      return;
    }

    if (method === 'GET') {
      const download = getGatewayAdminDistillCorpusDocument({
        agentId: url.searchParams.get('agentId') || undefined,
        alias: url.searchParams.get('alias') || undefined,
        documentId,
      });
      const body = Buffer.from(download.content, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${download.filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      return;
    }

    if (method === 'DELETE') {
      sendJson(res, 200, {
        subject: deleteGatewayAdminDistillCorpusDocument({
          agentId: url.searchParams.get('agentId') || undefined,
          alias: url.searchParams.get('alias') || undefined,
          documentId,
        }),
      });
      return;
    }

    sendJson(res, 405, { error: `Method ${method} is not allowed.` });
    return;
  }

  if (pathname === '/api/admin/distill' && method === 'GET') {
    sendJson(res, 200, getGatewayAdminDistill());
    return;
  }

  if (pathname === '/api/admin/distill/subjects' && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 201, {
      subject: upsertGatewayAdminDistillSubject(
        body && typeof body === 'object' ? body : {},
      ),
    });
    return;
  }

  if (pathname === '/api/admin/distill/consent' && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 201, {
      subject: recordGatewayAdminDistillConsent(
        body && typeof body === 'object' ? body : {},
      ),
    });
    return;
  }

  if (pathname === '/api/admin/distill/register' && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 201, {
      subject: registerGatewayAdminDistillAgent(
        body && typeof body === 'object' ? body : {},
      ),
    });
    return;
  }

  if (pathname === '/api/admin/distill/runs' && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(
      res,
      200,
      runGatewayAdminDistillPipeline(
        body && typeof body === 'object' ? body : {},
      ),
    );
    return;
  }

  if (pathname === '/api/admin/distill/sources/upload' && method === 'POST') {
    const encodedFilename = normalizeHeaderValue(
      req.headers['x-hybridclaw-filename'],
    );
    if (!encodedFilename) {
      sendJson(res, 400, {
        error: 'Missing `X-Hybridclaw-Filename` header.',
      });
      return;
    }
    let filename = encodedFilename;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      sendJson(res, 400, {
        error: 'Invalid `X-Hybridclaw-Filename` header.',
      });
      return;
    }
    const buffer = await readRequestBody(req, MAX_DISTILL_SOURCE_UPLOAD_BYTES);
    sendJson(
      res,
      201,
      await uploadGatewayAdminDistillSource({
        agentId: url.searchParams.get('agentId') || undefined,
        alias: url.searchParams.get('alias') || undefined,
        kind: url.searchParams.get('kind') || undefined,
        filename,
        buffer,
      }),
    );
    return;
  }

  sendJson(res, pathname === '/api/admin/distill' ? 405 : 404, {
    error:
      pathname === '/api/admin/distill' ? 'Method Not Allowed' : 'Not Found',
  });
}

const MAX_SKILL_ZIP_UPLOAD_BYTES = 10 * 1024 * 1024;

async function handleApiAdminSkillUpload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method || 'GET';
  if (method !== 'POST') {
    sendJson(res, 405, { error: `Method ${method} is not allowed.` });
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const force = url.searchParams.get('force') === 'true';

  try {
    const buffer = await readRequestBody(req, MAX_SKILL_ZIP_UPLOAD_BYTES);
    if (buffer.length === 0) {
      sendJson(res, 400, {
        error: 'Expected a non-empty skill zip upload body.',
      });
      return;
    }
    sendJson(res, 201, await uploadGatewayAdminSkillZip(buffer, { force }));
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      const message =
        error.statusCode === 413
          ? `Skill zip upload exceeds the maximum size of ${MAX_SKILL_ZIP_UPLOAD_BYTES} bytes.`
          : error.message;
      sendJson(res, error.statusCode, { error: message });
      return;
    }
    throw error;
  }
}

function decodeApiPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function handleApiAdaptiveSkills(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const dbModule = await import('../memory/db.js');
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 3) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  if (segments[2] === 'health') {
    if ((req.method || 'GET') !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const inspectionModule = await import('../skills/skills-inspection.js');
    if (segments.length === 3) {
      sendJson(res, 200, { metrics: inspectionModule.inspectAllSkills() });
      return;
    }
    const skillName = decodeApiPathSegment(segments.slice(3).join('/'));
    sendJson(res, 200, { metrics: inspectionModule.inspectSkill(skillName) });
    return;
  }

  if (segments[2] !== 'amendments') {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  if (segments.length === 3) {
    if ((req.method || 'GET') !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    sendJson(res, 200, { amendments: dbModule.getStagedAmendments() });
    return;
  }

  const skillName = decodeApiPathSegment(segments[3] || '');
  if (!skillName) {
    sendJson(res, 400, { error: 'Missing skill name.' });
    return;
  }

  if (segments.length === 4) {
    if ((req.method || 'GET') !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    sendJson(res, 200, { amendments: dbModule.getAmendmentHistory(skillName) });
    return;
  }

  const action = segments[4] || '';
  if ((req.method || 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const body = (await readJsonBody(req)) as { reviewedBy?: unknown };
  const reviewedBy =
    typeof body.reviewedBy === 'string' ? body.reviewedBy.trim() : '';
  if (!reviewedBy) {
    sendJson(res, 400, { error: 'Missing reviewedBy.' });
    return;
  }
  const amendment = dbModule.getLatestSkillAmendment({
    skillName,
    status: 'staged',
  });
  if (!amendment) {
    sendJson(res, 404, {
      error: `No staged amendment found for "${skillName}".`,
    });
    return;
  }

  if (action === 'apply') {
    const amendmentModule = await import('../skills/skills-amendment.js');
    const result = await amendmentModule.applyAmendment({
      amendmentId: amendment.id,
      reviewedBy,
    });
    sendJson(res, result.ok ? 200 : 400, {
      ...result,
      amendmentId: amendment.id,
    });
    return;
  }

  if (action === 'reject') {
    const amendmentModule = await import('../skills/skills-amendment.js');
    const result = amendmentModule.rejectAmendment({
      amendmentId: amendment.id,
      reviewedBy,
    });
    sendJson(res, result.ok ? 200 : 400, {
      ...result,
      amendmentId: amendment.id,
    });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
}

async function handleApiAdminHarnessEvolution(
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const targetRoot = (url.searchParams.get('targetRoot') || '').trim();
  const summaryPath = (url.searchParams.get('summaryPath') || '').trim();
  const manifestPath = (url.searchParams.get('manifestPath') || '').trim();
  if (!targetRoot) {
    sendJson(res, 400, { error: 'Missing targetRoot query parameter.' });
    return;
  }

  const root = path.resolve(targetRoot);
  if (!(await isAllowedHarnessEvolutionRoot(root))) {
    sendJson(res, 403, {
      error:
        'targetRoot is not under an allowed harness evolution root. Set HYBRIDCLAW_HARNESS_EVOLUTION_ROOTS or use the runtime data harness-evolution directory.',
    });
    return;
  }
  try {
    const evolution = await import('../evolution/harness-evolution.js');
    if (manifestPath) {
      await assertPathInsideRoot(root, manifestPath);
      sendJson(res, 200, {
        manifest: evolution.readHarnessEvolutionManifest(manifestPath),
      });
      return;
    }
    if (summaryPath) {
      await assertPathInsideRoot(root, summaryPath);
      sendJson(res, 200, {
        run: evolution.readHarnessEvolutionSummary(summaryPath),
      });
      return;
    }
    sendJson(res, 200, evolution.listHarnessEvolutionRuns(root));
  } catch (error) {
    sendJson(
      res,
      error instanceof GatewayRequestError ? error.statusCode : 400,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function assertPathInsideRoot(
  root: string,
  candidate: string,
): Promise<void> {
  const rootReal = await fs.promises.realpath(root);
  const candidatePath = path.resolve(candidate);
  try {
    await fs.promises.access(candidatePath);
  } catch {
    throw new GatewayRequestError(400, 'Requested path does not exist.');
  }
  const candidateReal = await fs.promises.realpath(candidatePath);
  if (!isPathInsideRoot(rootReal, candidateReal)) {
    throw new GatewayRequestError(400, 'Requested path is outside targetRoot.');
  }
}

async function isAllowedHarnessEvolutionRoot(
  targetRoot: string,
): Promise<boolean> {
  const [resolvedTargetRoot, allowedRoots] = await Promise.all([
    resolveHarnessEvolutionAccessPathForRequest(targetRoot),
    getResolvedHarnessEvolutionAllowedRoots(),
  ]);
  return allowedRoots.some((root) =>
    isPathInsideRoot(root, resolvedTargetRoot),
  );
}

function getResolvedHarnessEvolutionAllowedRoots(): Promise<string[]> {
  resolvedHarnessEvolutionAllowedRootsPromise ??= Promise.all(
    HARNESS_EVOLUTION_ALLOWED_ROOTS.map((root) =>
      resolveHarnessEvolutionAccessPathForRequest(root),
    ),
  );
  return resolvedHarnessEvolutionAllowedRootsPromise;
}

async function resolveHarnessEvolutionAccessPathForRequest(
  candidate: string,
): Promise<string> {
  const resolved = path.resolve(candidate);
  try {
    return await fs.promises.realpath(resolved);
  } catch {
    return resolved;
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function handleApiEvents(
  req: IncomingMessage,
  res: ServerResponse,
  activeSseResponses: Set<ServerResponse>,
): void {
  const sendEvent = (event: string, payload: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  activeSseResponses.add(res);

  const sendSnapshot = async (): Promise<void> => {
    try {
      sendEvent('overview', await getGatewayAdminOverview());
      sendEvent('status', await getGatewayStatus());
    } catch (err) {
      logger.debug({ err }, 'SSE snapshot failed');
    }
  };

  void sendSnapshot();
  const timer = setInterval(() => {
    void sendSnapshot();
  }, 10_000);

  req.on('close', () => {
    clearInterval(timer);
    activeSseResponses.delete(res);
    if (!res.writableEnded) res.end();
  });
}

async function handleApiArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const authContext = resolveAuthContext(req, url, {
    allowLocalWebSession: true,
    allowQueryToken: true,
    allowSessionCookie: true,
  });
  if (authContext.kind === 'none') {
    sendJson(res, 401, {
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass `?token=<WEB_API_TOKEN>`.',
    });
    return;
  }
  if (
    !isApiTokenAllowedForRoute(authContext, url.pathname, req.method || 'GET')
  ) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  const filePath = await resolveArtifactFile(url);
  if (!filePath) {
    sendJson(res, 404, { error: 'Artifact not found.' });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  streamStaticFile(res, filePath, {
    dispositionType: SAFE_INLINE_ARTIFACT_MIME_TYPES[ext]
      ? 'inline'
      : 'attachment',
  });
}

/**
 * Parse `/api/apps/<id>` (or `/api/apps/<id><suffix>`, e.g. `/view`) into the
 * app id. Returns null for non-matching paths or malformed ids rather than
 * throwing, so it is safe to call from the pre-auth dispatch section.
 */
function parseApiAppId(pathname: string, suffix = ''): string | null {
  const prefix = '/api/apps/';
  if (!pathname.startsWith(prefix)) return null;
  let rest = pathname.slice(prefix.length);
  if (suffix) {
    if (!rest.endsWith(suffix)) return null;
    rest = rest.slice(0, rest.length - suffix.length);
  }
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

function parsePublicationShellToken(pathname: string): string | null {
  const prefix = '/pub/';
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

function parsePublicationSessionToken(pathname: string): string | null {
  const prefix = '/api/pub/';
  const suffix = '/session';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const rest = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

function parseApiAppPublicationsCollectionPath(
  pathname: string,
): string | null {
  return parseApiAppId(pathname, '/publications');
}

function parseApiAppPublicationItemPath(
  pathname: string,
): { appId: string; publicationId: string } | null {
  const prefix = '/api/apps/';
  const marker = '/publications/';
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const markerIndex = rest.indexOf(marker);
  if (markerIndex === -1) return null;
  const rawAppId = rest.slice(0, markerIndex);
  const rawPublicationId = rest.slice(markerIndex + marker.length);
  if (!rawAppId || !rawPublicationId || rawPublicationId.includes('/')) {
    return null;
  }
  try {
    return {
      appId: decodeURIComponent(rawAppId),
      publicationId: decodeURIComponent(rawPublicationId),
    };
  } catch {
    return null;
  }
}

function parseTeamsTabAppPublicationPath(pathname: string): string | null {
  const prefix = '/api/teams/tab/apps/';
  const suffix = '/publication';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const rawAppId = pathname.slice(
    prefix.length,
    pathname.length - suffix.length,
  );
  if (!rawAppId || rawAppId.includes('/')) return null;
  try {
    return decodeURIComponent(rawAppId);
  } catch {
    return null;
  }
}

type LiveAppBridgeToolRunResult =
  | {
      status: 'success';
      toolName: string;
      result: string;
      toolExecutions: ToolExecution[];
    }
  | {
      status: 'pending_approval';
      pendingApproval: PendingApproval;
      toolExecutions: ToolExecution[];
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializePublicationPolicy(policy: AppPublicationPolicy): {
  kind: AppPublicationPolicy['kind'];
  ttlSeconds?: number;
  provider?: string;
} {
  return {
    kind: policy.kind,
    ...(policy.ttlSeconds ? { ttlSeconds: policy.ttlSeconds } : {}),
    ...(policy.kind === 'oidc' ? { provider: policy.provider } : {}),
  };
}

function serializePublication(
  publication: AppPublicationMetadata,
): Record<string, unknown> {
  return {
    id: publication.id,
    appId: publication.appId,
    policy: serializePublicationPolicy(publication.policy),
    embedHosts: publication.embedHosts,
    allowBridge: publication.allowBridge,
    label: publication.label,
    createdAt: publication.created_at,
    createdBy: publication.created_by,
    expiresAt: publication.expires_at,
    revokedAt: publication.revoked_at,
  };
}

function resolvePublicationCreatedBy(
  authContext: ResolvedAuthContext,
): string | null {
  return (
    resolveApiTokenActor(authContext) ||
    resolveAdminSessionActor(authContext.payload)
  );
}

function buildPublicationUrl(req: IncomingMessage, token: string): string {
  return `${resolveRequestOrigin(req)}/pub/${encodeURIComponent(token)}`;
}

function buildPublicationUrlWithOrigin(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/pub/${encodeURIComponent(token)}`;
}

function buildTeamsPublicationUrl(origin: string, token: string): string {
  const url = new URL(buildPublicationUrlWithOrigin(origin, token));
  url.searchParams.set('host', 'teams');
  return url.toString();
}

function mergeUniqueStrings(...groups: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const value of group) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function resolveTeamsTabSsoForRequest(req: IncomingMessage): {
  origin: string;
  tabConfig: MSTeamsTabSsoConfig;
} {
  const origin = resolveRequestOrigin(req);
  const tabConfig = resolveMSTeamsTabConfig(getRuntimeConfig(), origin);
  if (!tabConfig.enabled) {
    throw new GatewayRequestError(400, 'Teams tab SSO is not enabled.');
  }
  if (!tabConfig.tenantId) {
    throw new GatewayRequestError(400, 'Teams tenant ID is not configured.');
  }
  if (!tabConfig.ssoAppId) {
    throw new GatewayRequestError(
      400,
      'Teams tab SSO app ID is not configured.',
    );
  }
  if (!tabConfig.appIdUri && !tabConfig.ssoAppId) {
    throw new GatewayRequestError(
      400,
      'Teams tab SSO app ID or App ID URI is not configured.',
    );
  }
  if (!tabConfig.appIdUri) {
    throw new GatewayRequestError(
      400,
      'Teams tab App ID URI is not configured.',
    );
  }
  return { origin, tabConfig };
}

function buildPublicationOidcChallenge(
  req: IncomingMessage,
  publication: AppPublicationMetadata,
): Record<string, string> {
  if (publication.policy.kind !== 'oidc') {
    throw new GatewayRequestError(400, 'Publication is not OIDC protected.');
  }
  const { origin, tabConfig } = resolveTeamsTabSsoForRequest(req);
  return {
    authorizationEndpoint: `https://login.microsoftonline.com/${encodeURIComponent(
      publication.policy.tenantId,
    )}/oauth2/v2.0/authorize`,
    clientId: tabConfig.ssoAppId,
    redirectUri: new URL(APP_PUBLICATION_OIDC_CALLBACK_PATH, origin).toString(),
    scope: `openid profile ${publication.policy.audience.replace(
      /\/+$/,
      '',
    )}/${TEAMS_TAB_SCOPE}`,
  };
}

function buildTeamsOidcPolicy(
  tabConfig: MSTeamsTabSsoConfig,
  allowFrom: string[] = [],
  ttlSeconds?: number,
): Extract<AppPublicationPolicy, { kind: 'oidc' }> {
  return {
    kind: 'oidc',
    provider: 'entra',
    tenantId: tabConfig.tenantId,
    audience: tabConfig.appIdUri,
    allowFrom,
    ...(ttlSeconds ? { ttlSeconds } : {}),
  };
}

function parsePublicationCreatePolicy(
  body: Record<string, unknown>,
  options: { req: IncomingMessage },
): AppPublicationPolicy {
  const kind = String(body.kind || body.policy || 'link').trim();
  const ttlSeconds =
    typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined;
  if (kind === 'link') {
    return { kind: 'link', ...(ttlSeconds ? { ttlSeconds } : {}) };
  }
  if (kind === 'password') {
    const password = typeof body.password === 'string' ? body.password : '';
    const policy = createPasswordPublicationPolicy(password);
    return { ...policy, ...(ttlSeconds ? { ttlSeconds } : {}) };
  }
  if (kind === 'company' || kind === 'teams' || kind === 'oidc') {
    const { tabConfig } = resolveTeamsTabSsoForRequest(options.req);
    return buildTeamsOidcPolicy(
      tabConfig,
      parseStringArrayBodyField(body.allowFrom, 'allowFrom'),
      ttlSeconds,
    );
  }
  throw new GatewayRequestError(400, 'Unsupported publication audience.');
}

function parseStringArrayBodyField(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new GatewayRequestError(400, `\`${name}\` must be an array.`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new GatewayRequestError(400, `\`${name}\` must be an array.`);
    }
    return entry;
  });
}

function truncateTeamsText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd();
}

function zipToBuffer(zipFile: yazl.ZipFile): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zipFile.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zipFile.outputStream.once('error', reject);
    zipFile.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    zipFile.end();
  });
}

function isTeamsFrameHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return TEAMS_FRAME_ANCESTORS.some(
    (ancestor) => ancestor.toLowerCase() === normalized,
  );
}

function isTeamsCapablePublication(
  publication: AppPublicationMetadata,
): boolean {
  return (
    !publication.revoked_at &&
    publication.policy.kind === 'oidc' &&
    publication.policy.provider === 'entra' &&
    publication.embedHosts.some(isTeamsFrameHost)
  );
}

function selectTeamsCapablePublication(
  appId: string,
  viewer?: MSTeamsTabViewer | null,
): AppPublicationMetadata | null {
  for (const publication of listPublicationsForApp(appId)) {
    if (!isTeamsCapablePublication(publication)) continue;
    if (
      viewer &&
      publication.policy.kind === 'oidc' &&
      !isMSTeamsTabViewerAllowed(viewer, publication.policy.allowFrom)
    ) {
      continue;
    }
    return publication;
  }
  return null;
}

function createTeamsPublicationForApp(params: {
  req: IncomingMessage;
  app: StoredApp;
  allowBridge?: boolean;
  label?: string | null;
  createdBy?: string | null;
}): { token: string; publication: AppPublicationMetadata; url: string } {
  const { origin, tabConfig } = resolveTeamsTabSsoForRequest(params.req);
  const result = createPublication({
    appId: params.app.id,
    policy: buildTeamsOidcPolicy(tabConfig),
    embedHosts: [...TEAMS_FRAME_ANCESTORS],
    allowBridge: params.app.kind === 'live' && params.allowBridge === true,
    label: params.label ?? 'Teams',
    createdBy: params.createdBy ?? null,
  });
  return {
    token: result.token,
    publication: result.metadata,
    url: buildTeamsPublicationUrl(origin, result.token),
  };
}

function teamsSafeEntityId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'app';
}

function buildTeamsDeveloper(origin: string): Record<string, string> {
  return {
    name: 'HybridClaw',
    websiteUrl: origin,
    privacyUrl: new URL('/docs', origin).toString(),
    termsOfUseUrl: new URL('/docs', origin).toString(),
  };
}

function buildTeamsManifestZip(
  manifest: Record<string, unknown>,
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify(manifest, null, 2)),
    'manifest.json',
  );
  zip.addBuffer(fs.readFileSync(TEAMS_COLOR_ICON_PATH), 'color.png');
  zip.addBuffer(fs.readFileSync(TEAMS_OUTLINE_ICON_PATH), 'outline.png');
  return zipToBuffer(zip);
}

function buildTeamsAppManifest(params: {
  app: StoredApp;
  publication: AppPublicationMetadata;
  contentUrl: string;
  origin: string;
  tabConfig: MSTeamsTabSsoConfig;
}): Record<string, unknown> {
  const domain = new URL(params.origin).hostname;
  const title = params.app.title.trim() || 'HybridClaw App';
  const shortName = truncateTeamsText(title, 30) || 'HybridClaw App';
  const tabName = truncateTeamsText(title, 16) || 'HybridClaw';
  const description =
    params.app.description?.trim() || `Open ${title} in HybridClaw.`;
  return {
    $schema:
      'https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json',
    manifestVersion: '1.19',
    version: '1.0.0',
    id: uuidv5(params.publication.id, TEAMS_MANIFEST_UUID_NAMESPACE),
    developer: buildTeamsDeveloper(params.origin),
    name: {
      short: shortName,
      full: truncateTeamsText(`HybridClaw: ${title}`, 100),
    },
    description: {
      short: truncateTeamsText(description, 80),
      full: truncateTeamsText(description, 4000),
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#1F6F5C',
    staticTabs: [
      {
        entityId: `hc-app-${teamsSafeEntityId(params.app.id)}`,
        name: tabName,
        contentUrl: params.contentUrl,
        scopes: ['personal'],
      },
    ],
    validDomains: [domain],
    webApplicationInfo: {
      id: params.tabConfig.ssoAppId,
      resource: params.tabConfig.appIdUri,
    },
  };
}

function buildTeamsOrgManifest(params: {
  origin: string;
  tabConfig: MSTeamsTabSsoConfig;
}): Record<string, unknown> {
  const domain = new URL(params.origin).hostname;
  return {
    $schema:
      'https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json',
    manifestVersion: '1.19',
    version: '1.0.0',
    id: uuidv5(`${params.origin}:teams-org-app`, TEAMS_MANIFEST_UUID_NAMESPACE),
    developer: buildTeamsDeveloper(params.origin),
    name: {
      short: 'HybridClaw',
      full: 'HybridClaw Apps',
    },
    description: {
      short: 'Open shared HybridClaw apps in Microsoft Teams.',
      full: 'Open and place shared HybridClaw apps from Microsoft Teams.',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#1F6F5C',
    staticTabs: [
      {
        entityId: TEAMS_APP_ENTITY_ID,
        name: 'HybridClaw',
        contentUrl: new URL('/teams/hub?host=teams', params.origin).toString(),
        scopes: ['personal'],
      },
    ],
    configurableTabs: [
      {
        configurationUrl: new URL(
          '/teams/tab-config?host=teams',
          params.origin,
        ).toString(),
        canUpdateConfiguration: true,
        scopes: ['team', 'groupChat'],
      },
    ],
    validDomains: [domain],
    webApplicationInfo: {
      id: params.tabConfig.ssoAppId,
      resource: params.tabConfig.appIdUri,
    },
  };
}

function readViewerContext(
  payload: Record<string, unknown> | null,
): { sub: string; email?: string; name?: string } | null {
  const viewer = payload?.viewer;
  if (!isJsonObject(viewer)) return null;
  const sub = typeof viewer.sub === 'string' ? viewer.sub.trim() : '';
  if (!sub) return null;
  const email = typeof viewer.email === 'string' ? viewer.email.trim() : '';
  const name = typeof viewer.name === 'string' ? viewer.name.trim() : '';
  return {
    sub,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

function isAsciiAlphanumericCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isLiveAppBridgeToolNameSegment(segment: string): boolean {
  if (!segment) return false;
  if (!isAsciiAlphanumericCode(segment.charCodeAt(0))) return false;
  for (let index = 1; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (!isAsciiAlphanumericCode(code) && code !== 95 && code !== 45) {
      return false;
    }
  }
  return true;
}

function isLiveAppBridgeToolName(toolName: string): boolean {
  if (toolName.length > LIVE_APP_BRIDGE_MAX_TOOL_NAME_LENGTH) return false;
  const segments = toolName.split('__');
  return segments.length >= 2 && segments.every(isLiveAppBridgeToolNameSegment);
}

function normalizeLiveAppBridgeToolRequest(body: unknown): {
  toolName: string;
  args: Record<string, unknown>;
} {
  if (!isJsonObject(body)) {
    throw new GatewayRequestError(400, 'Expected JSON object request body.');
  }

  const toolName =
    typeof body.toolName === 'string' ? body.toolName.trim() : '';
  if (!toolName) {
    throw new GatewayRequestError(400, 'Missing `toolName`.');
  }
  if (!isLiveAppBridgeToolName(toolName)) {
    throw new GatewayRequestError(400, 'Invalid MCP tool name.');
  }
  if (!isReadOnlyLiveAppBridgeToolName(toolName)) {
    throw new GatewayRequestError(
      403,
      'Live apps can only call read-only MCP connector tools.',
    );
  }

  const rawArgs = body.arguments ?? body.args ?? {};
  if (!isJsonObject(rawArgs)) {
    throw new GatewayRequestError(400, '`arguments` must be a JSON object.');
  }
  if (
    Buffer.byteLength(JSON.stringify(rawArgs), 'utf8') >
    LIVE_APP_BRIDGE_MAX_ARGS_BYTES
  ) {
    throw new GatewayRequestError(413, '`arguments` is too large.');
  }

  return { toolName, args: rawArgs };
}

function isReadOnlyLiveAppBridgeToolName(toolName: string): boolean {
  const action = toolName.split('__').at(-1)?.toLowerCase() ?? '';
  if (!action) return false;
  const [prefix] = action.split(/[_-]/);
  return Boolean(prefix && LIVE_APP_BRIDGE_READ_ONLY_TOOL_PREFIXES.has(prefix));
}

function buildLiveAppBridgeScript(
  appId: string,
  viewerContext?: { sub: string; email?: string; name?: string } | null,
): string {
  return `<script data-hybridclaw-live-app-bridge="${escapeHtml(appId)}">
(function(){
  var appId = ${JSON.stringify(appId)};
  var viewerContext = ${JSON.stringify(viewerContext ?? null)};
  var pending = new Map();
  var timeoutMs = ${LIVE_APP_BRIDGE_TIMEOUT_MS};
  var refreshHandler = null;

  function nextRequestId(){
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'bridge-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function callTool(toolName, args){
    if (!toolName || typeof toolName !== 'string') {
      return Promise.reject(new Error('toolName must be a non-empty string'));
    }
    if (!window.parent || window.parent === window) {
      return Promise.reject(new Error('HybridClaw live app bridge is unavailable outside the Apps viewer'));
    }
    var requestId = nextRequestId();
    return new Promise(function(resolve, reject){
      var timer = window.setTimeout(function(){
        pending.delete(requestId);
        reject(new Error('HybridClaw live app bridge timed out'));
      }, timeoutMs);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      window.parent.postMessage({
        type: 'hybridclaw:live-app-tool-call',
        appId: appId,
        requestId: requestId,
        toolName: toolName,
        arguments: args || {}
      }, '*');
    });
  }

  function isVisibleRefreshControl(element){
    if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var text = [
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.value || '',
      element.innerText || '',
      element.textContent || ''
    ].join(' ').toLowerCase();
    return /\\b(refresh|reload|aktualisieren)\\b|neu laden/.test(text);
  }

  function clickRefreshControl(){
    var controls = Array.prototype.slice.call(document.querySelectorAll(
      '[data-hybridclaw-refresh], button, [role="button"], input[type="button"], input[type="submit"], a'
    ));
    for (var index = 0; index < controls.length; index += 1) {
      if (isVisibleRefreshControl(controls[index])) {
        controls[index].click();
        return true;
      }
    }
    return false;
  }

  function triggerRefresh(){
    if (typeof refreshHandler === 'function') {
      Promise.resolve().then(function(){ return refreshHandler(); }).catch(function(error){
        console.error('HybridClaw live app refresh failed', error);
      });
      return true;
    }
    var event = new CustomEvent('hybridclaw:refresh', {
      cancelable: true,
      detail: { appId: appId }
    });
    var notCanceled = window.dispatchEvent(event);
    if (!notCanceled) return true;
    return clickRefreshControl();
  }

  window.addEventListener('message', function(event){
    var message = event.data;
    if (!message || message.appId !== appId) return;
    if (message.type === 'hybridclaw:live-app-refresh') {
      var handled = triggerRefresh();
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'hybridclaw:live-app-refresh-result',
          appId: appId,
          ok: handled
        }, '*');
      }
      return;
    }
    if (message.type === 'hybridclaw:live-app-tool-result') {
      if (typeof message.requestId !== 'string') return;
      var entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      window.clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.payload);
      } else {
        entry.reject(new Error(message.error || 'HybridClaw live app bridge call failed'));
      }
    }
  });

  var existing = window.hybridclaw && typeof window.hybridclaw === 'object' ? window.hybridclaw : {};
  existing.callTool = callTool;
  existing.callMcpTool = callTool;
  existing.setRefreshHandler = function(handler){
    if (typeof handler !== 'function') {
      throw new Error('refresh handler must be a function');
    }
    refreshHandler = handler;
    return function(){
      if (refreshHandler === handler) refreshHandler = null;
    };
  };
  existing.refresh = triggerRefresh;
  if (viewerContext) {
    var existingContext = existing.context && typeof existing.context === 'object' ? existing.context : {};
    existing.context = Object.assign({}, existingContext, { user: viewerContext });
  }
  window.hybridclaw = existing;
})();
</script>`;
}

function injectLiveAppBridge(
  html: string,
  app: StoredApp,
  viewerContext?: { sub: string; email?: string; name?: string } | null,
): string {
  if (app.kind !== 'live') return html;
  if (html.includes('data-hybridclaw-live-app-bridge')) return html;

  const script = buildLiveAppBridgeScript(app.id, viewerContext);
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${script}${html.slice(insertAt)}`;
  }

  const htmlMatch = /<html\b[^>]*>/i.exec(html);
  if (htmlMatch?.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, insertAt)}${script}${html.slice(insertAt)}`;
  }

  return `${script}${html}`;
}

function summarizeBridgeToolExecutions(
  toolExecutions: ToolExecution[] | undefined,
): ToolExecution[] {
  return (toolExecutions ?? []).map((execution) => ({
    name: execution.name,
    arguments: execution.arguments,
    result: execution.result,
    durationMs: execution.durationMs,
    ...(execution.isError === undefined ? {} : { isError: execution.isError }),
    ...(execution.blocked === undefined ? {} : { blocked: execution.blocked }),
    ...(execution.blockedReason === undefined
      ? {}
      : { blockedReason: execution.blockedReason }),
    ...(execution.approvalTier === undefined
      ? {}
      : { approvalTier: execution.approvalTier }),
    ...(execution.approvalDecision === undefined
      ? {}
      : { approvalDecision: execution.approvalDecision }),
  }));
}

function buildLiveAppBridgePrompt(params: {
  toolName: string;
  args: Record<string, unknown>;
}): string {
  return [
    'Call exactly this MCP connector tool once and return no extra commentary.',
    `Tool name: ${params.toolName}`,
    `Arguments JSON: ${JSON.stringify(params.args)}`,
  ].join('\n');
}

async function runLiveAppBridgeTool(params: {
  app: StoredApp;
  toolName: string;
  args: Record<string, unknown>;
  viewerSub?: string | null;
}): Promise<LiveAppBridgeToolRunResult> {
  if (!params.app.sessionId) {
    throw new GatewayRequestError(400, 'Live app is not linked to a session.');
  }

  const session = memoryService.getSessionById(params.app.sessionId);
  if (!session) {
    throw new GatewayRequestError(404, 'Live app session not found.');
  }

  const resolved = resolveAgentForRequest({
    agentId: params.app.agentId,
    session,
  });
  const runSession = params.viewerSub
    ? memoryService.getOrCreateSession(
        buildSessionKey(
          resolved.agentId,
          'app',
          'pub',
          `${params.app.id}:${params.viewerSub}`,
        ),
        null,
        'web',
        resolved.agentId,
      )
    : session;
  const chatbotResolution = await resolveGatewayChatbotId({
    model: resolved.model,
    chatbotId: resolved.chatbotId,
    sessionId: runSession.id,
    channelId: 'web',
    agentId: resolved.agentId,
    trigger: 'chat',
  });
  if (chatbotResolution.error) {
    throw new GatewayRequestError(503, chatbotResolution.error);
  }

  const output = await runAgent({
    sessionId: runSession.id,
    agentId: resolved.agentId,
    model: resolved.model,
    chatbotId: chatbotResolution.chatbotId,
    enableRag: runSession.enable_rag === 1,
    channelId: 'web',
    messages: [
      {
        role: 'user',
        content: buildLiveAppBridgePrompt({
          toolName: params.toolName,
          args: params.args,
        }),
      },
    ],
    allowedTools: [params.toolName],
    scheduledTasks: [],
    fullAutoEnabled: false,
    scheduleSideEffectsEnabled: false,
    maxTokens: 512,
    maxWallClockMs: LIVE_APP_BRIDGE_TIMEOUT_MS,
    inactivityTimeoutMs: LIVE_APP_BRIDGE_INACTIVITY_TIMEOUT_MS,
  });

  const toolExecutions = summarizeBridgeToolExecutions(output.toolExecutions);
  if (output.pendingApproval) {
    return {
      status: 'pending_approval',
      pendingApproval: output.pendingApproval,
      toolExecutions,
    };
  }
  if (output.error) {
    throw new GatewayRequestError(502, output.error);
  }

  const execution = [...(output.toolExecutions ?? [])]
    .reverse()
    .find((item) => item.name === params.toolName);
  if (!execution) {
    throw new GatewayRequestError(502, 'Connector tool was not called.');
  }
  if (execution.isError) {
    throw new GatewayRequestError(
      502,
      execution.result || 'Connector tool failed.',
    );
  }

  return {
    status: 'success',
    toolName: params.toolName,
    result: execution.result,
    toolExecutions,
  };
}

async function handleApiAppBridgeTool(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  id: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const authContext = resolveAuthContext(req, url, {
    allowQueryToken: true,
    allowLocalWebSession: true,
    allowSessionCookie: true,
    requireSameOrigin: true,
  });
  if (authContext.kind === 'none') {
    sendJson(res, 401, { error: 'Unauthorized.' });
    return;
  }
  if (
    !isApiTokenAllowedForRoute(authContext, url.pathname, req.method || 'POST')
  ) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  if (!isApiTokenAllowedForApp(authContext, id)) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  const app = getApp(id);
  if (!app) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  if (app.kind !== 'live') {
    sendJson(res, 400, { error: 'App is not a live app.' });
    return;
  }

  try {
    const request = normalizeLiveAppBridgeToolRequest(await readJsonBody(req));
    const viewerContext = readViewerContext(authContext.payload);
    const result = await runLiveAppBridgeTool({
      app,
      ...request,
      viewerSub: viewerContext?.sub ?? null,
    });
    if (result.status === 'pending_approval') {
      sendJson(res, 409, {
        ok: false,
        error: 'Connector tool requires approval.',
        pendingApproval: result.pendingApproval,
        toolExecutions: result.toolExecutions,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      toolName: result.toolName,
      result: result.result,
      text: result.result,
      toolExecutions: result.toolExecutions,
    });
  } catch (err) {
    const statusCode =
      err instanceof GatewayRequestError ? err.statusCode : 500;
    sendJson(res, statusCode, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleApiAppView(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  id: string,
): Promise<void> {
  const authContext = resolveAuthContext(req, url, {
    allowLocalWebSession: true,
    allowQueryToken: true,
    allowSessionCookie: true,
  });
  if (authContext.kind === 'none') {
    sendJson(res, 401, {
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass a valid `?token=`.',
    });
    return;
  }
  if (
    !isApiTokenAllowedForRoute(authContext, url.pathname, req.method || 'GET')
  ) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  if (!isApiTokenAllowedForApp(authContext, id)) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  const app = getApp(id);
  if (!app) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; base-uri 'none'; object-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(
    injectLiveAppBridge(app.html, app, readViewerContext(authContext.payload)),
  );
}

function handleApiAppsList(res: ServerResponse, url: URL): void {
  const category = url.searchParams.get('category') ?? undefined;
  const search =
    url.searchParams.get('q') ?? url.searchParams.get('search') ?? undefined;
  const apps = listApps({
    ...(category ? { category } : {}),
    ...(search ? { search } : {}),
  });
  sendJson(res, 200, { apps, total: apps.length });
}

function handleApiAppDetail(res: ServerResponse, id: string): void {
  const app = getApp(id);
  if (!app) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  sendJson(res, 200, { app });
}

function handleApiAppDelete(res: ServerResponse, id: string): void {
  if (!deleteApp(id)) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  revokePublicationsForApp(id);
  sendJson(res, 200, { ok: true });
}

async function handleApiAppUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new GatewayRequestError(400, 'Expected JSON object request body.');
  }
  const visibility =
    typeof body.visibility === 'string' ? body.visibility.trim() : '';
  if (visibility !== 'private' && visibility !== 'public') {
    throw new GatewayRequestError(
      400,
      '`visibility` must be "private" or "public".',
    );
  }
  const app = updateAppVisibility(id, visibility);
  if (!app) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  if (app.visibility === 'private') {
    revokePublicationsForApp(id);
  }
  sendJson(res, 200, { app });
}

function handleApiAppPublicationsList(
  res: ServerResponse,
  appId: string,
): void {
  if (!getApp(appId)) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  const publications = listPublicationsForApp(appId).map(serializePublication);
  sendJson(res, 200, { publications, total: publications.length });
}

async function handleApiAppPublicationCreate(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  authContext: ResolvedAuthContext,
): Promise<void> {
  const existing = getApp(appId);
  if (!existing) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new GatewayRequestError(400, 'Expected JSON object request body.');
  }
  const requestedKind = String(body.kind || body.policy || 'link').trim();
  const policy = parsePublicationCreatePolicy(body, { req });
  const embedHosts = mergeUniqueStrings(
    parseStringArrayBodyField(body.embedHosts, 'embedHosts'),
    requestedKind === 'teams' ? TEAMS_FRAME_ANCESTORS : [],
  );
  const requestedBridge = body.allowBridge === true;
  if (requestedBridge && existing.kind === 'live') {
    const acknowledged = body.acknowledgeAnonymousBridge === true;
    if (
      (policy.kind === 'link' || policy.kind === 'password') &&
      !acknowledged
    ) {
      throw new GatewayRequestError(
        400,
        'Sharing live data with anonymous viewers requires acknowledgement.',
      );
    }
  }
  const published =
    existing.visibility === 'public'
      ? existing
      : updateAppVisibility(appId, 'public');
  if (!published) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }

  const result = createPublication({
    appId,
    policy,
    embedHosts,
    allowBridge: existing.kind === 'live' && requestedBridge,
    label: typeof body.label === 'string' ? body.label : null,
    createdBy: resolvePublicationCreatedBy(authContext),
    expiresAt:
      typeof body.expiresAt === 'string' || body.expiresAt === null
        ? body.expiresAt
        : undefined,
  });

  sendJson(res, 201, {
    publication: serializePublication(result.metadata),
    token: result.token,
    url:
      requestedKind === 'teams'
        ? buildTeamsPublicationUrl(resolveRequestOrigin(req), result.token)
        : buildPublicationUrl(req, result.token),
    app: published,
  });
}

function handleApiAppPublicationRevoke(
  res: ServerResponse,
  appId: string,
  publicationId: string,
): void {
  if (!getApp(appId)) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  if (
    !listPublicationsForApp(appId).some(
      (publication) => publication.id === publicationId,
    )
  ) {
    sendJson(res, 404, { error: 'Publication not found.' });
    return;
  }
  const publication = revokePublication(publicationId);
  if (!publication) {
    sendJson(res, 404, { error: 'Publication not found.' });
    return;
  }
  sendJson(res, 200, { publication: serializePublication(publication) });
}

function getPublicationSessionRateKey(
  req: IncomingMessage,
  pubToken: string,
): string {
  const tokenId = pubToken.split('_').slice(0, 2).join('_') || 'malformed';
  return `${req.socket.remoteAddress || 'unknown'}:${tokenId}`;
}

function isPublicationSessionRateLimited(key: string): boolean {
  const entry = publicationSessionFailures.get(key);
  if (!entry) return false;
  const now = Date.now();
  if (entry.resetAt <= now) {
    publicationSessionFailures.delete(key);
    return false;
  }
  return entry.count >= APP_PUBLICATION_SESSION_RATE_LIMIT_MAX_FAILURES;
}

function recordPublicationSessionFailure(key: string): void {
  const now = Date.now();
  const existing = publicationSessionFailures.get(key);
  if (!existing || existing.resetAt <= now) {
    publicationSessionFailures.set(key, {
      count: 1,
      resetAt: now + APP_PUBLICATION_SESSION_RATE_LIMIT_WINDOW_MS,
    });
    return;
  }
  existing.count += 1;
}

function clearPublicationSessionFailures(key: string): void {
  publicationSessionFailures.delete(key);
}

function computePublicationViewTokenExpiry(
  publication: AppPublicationMetadata,
  now: Date,
): Date {
  let ttlMs = Math.min(
    getPublicationPolicyTtlMs(publication.policy),
    APP_PUBLICATION_VIEW_TOKEN_DEFAULT_TTL_MS,
  );
  if (publication.expires_at) {
    const publicationExpiresAt = Date.parse(publication.expires_at);
    if (Number.isFinite(publicationExpiresAt)) {
      ttlMs = Math.min(
        ttlMs,
        Math.max(0, publicationExpiresAt - now.getTime()),
      );
    }
  }
  return new Date(now.getTime() + ttlMs);
}

function recordPublicationSessionMint(params: {
  publication: AppPublicationMetadata;
  app: StoredApp;
  policyKind: string;
  sourceIp: string | null;
  viewerSub?: string | null;
}): void {
  try {
    appendAuditEvent({
      sessionId: `app-publication-${params.publication.id}`,
      runId: `pub_${randomUUID().replace(/-/g, '')}`,
      event: {
        type: 'app.publication.session.mint',
        publicationId: params.publication.id,
        appId: params.app.id,
        policyKind: params.policyKind,
        viewerSub: params.viewerSub ?? null,
        sourceIp: params.sourceIp,
      },
    });
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        publicationId: params.publication.id,
        appId: params.app.id,
      },
      'Failed to record app publication session mint audit event',
    );
  }
}

function handlePublicationShell(
  res: ServerResponse,
  pubToken: string,
  url: URL,
): void {
  const verified = verifyPublicationToken(pubToken);
  const isTeamsHost = url.searchParams.get('host') === 'teams';
  const allowedFrameAncestors = mergeUniqueStrings(
    verified.status === 'ok' ? verified.publication.embedHosts : [],
    isTeamsHost ? ["'self'", ...TEAMS_FRAME_ANCESTORS] : [],
  );
  const frameAncestors =
    allowedFrameAncestors.length > 0
      ? allowedFrameAncestors.join(' ')
      : "'none'";
  const scriptSources = mergeUniqueStrings(
    ["'self'"],
    isTeamsHost ? [new URL(TEAMS_JS_SDK_URL).origin] : [],
  );
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src ${scriptSources.join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  const teamsSdkScript = isTeamsHost
    ? `<script src="${escapeHtml(TEAMS_JS_SDK_URL)}"></script>\n`
    : '';
  res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HybridClaw App</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#111827}
html,body,#pub-root{height:100%;margin:0}
body{overflow:hidden}
.pub-shell{display:flex;min-height:100%;flex-direction:column;background:#f6f7f9}
.pub-header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #d8dde5;background:#fff;padding:10px 14px}
.pub-title{margin:0;font-size:14px;font-weight:650;line-height:1.3;color:#111827}
.pub-status{font-size:13px;color:#5b6472}
.pub-main{position:relative;flex:1;min-height:0}
.pub-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}
.pub-panel{box-sizing:border-box;max-width:420px;margin:12vh auto 0;padding:24px;border:1px solid #d8dde5;border-radius:8px;background:#fff;box-shadow:0 20px 60px rgba(15,23,42,.12)}
.pub-panel h1{margin:0 0 8px;font-size:20px;line-height:1.25}
.pub-panel p{margin:0 0 16px;color:#4b5563;line-height:1.5}
.pub-field{display:flex;gap:8px}
.pub-field input{min-width:0;flex:1;border:1px solid #c6ccd6;border-radius:6px;padding:9px 10px;font:inherit}
.pub-field button,.pub-button{border:1px solid #1f6f5c;border-radius:6px;background:#1f6f5c;color:#fff;padding:9px 12px;font:inherit;font-weight:650;cursor:pointer}
.pub-error{margin-top:10px;color:#b42318;font-size:13px}
.pub-banner{display:none;border-bottom:1px solid #f5c2c7;background:#fff3f3;color:#842029;padding:8px 14px;font-size:13px}
.pub-banner[data-visible="true"]{display:block}
@media (prefers-color-scheme:dark){:root{background:#111827;color:#f9fafb}.pub-shell{background:#111827}.pub-header,.pub-panel{background:#161f2e;border-color:#2b3546}.pub-title{color:#f9fafb}.pub-status,.pub-panel p{color:#c7ced8}.pub-frame{background:#111827}.pub-field input{background:#101827;border-color:#374151;color:#f9fafb}}
</style>
${teamsSdkScript}<meta name="teams-host" content="${isTeamsHost ? 'true' : 'false'}">
<script src="${escapeHtml(APP_PUBLICATION_SHELL_SCRIPT_PATH)}" defer></script>
</head>
<body>
<div id="pub-root" class="pub-shell">
  <header class="pub-header">
    <h1 id="pub-title" class="pub-title">HybridClaw App</h1>
    <div id="pub-status" class="pub-status">Loading...</div>
  </header>
  <div id="pub-banner" class="pub-banner"></div>
  <main id="pub-main" class="pub-main">
    <section class="pub-panel"><h1>Opening shared app</h1><p>Preparing a private viewer session.</p></section>
  </main>
</div>
</body>
</html>`);
}

function handlePublicationShellScript(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`(function(){
  var root = document.getElementById('pub-root');
  var main = document.getElementById('pub-main');
  var title = document.getElementById('pub-title');
  var status = document.getElementById('pub-status');
  var banner = document.getElementById('pub-banner');
  var parts = window.location.pathname.split('/');
  var pubToken = decodeURIComponent(parts[parts.length - 1] || '');
  var viewToken = '';
  var app = null;
  var iframe = null;
  var renewalTimer = null;
  var password = '';
  var passwordAttempted = false;
  var isTeamsHost = new URLSearchParams(window.location.search).get('host') === 'teams';
  var teamsAuthToken = '';
  var teamsAuthPromise = null;

  function getBrowserOidcTokenKey(){
    return 'hybridclaw.pub.oidc.token.' + pubToken;
  }
  function getStoredBrowserOidcToken(){
    if (isTeamsHost || !pubToken) return '';
    try {
      return window.sessionStorage.getItem(getBrowserOidcTokenKey()) || '';
    } catch {
      return '';
    }
  }
  function clearStoredBrowserOidcToken(){
    if (!pubToken) return;
    try {
      window.sessionStorage.removeItem(getBrowserOidcTokenKey());
    } catch {}
  }
  function randomBase64Url(length){
    var bytes = new Uint8Array(length);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    var binary = '';
    for (var j = 0; j < bytes.length; j += 1) {
      binary += String.fromCharCode(bytes[j]);
    }
    return window.btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  }
  function startBrowserOidc(oidc){
    if (!oidc || !oidc.authorizationEndpoint || !oidc.clientId || !oidc.redirectUri || !oidc.scope) {
      throw new Error('The sign-in challenge was incomplete.');
    }
    var state = randomBase64Url(24);
    var nonce = randomBase64Url(24);
    try {
      window.sessionStorage.setItem(
        'hybridclaw.pub.oidc.' + state,
        JSON.stringify({ pubToken: pubToken, returnUrl: window.location.href })
      );
    } catch {
      throw new Error('Browser storage is required for sign-in.');
    }
    var authorizeUrl = new URL(oidc.authorizationEndpoint);
    authorizeUrl.searchParams.set('client_id', oidc.clientId);
    authorizeUrl.searchParams.set('response_type', 'token');
    authorizeUrl.searchParams.set('redirect_uri', oidc.redirectUri);
    authorizeUrl.searchParams.set('scope', oidc.scope);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('nonce', nonce);
    authorizeUrl.searchParams.set('prompt', 'select_account');
    setStatus('Signing in...');
    window.location.assign(authorizeUrl.toString());
  }
  function setStatus(text){ if (status) status.textContent = text; }
  function setBanner(text){
    if (!banner) return;
    banner.textContent = text || '';
    banner.dataset.visible = text ? 'true' : 'false';
  }
  function escapeText(value){
    return String(value).replace(/[&<>"']/g, function(ch){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
    });
  }
  function showPanel(heading, detail){
    if (!main) return;
    main.innerHTML = '<section class="pub-panel"><h1>' + escapeText(heading) + '</h1><p>' + escapeText(detail) + '</p></section>';
  }
  function showPassword(error){
    if (!main) return;
    main.innerHTML = '<section class="pub-panel"><h1>Password required</h1><p>Enter the password for this shared app.</p><form id="pub-password-form" class="pub-field"><input id="pub-password" type="password" autocomplete="current-password" autofocus><button type="submit">Open</button></form><div id="pub-password-error" class="pub-error"></div></section>';
    var form = document.getElementById('pub-password-form');
    var input = document.getElementById('pub-password');
    var errorNode = document.getElementById('pub-password-error');
    if (errorNode && error) errorNode.textContent = error;
    if (form && input) {
      form.addEventListener('submit', function(event){
        event.preventDefault();
        password = input.value || '';
        passwordAttempted = true;
        exchange();
      });
      input.focus();
    }
  }
  function postResult(requestId, result){
    if (!iframe || !iframe.contentWindow || !app) return;
    iframe.contentWindow.postMessage(Object.assign({
      type: 'hybridclaw:live-app-tool-result',
      appId: app.id,
      requestId: requestId
    }, result), '*');
  }
  function scheduleRenewal(expiresAt){
    if (renewalTimer) window.clearTimeout(renewalTimer);
    var expires = Date.parse(expiresAt || '');
    if (!Number.isFinite(expires)) return;
    var delay = Math.max(5000, Math.floor((expires - Date.now()) * 0.75));
    renewalTimer = window.setTimeout(function(){ exchange({ renewal: true }); }, delay);
  }
  function getTeamsAuthToken(){
    if (!isTeamsHost) return Promise.resolve('');
    if (teamsAuthToken) return Promise.resolve(teamsAuthToken);
    if (teamsAuthPromise) return teamsAuthPromise;
    var teams = window.microsoftTeams;
    if (!teams) return Promise.reject(new Error('Microsoft Teams is unavailable.'));
    if (teams.app && teams.authentication && teams.authentication.getAuthToken) {
      teamsAuthPromise = Promise.resolve()
        .then(function(){ return teams.app.initialize(); })
        .then(function(){ return teams.authentication.getAuthToken(); })
        .then(function(token){ teamsAuthToken = token || ''; return teamsAuthToken; });
      return teamsAuthPromise;
    }
    if (teams.initialize && teams.authentication && teams.authentication.getAuthToken) {
      teamsAuthPromise = new Promise(function(resolve, reject){
        teams.initialize(function(){
          teams.authentication.getAuthToken({
            successCallback: function(token){ teamsAuthToken = token || ''; resolve(teamsAuthToken); },
            failureCallback: function(reason){ reject(new Error(reason || 'Teams sign-in failed.')); }
          });
        });
      });
      return teamsAuthPromise;
    }
    return Promise.reject(new Error('Teams sign-in is not supported by this client.'));
  }
  function mount(data){
    app = data.app;
    viewToken = data.viewToken;
    if (title) title.textContent = app.title || 'HybridClaw App';
    setStatus(data.expiresAt ? 'Session active' : 'Open');
    setBanner('');
    if (!iframe) {
      main.innerHTML = '';
      iframe = document.createElement('iframe');
      iframe.className = 'pub-frame';
      iframe.title = app.title || 'HybridClaw App';
      iframe.sandbox = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';
      main.appendChild(iframe);
    }
    iframe.src = '/api/apps/' + encodeURIComponent(app.id) + '/view?token=' + encodeURIComponent(viewToken);
    scheduleRenewal(data.expiresAt);
  }
  function exchange(options){
    return getTeamsAuthToken().then(function(idToken){
      var body = {};
      if (password) body.password = password;
      var browserOidcToken = getStoredBrowserOidcToken();
      if (!isTeamsHost && browserOidcToken) body.idToken = browserOidcToken;
      if (idToken) body.idToken = idToken;
      return fetch('/api/pub/' + encodeURIComponent(pubToken) + '/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
      });
    }).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(payload){
        if (response.status === 401) {
          if (!isTeamsHost && payload && payload.oidc) {
            clearStoredBrowserOidcToken();
            startBrowserOidc(payload.oidc);
            return null;
          }
          if (isTeamsHost) {
            showPanel('Sign-in required', 'Teams could not verify your account for this shared app.');
            setStatus('Sign-in required');
            return null;
          }
          showPassword(passwordAttempted ? 'Password incorrect.' : '');
          return null;
        }
        if (response.status === 410) {
          showPanel('Shared app expired', 'This shared app is no longer available.');
          setStatus('Expired');
          return null;
        }
        if (response.status === 403) {
          showPanel('Access denied', 'Your account cannot open this shared app.');
          setStatus('Access denied');
          return null;
        }
        if (!response.ok) {
          showPanel('Shared app unavailable', 'The link is invalid or no longer available.');
          setStatus('Unavailable');
          return null;
        }
        return payload;
      });
    }).then(function(data){
      if (!data) return;
      mount(data);
    }).catch(function(error){
      if (options && options.renewal) {
        setBanner('The viewer session could not be renewed. Reload to try again.');
        return;
      }
      showPanel('Could not open app', error && error.message ? error.message : 'Try again later.');
      setStatus('Error');
    });
  }
  window.addEventListener('message', function(event){
    if (!iframe || event.source !== iframe.contentWindow || !app) return;
    var message = event.data;
    if (!message || message.type !== 'hybridclaw:live-app-tool-call') return;
    if (message.appId !== app.id || typeof message.requestId !== 'string') return;
    fetch('/api/apps/' + encodeURIComponent(app.id) + '/bridge/tool', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + viewToken
      },
      body: JSON.stringify({
        toolName: message.toolName,
        arguments: message.arguments || {}
      })
    }).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(payload){
        if (!response.ok || payload.ok === false) {
          var error = payload.error || 'HybridClaw live app bridge call failed';
          if (response.status === 409) setBanner('This action needs the app owner to approve it.');
          throw new Error(error);
        }
        return payload;
      });
    }).then(function(payload){
      postResult(message.requestId, { ok: true, payload: payload });
    }).catch(function(error){
      postResult(message.requestId, {
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    });
  });
  if (!root || !pubToken) {
    showPanel('Shared app unavailable', 'The link is invalid or no longer available.');
    return;
  }
  exchange();
})();`);
}

function handlePublicationOidcCallback(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HybridClaw Sign-in</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#111827}
body{margin:0;display:grid;min-height:100vh;place-items:center}
.panel{max-width:420px;padding:24px;text-align:center}
.panel h1{margin:0 0 8px;font-size:20px}
.panel p{margin:0;color:#5b6472;line-height:1.5}
@media (prefers-color-scheme:dark){:root{background:#111827;color:#f9fafb}.panel p{color:#c7ced8}}
</style>
</head>
<body>
<main class="panel">
  <h1>Completing sign-in</h1>
  <p>Returning to the shared app.</p>
</main>
<script>
(function(){
  function fail(message){
    document.querySelector('.panel').innerHTML = '<h1>Sign-in failed</h1><p>' + message + '</p>';
  }
  var params = new URLSearchParams(window.location.hash.slice(1));
  var token = params.get('access_token') || params.get('id_token') || '';
  var state = params.get('state') || '';
  if (!token || !state) {
    fail('The sign-in response was incomplete.');
    return;
  }
  var rawState = window.sessionStorage.getItem('hybridclaw.pub.oidc.' + state);
  if (!rawState) {
    fail('The sign-in state expired.');
    return;
  }
  var parsed;
  try {
    parsed = JSON.parse(rawState);
  } catch {
    fail('The sign-in state was invalid.');
    return;
  }
  window.sessionStorage.removeItem('hybridclaw.pub.oidc.' + state);
  if (!parsed || !parsed.pubToken || !parsed.returnUrl) {
    fail('The sign-in state was invalid.');
    return;
  }
  window.sessionStorage.setItem('hybridclaw.pub.oidc.token.' + parsed.pubToken, token);
  window.location.replace(parsed.returnUrl);
})();
</script>
</body>
</html>`);
}

function handleTeamsShellPage(
  res: ServerResponse,
  mode: 'hub' | 'config',
): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' ${new URL(TEAMS_JS_SDK_URL).origin}`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      `frame-ancestors ${TEAMS_FRAME_ANCESTORS.join(' ')}`,
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  const title = mode === 'hub' ? 'HybridClaw Apps' : 'Choose a HybridClaw app';
  res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#111827}
html,body,#teams-root{height:100%;margin:0}
body{overflow:hidden}
.teams-shell{display:flex;min-height:100%;flex-direction:column;background:#f6f7f9}
.teams-header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #d8dde5;background:#fff;padding:12px 16px}
.teams-title{margin:0;font-size:16px;font-weight:650;line-height:1.3}
.teams-status{font-size:13px;color:#5b6472}
.teams-main{position:relative;flex:1;min-height:0;overflow:auto;padding:16px}
.teams-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.teams-card{display:flex;flex-direction:column;gap:8px;min-height:104px;border:1px solid #d8dde5;border-radius:8px;background:#fff;padding:14px;text-align:left;color:#111827;cursor:pointer}
.teams-card strong{font-size:14px}
.teams-card span{color:#5b6472;font-size:13px;line-height:1.4}
.teams-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}
.teams-empty{margin:18vh auto 0;max-width:420px;text-align:center;color:#5b6472;line-height:1.5}
@media (prefers-color-scheme:dark){:root{background:#111827;color:#f9fafb}.teams-shell{background:#111827}.teams-header,.teams-card{background:#161f2e;border-color:#2b3546}.teams-card{color:#f9fafb}.teams-status,.teams-card span,.teams-empty{color:#c7ced8}.teams-frame{background:#111827}}
</style>
<script src="${escapeHtml(TEAMS_JS_SDK_URL)}"></script>
<script src="/teams-shell.js?mode=${mode}" defer></script>
</head>
<body>
<div id="teams-root" class="teams-shell">
  <header class="teams-header">
    <h1 class="teams-title">${escapeHtml(title)}</h1>
    <div id="teams-status" class="teams-status">Loading...</div>
  </header>
  <main id="teams-main" class="teams-main">
    <p class="teams-empty">Preparing Microsoft Teams sign-in.</p>
  </main>
</div>
</body>
</html>`);
}

function handleTeamsShellScript(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`(function(){
  var mode = new URLSearchParams(window.location.search).get('mode') === 'config' ? 'config' : 'hub';
  var main = document.getElementById('teams-main');
  var status = document.getElementById('teams-status');
  var idToken = '';
  function setStatus(text){ if (status) status.textContent = text; }
  function escapeText(value){
    return String(value).replace(/[&<>"']/g, function(ch){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
    });
  }
  function showEmpty(text){
    if (main) main.innerHTML = '<p class="teams-empty">' + escapeText(text) + '</p>';
  }
  function getTeamsAuthToken(){
    if (idToken) return Promise.resolve(idToken);
    var teams = window.microsoftTeams;
    if (!teams) return Promise.reject(new Error('Microsoft Teams is unavailable.'));
    if (teams.app && teams.authentication && teams.authentication.getAuthToken) {
      return Promise.resolve()
        .then(function(){ return teams.app.initialize(); })
        .then(function(){ return teams.authentication.getAuthToken(); })
        .then(function(token){ idToken = token || ''; return idToken; });
    }
    if (teams.initialize && teams.authentication && teams.authentication.getAuthToken) {
      return new Promise(function(resolve, reject){
        teams.initialize(function(){
          teams.authentication.getAuthToken({
            successCallback: function(token){ idToken = token || ''; resolve(idToken); },
            failureCallback: function(reason){ reject(new Error(reason || 'Teams sign-in failed.')); }
          });
        });
      });
    }
    return Promise.reject(new Error('Teams sign-in is not supported by this client.'));
  }
  function api(path, body){
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ idToken: idToken }, body || {}))
    }).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(payload){
        if (!response.ok) throw new Error(payload.error || 'Teams request failed.');
        return payload;
      });
    });
  }
  function configureTab(app){
    return api('/api/teams/tab/apps/' + encodeURIComponent(app.id) + '/publication').then(function(result){
      var teams = window.microsoftTeams;
      var config = {
        contentUrl: result.url,
        entityId: result.entityId,
        suggestedDisplayName: result.app.title
      };
      if (teams.pages && teams.pages.config && teams.pages.config.setConfig) {
        return teams.pages.config.setConfig(config).then(function(){
          if (teams.pages.config.setValidityState) teams.pages.config.setValidityState(true);
          setStatus('Ready');
        });
      }
      if (teams.settings && teams.settings.setSettings) {
        teams.settings.setSettings({
          contentUrl: config.contentUrl,
          entityId: config.entityId,
          suggestedDisplayName: config.suggestedDisplayName
        });
        if (teams.settings.setValidityState) teams.settings.setValidityState(true);
        setStatus('Ready');
        return null;
      }
      window.location.href = result.url;
      return null;
    });
  }
  function openApp(app){
    return api('/api/teams/tab/apps/' + encodeURIComponent(app.id) + '/publication').then(function(result){
      if (!main) return;
      main.innerHTML = '';
      var frame = document.createElement('iframe');
      frame.className = 'teams-frame';
      frame.title = result.app.title || 'HybridClaw App';
      frame.src = result.url;
      main.appendChild(frame);
      setStatus(result.app.title || 'Open');
    });
  }
  function renderApps(apps){
    if (!main) return;
    if (!apps.length) {
      showEmpty('No shared Teams apps are available.');
      setStatus('No apps');
      return;
    }
    main.innerHTML = '<div class="teams-grid"></div>';
    var grid = main.firstChild;
    apps.forEach(function(app){
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'teams-card';
      button.innerHTML = '<strong>' + escapeText(app.title) + '</strong><span>' + escapeText(app.description || (app.kind === 'live' ? 'Live app' : 'Web app')) + '</span>';
      button.addEventListener('click', function(){
        setStatus(mode === 'config' ? 'Configuring...' : 'Opening...');
        (mode === 'config' ? configureTab(app) : openApp(app)).catch(function(error){
          showEmpty(error && error.message ? error.message : 'Could not open app.');
          setStatus('Error');
        });
      });
      grid.appendChild(button);
    });
    setStatus('Choose an app');
  }
  getTeamsAuthToken()
    .then(function(){ return api('/api/teams/tab/apps'); })
    .then(function(payload){ renderApps(payload.apps || []); })
    .catch(function(error){
      showEmpty(error && error.message ? error.message : 'Teams sign-in failed.');
      setStatus('Error');
    });
})();`);
}

async function handlePublicationSessionExchange(
  req: IncomingMessage,
  res: ServerResponse,
  pubToken: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  const rateKey = getPublicationSessionRateKey(req, pubToken);
  if (isPublicationSessionRateLimited(rateKey)) {
    res.setHeader(
      'Retry-After',
      Math.ceil(APP_PUBLICATION_SESSION_RATE_LIMIT_WINDOW_MS / 1000),
    );
    sendJson(res, 429, { error: 'Too many attempts.' });
    return;
  }

  const verified = verifyPublicationToken(pubToken);
  if (verified.status === 'malformed' || verified.status === 'missing') {
    recordPublicationSessionFailure(rateKey);
    sendJson(res, 404, { error: 'Publication not found.' });
    return;
  }
  if (verified.status === 'revoked' || verified.status === 'expired') {
    sendJson(res, 410, { error: 'Publication unavailable.' });
    return;
  }
  if (verified.status !== 'ok') {
    sendJson(res, 404, { error: 'Publication not found.' });
    return;
  }

  const publication = verified.publication;
  const app = getApp(publication.appId);
  if (app?.visibility !== 'public') {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  const body = await readJsonBody(req);
  const requestBody = isJsonObject(body) ? body : {};
  let viewer: MSTeamsTabViewer | null = null;
  if (publication.policy.kind === 'password') {
    const password =
      typeof requestBody.password === 'string' ? requestBody.password : '';
    if (!isPublicationPasswordMatch(publication.policy, password)) {
      recordPublicationSessionFailure(rateKey);
      sendJson(res, 401, {
        error: 'Unauthorized.',
        passwordRequired: true,
      });
      return;
    }
  } else if (publication.policy.kind === 'oidc') {
    const idToken =
      typeof requestBody.idToken === 'string' ? requestBody.idToken : '';
    if (!idToken) {
      sendJson(res, 401, {
        error: 'Unauthorized.',
        oidc: buildPublicationOidcChallenge(req, publication),
      });
      return;
    }
    const { tabConfig } = resolveTeamsTabSsoForRequest(req);
    try {
      viewer = await validateMSTeamsTabIdToken(idToken, {
        tenantId: publication.policy.tenantId,
        ssoAppId: tabConfig.ssoAppId,
        appIdUri: publication.policy.audience,
        allowFrom: tabConfig.allowFrom,
      });
    } catch (error) {
      recordPublicationSessionFailure(rateKey);
      const statusCode =
        error instanceof MSTeamsTabTokenError && error.code === 'viewer_denied'
          ? 403
          : 401;
      sendJson(res, statusCode, {
        error: statusCode === 403 ? 'Forbidden.' : 'Unauthorized.',
        ...(statusCode === 401
          ? { oidc: buildPublicationOidcChallenge(req, publication) }
          : {}),
      });
      return;
    }
    if (!isMSTeamsTabViewerAllowed(viewer, publication.policy.allowFrom)) {
      recordPublicationSessionFailure(rateKey);
      sendJson(res, 403, { error: 'Forbidden.' });
      return;
    }
  }

  clearPublicationSessionFailures(rateKey);
  const now = new Date();
  const expiresAt = computePublicationViewTokenExpiry(publication, now);
  const bridgeAllowed = app.kind === 'live' && publication.allowBridge;
  const actions = bridgeAllowed ? ['apps.view', 'apps.bridge'] : ['apps.view'];
  const tokenResult = createApiToken({
    label: `Publication ${publication.id} view`,
    claims: {
      actions,
      appIds: [app.id],
      pub: publication.id,
      ...(viewer ? { viewer } : {}),
    },
    expiresAt,
    createdBy: `publication:${publication.id}`,
  });
  recordPublicationSessionMint({
    publication,
    app,
    policyKind: publication.policy.kind,
    sourceIp: req.socket.remoteAddress || null,
    viewerSub: viewer?.sub ?? null,
  });

  sendJson(res, 200, {
    viewToken: tokenResult.token,
    expiresAt: expiresAt.toISOString(),
    app: {
      id: app.id,
      title: app.title,
      kind: app.kind,
      bridge: bridgeAllowed,
    },
    ...(viewer ? { viewer } : {}),
  });
}

async function validateTeamsTabRequest(
  req: IncomingMessage,
  body: Record<string, unknown>,
): Promise<MSTeamsTabViewer> {
  const idToken = typeof body.idToken === 'string' ? body.idToken : '';
  const { tabConfig } = resolveTeamsTabSsoForRequest(req);
  return validateMSTeamsTabIdToken(idToken, {
    tenantId: tabConfig.tenantId,
    ssoAppId: tabConfig.ssoAppId,
    appIdUri: tabConfig.appIdUri,
    allowFrom: tabConfig.allowFrom,
  });
}

async function handleTeamsTabApps(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  const body = await readJsonBody(req);
  const requestBody = isJsonObject(body) ? body : {};
  let viewer: MSTeamsTabViewer;
  try {
    viewer = await validateTeamsTabRequest(req, requestBody);
  } catch {
    sendJson(res, 401, { error: 'Unauthorized.' });
    return;
  }
  const apps = listApps({})
    .filter((app) => app.visibility === 'public')
    .filter((app) => selectTeamsCapablePublication(app.id, viewer) !== null)
    .map((app) => ({
      id: app.id,
      title: app.title,
      description: app.description,
      kind: app.kind,
      category: app.category,
      bridge:
        getApp(app.id)?.kind === 'live' &&
        selectTeamsCapablePublication(app.id, viewer)?.allowBridge === true,
    }));
  sendJson(res, 200, { apps, total: apps.length, viewer });
}

async function handleTeamsTabAppPublication(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  const body = await readJsonBody(req);
  const requestBody = isJsonObject(body) ? body : {};
  let viewer: MSTeamsTabViewer;
  try {
    viewer = await validateTeamsTabRequest(req, requestBody);
  } catch {
    sendJson(res, 401, { error: 'Unauthorized.' });
    return;
  }
  const app = getApp(appId);
  if (app?.visibility !== 'public') {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  const sourcePublication = selectTeamsCapablePublication(app.id, viewer);
  if (!sourcePublication) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  const result = createTeamsPublicationForApp({
    req,
    app,
    allowBridge: sourcePublication.allowBridge,
    label: 'Teams tab',
    createdBy: `teams:${viewer.sub}`,
  });
  sendJson(res, 200, {
    app: {
      id: app.id,
      title: app.title,
      kind: app.kind,
      bridge: result.publication.allowBridge,
    },
    publication: serializePublication(result.publication),
    url: result.url,
    entityId: `hc-app-${teamsSafeEntityId(app.id)}`,
  });
}

async function sendTeamsManifestZip(
  res: ServerResponse,
  filename: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const zipBuffer = await buildTeamsManifestZip(manifest);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(zipBuffer);
}

async function handleApiAppTeamsManifest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  appId: string,
  authContext: ResolvedAuthContext,
): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  const app = getApp(appId);
  if (!app) {
    sendJson(res, 404, { error: 'App not found.' });
    return;
  }
  if (app.visibility !== 'public') {
    sendJson(res, 403, {
      error: 'App must be shared before generating Teams manifest.',
    });
    return;
  }
  const { origin, tabConfig } = resolveTeamsTabSsoForRequest(req);
  const publicationToken = url.searchParams.get('publicationToken') || '';
  let publication: AppPublicationMetadata;
  let contentUrl: string;
  if (publicationToken) {
    const verified = verifyPublicationToken(publicationToken);
    if (
      verified.status !== 'ok' ||
      verified.publication.appId !== app.id ||
      !isTeamsCapablePublication(verified.publication)
    ) {
      sendJson(res, 400, { error: 'Invalid Teams publication token.' });
      return;
    }
    publication = verified.publication;
    contentUrl = buildTeamsPublicationUrl(origin, publicationToken);
  } else {
    const created = createTeamsPublicationForApp({
      req,
      app,
      allowBridge: app.kind === 'live',
      label: 'Standalone Teams app',
      createdBy: resolvePublicationCreatedBy(authContext),
    });
    publication = created.publication;
    contentUrl = created.url;
  }
  const manifest = buildTeamsAppManifest({
    app,
    publication,
    contentUrl,
    origin,
    tabConfig,
  });
  await sendTeamsManifestZip(
    res,
    `hybridclaw-${teamsSafeEntityId(app.id)}-teams.zip`,
    manifest,
  );
}

async function handleApiAdminMSTeamsTabManifest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  const { origin, tabConfig } = resolveTeamsTabSsoForRequest(req);
  await sendTeamsManifestZip(
    res,
    'hybridclaw-teams-app.zip',
    buildTeamsOrgManifest({ origin, tabConfig }),
  );
}

function handleApiAdminMSTeamsTabStatus(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  const origin = resolveRequestOrigin(req);
  const tabConfig = resolveMSTeamsTabConfig(getRuntimeConfig(), origin);
  sendJson(res, 200, {
    enabled: tabConfig.enabled,
    tenantId: tabConfig.tenantId,
    ssoAppId: tabConfig.ssoAppId,
    appIdUri: tabConfig.appIdUri,
    allowFrom: tabConfig.allowFrom,
    publicOrigin: origin,
    browserRedirectUri: new URL(
      APP_PUBLICATION_OIDC_CALLBACK_PATH,
      origin,
    ).toString(),
    orgAppId: uuidv5(`${origin}:teams-org-app`, TEAMS_MANIFEST_UUID_NAMESPACE),
    orgAppEntityId: TEAMS_APP_ENTITY_ID,
    scope: TEAMS_TAB_SCOPE,
    teamsClientIds: {
      desktopMobile: TEAMS_DESKTOP_CLIENT_ID,
      web: TEAMS_WEB_CLIENT_ID,
    },
    orgManifestUrl: '/api/admin/msteams/tab-manifest',
  });
}

async function handleApiAppGenerate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    description?: unknown;
    category?: unknown;
    agentId?: unknown;
    model?: unknown;
    sessionId?: unknown;
    chatbotId?: unknown;
  };
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    throw new GatewayRequestError(
      400,
      'A non-empty `description` is required.',
    );
  }
  const agentId =
    (typeof body.agentId === 'string' && body.agentId.trim()) ||
    resolveDefaultAgentId(getRuntimeConfig());
  const generated = await generateApp({
    description,
    ...(typeof body.category === 'string' ? { category: body.category } : {}),
    agentId,
    ...(typeof body.model === 'string' && body.model.trim()
      ? { model: body.model.trim() }
      : {}),
    ...(typeof body.chatbotId === 'string' && body.chatbotId.trim()
      ? { chatbotId: body.chatbotId.trim() }
      : {}),
  });
  const app = createApp({
    title: generated.title,
    html: generated.html,
    category: generated.category,
    description,
    prompt: description,
    agentId,
    sessionId:
      typeof body.sessionId === 'string' ? body.sessionId.trim() || null : null,
  });
  sendJson(res, 201, { app });
}

/**
 * Persist self-contained HTML produced in a chat turn into the Apps gallery.
 * Runs for every chat (not just the Apps builder): each HTML artifact file
 * becomes a gallery entry keyed by (session, filename), updated in place as the
 * conversation iterates. App-builder turns additionally capture HTML inlined in
 * the assistant text and tag the entry with category / kind.
 * Best-effort: never throws into the chat response path.
 */
async function maybeCaptureChatArtifacts(
  chatRequest: GatewayChatRequest,
  result: GatewayChatResult,
): Promise<NonNullable<GatewayChatResult['apps']>> {
  const captured: NonNullable<GatewayChatResult['apps']> = [];
  if (result.status !== 'success') return captured;
  const sessionId = result.sessionId || chatRequest.sessionId;
  if (!sessionId) return captured;
  const kind = chatRequest.appKind === 'live' ? 'live' : 'web';
  const category = chatRequest.appBuild
    ? (chatRequest.appCategory ?? null)
    : null;
  const agentId = result.agentId ?? chatRequest.agentId ?? null;
  try {
    for (const artifact of result.artifacts ?? []) {
      if (!artifact.mimeType?.toLowerCase().includes('html')) continue;
      if (!artifact.path) continue;
      let html: string;
      try {
        const content = await fs.promises.readFile(artifact.path, 'utf8');
        html = extractHtmlDocument(content) ?? content;
      } catch {
        continue;
      }
      const app = upsertAppArtifact({
        sessionId,
        sourceKey: artifact.filename || artifact.path,
        title: deriveAppTitle(html, artifact.filename || ''),
        html,
        category,
        kind,
        agentId,
      });
      captured.push({ id: app.id, title: app.title, kind: app.kind });
      logger.debug(
        { sessionId, appId: app.id, title: app.title, kind },
        'Captured HTML artifact into Apps gallery',
      );
    }
    const workspaceDir =
      captured.length === 0 && chatRequest.appBuild
        ? agentWorkspaceDir(
            agentId || resolveDefaultAgentId(getRuntimeConfig()),
          )
        : null;

    const captureWorkspaceHtml = async (
      ref: string,
      filePath: string,
    ): Promise<void> => {
      let content: string;
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch {
        return;
      }
      const html = extractHtmlDocument(content) ?? content;
      if (!/<html|<!doctype html/i.test(html)) return;
      const app = upsertAppArtifact({
        sessionId,
        sourceKey: ref,
        title: deriveAppTitle(html, path.basename(ref)),
        html,
        category,
        kind,
        agentId,
      });
      captured.push({ id: app.id, title: app.title, kind: app.kind });
      logger.debug(
        { sessionId, appId: app.id, title: app.title, kind, ref },
        'Captured workspace HTML file into Apps gallery',
      );
    };

    // App-builder turns write the HTML to a file in the `apps/` folder (per the
    // build instructions) and reference it in the reply (e.g.
    // "apps/dashboard.html"). Resolve those *.html references inside the agent
    // workspace and capture them.
    if (workspaceDir) {
      const seen = new Set<string>();
      for (const match of (result.result ?? '').matchAll(
        /([A-Za-z0-9_][A-Za-z0-9_./-]*\.html)\b/g,
      )) {
        const ref = match[1];
        if (seen.has(ref)) continue;
        seen.add(ref);
        const filePath = resolveWorkspaceRelativePath(workspaceDir, ref);
        if (filePath) await captureWorkspaceHtml(ref, filePath);
      }
    }
    // Or the HTML may be inlined in the reply instead of a file.
    if (captured.length === 0 && chatRequest.appBuild) {
      const html = extractHtmlDocument(result.result ?? '');
      if (!html) return captured;
      const app = upsertAppArtifact({
        sessionId,
        sourceKey: 'inline',
        title: deriveAppTitle(html, ''),
        html,
        category,
        kind,
        agentId,
      });
      captured.push({ id: app.id, title: app.title, kind: app.kind });
      logger.debug(
        { sessionId, appId: app.id, title: app.title, kind },
        'Captured inline app build into Apps gallery',
      );
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to capture chat artifacts');
  }
  return captured;
}

async function handleApiAdminTerminal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  terminalManager: ReturnType<typeof createAdminTerminalManager>,
): Promise<void> {
  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) as ApiAdminTerminalRequestBody;
    const options: AdminTerminalStartOptions = {
      cols: body.cols,
      rows: body.rows,
    };
    sendJson(res, 200, terminalManager.startSession(options));
    return;
  }

  if (req.method === 'DELETE') {
    const sessionId = normalizeOptionalString(
      url.searchParams.get('sessionId'),
    );
    if (!sessionId) {
      sendJson(res, 400, { error: 'Missing `sessionId`.' });
      return;
    }
    sendJson(res, 200, {
      stopped: terminalManager.stopSession(sessionId),
    });
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
}

function writeUpgradeError(
  socket: NodeJS.WritableStream & { destroy: () => void },
  statusCode: number,
  statusText: string,
): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${statusText}`,
  );
  socket.destroy();
}

// Optional Vite dev passthrough: when HYBRIDCLAW_DEV_VITE_URL is set the
// gateway forwards SPA HTML, Vite source/asset paths, and the HMR WebSocket
// to the configured Vite dev server so the console can be developed under
// the gateway's origin (and pick up the hybridclaw_local_session cookie).
// Refused unless the upstream is http:// AND the gateway is bound to
// loopback, since the proxy intentionally bypasses the console-surface auth
// gate (Vite serves source straight from disk).
const DEV_VITE_URL = (() => {
  const raw = (process.env.HYBRIDCLAW_DEV_VITE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return '';
  if (!raw.startsWith('http://')) {
    logger.warn(
      { value: raw },
      'HYBRIDCLAW_DEV_VITE_URL must be an http:// URL — Vite passthrough disabled',
    );
    return '';
  }
  if (!isLoopbackHost(HEALTH_HOST)) {
    logger.warn(
      { healthHost: HEALTH_HOST },
      'HYBRIDCLAW_DEV_VITE_URL ignored: gateway is not bound to a loopback host',
    );
    return '';
  }
  return raw;
})();

function isViteSourcePath(pathname: string): boolean {
  return (
    pathname.startsWith('/@vite/') ||
    pathname === '/@react-refresh' ||
    pathname.startsWith('/@id/') ||
    pathname.startsWith('/@fs/') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/')
  );
}

function canUseDevViteProxy(req: IncomingMessage): boolean {
  return (
    DEV_VITE_URL.length > 0 &&
    isLoopbackSocketAddress(req.socket.remoteAddress) &&
    !hasForwardingHeaders(req)
  );
}

function buildViteRequestOptions(
  req: IncomingMessage,
  targetPath: string,
): http.RequestOptions {
  const upstream = new URL(targetPath, DEV_VITE_URL);
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: upstream.pathname + upstream.search,
    headers: { ...req.headers, host: upstream.host },
  };
}

function proxyToVite(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string,
): void {
  const upstreamReq = http.request(
    buildViteRequestOptions(req, targetPath),
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on('error', (error) => {
    if (!res.headersSent) {
      sendText(
        res,
        502,
        `Vite dev server unreachable at ${DEV_VITE_URL}: ${error.message}`,
      );
    } else {
      res.destroy(error);
    }
  });
  // Abort the upstream request if the client disconnects before we finish
  // streaming the response back. ServerResponse 'close' fires only on
  // premature closure, not on normal end-of-response, so this won't fight
  // the happy path.
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });
  req.pipe(upstreamReq);
}

function proxyViteUpgrade(
  req: IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
): void {
  const upstreamReq = http.request(
    buildViteRequestOptions(req, req.url || '/'),
  );
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [
      `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage || 'Switching Protocols'}`,
    ];
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${key}: ${item}`);
      } else if (value != null) {
        lines.push(`${key}: ${value}`);
      }
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const closeBoth = (): void => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    upstreamSocket.on('error', closeBoth);
    upstreamSocket.on('close', closeBoth);
    socket.on('error', closeBoth);
    socket.on('close', closeBoth);
  });
  // Vite may answer with a regular HTTP response (e.g. 426/4xx) instead of
  // upgrading. Surface that as an upgrade error so the client socket doesn't
  // hang.
  upstreamReq.on('response', (upstreamRes) => {
    writeUpgradeError(
      socket,
      502,
      `Vite did not upgrade (status ${upstreamRes.statusCode ?? 'unknown'})`,
    );
    upstreamRes.resume();
  });
  upstreamReq.on('error', () => {
    writeUpgradeError(socket, 502, 'Vite dev server unreachable');
  });
  upstreamReq.end();
}

export interface GatewayHttpServer {
  broadcastShutdown: () => void;
  setReady: () => void;
}

export function startGatewayHttpServer(): GatewayHttpServer {
  let gatewayReady = false;
  const gatewayStartMs = Date.now();
  const terminalManager = createAdminTerminalManager();
  const activeSseResponses = new Set<ServerResponse>();
  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const a2aLocalMode = isA2ALocalModeEnabled(getRuntimeConfig());
    const localRequest = isLoopbackWebRequest(req);

    if (
      a2aLocalMode &&
      !localRequest &&
      !isA2ALocalModePublicA2ARequest(method, pathname) &&
      !isA2ALocalModeAdminRequest(method, pathname)
    ) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    if (pathname === '/health' && method === 'GET') {
      void getGatewayStatus({
        includeCoworkerLiveness: false,
        refreshProviderHealth: false,
      }).then(
        (status) => sendJson(res, 200, status),
        (err) => {
          logger.error({ err }, 'Health check failed');
          sendJson(res, 503, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
      return;
    }

    if ((pathname === '/ready' || pathname === '/readyz') && method === 'GET') {
      const uptimeMs = Date.now() - gatewayStartMs;
      sendJson(res, gatewayReady ? 200 : 503, {
        ready: gatewayReady,
        uptimeMs,
      });
      return;
    }

    if (pathname === '/') {
      sendRedirect(
        res,
        302,
        a2aLocalMode && !localRequest ? '/admin/federation?tab=peers' : '/chat',
      );
      return;
    }

    if (pathname === '/chat/continue') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      handleChatMobileContinue(res, url);
      return;
    }

    if (pathname === '/auth/callback') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }

      const token = (url.searchParams.get('token') || '').trim();
      if (!token) {
        sendText(res, 401, 'Unauthorized. Invalid or expired auth token.');
        return;
      }

      const redirectTo =
        resolveLocalRedirectPath(url.searchParams.get('next')) ?? '/admin';

      try {
        const payload = verifyLaunchToken(token);
        setSessionCookie(res, payload);
        sendRedirect(res, 302, redirectTo);
      } catch {
        sendText(res, 401, 'Unauthorized. Invalid or expired auth token.');
      }
      return;
    }

    const voicePaths = resolveVoiceWebhookPaths(
      getRuntimeConfig().voice.webhookPath,
    );
    if (pathname === '/.well-known/agent.json' && method === 'GET') {
      const origin = resolveA2AAgentCardOrigin(req);
      if (!origin) {
        sendJson(res, 500, {
          error: 'deployment.public_url must be an HTTP(S) URL.',
        });
        return;
      }
      const trust = resolveA2AAgentCardPeerTrust({
        authorization: req.headers.authorization || '',
        audience: new URL('/.well-known/agent.json', origin).toString(),
        mtlsPublicKeyPem: extractA2AMtlsPublicKeyPem(req),
      });
      sendJson(
        res,
        200,
        getGatewayA2AAgentCard(origin, {
          peerTrustLevel: trust.trustLevel,
          peerId: trust.peerId,
        }),
      );
      return;
    }
    if (
      method === 'POST' &&
      (pathname === voicePaths.webhookPath ||
        pathname === voicePaths.actionPath)
    ) {
      dispatchWebhookRoute(res, () => handleVoiceWebhook(req, res, url));
      return;
    }

    if (pathname === '/a2a/pairing/requests') {
      dispatchWebhookRoute(res, () =>
        handleA2APairingRequestInbound(req, res, url),
      );
      return;
    }

    if (parseA2AWebhookInboundPath(pathname)) {
      dispatchWebhookRoute(res, () => handleA2AWebhookInbound(req, res, url));
      return;
    }
    if (pathname === '/a2a') {
      dispatchWebhookRoute(res, () => handleA2AJsonRpcInbound(req, res, url));
      return;
    }
    if (pathname === '/a2a/envelopes') {
      dispatchWebhookRoute(res, () =>
        handleA2AHttpEnvelopeInbound(req, res, url),
      );
      return;
    }

    if (pathname === APP_PUBLICATION_SHELL_SCRIPT_PATH && method === 'GET') {
      handlePublicationShellScript(res);
      return;
    }
    if (pathname === APP_PUBLICATION_OIDC_CALLBACK_PATH && method === 'GET') {
      handlePublicationOidcCallback(res);
      return;
    }
    if (pathname === '/teams-shell.js' && method === 'GET') {
      handleTeamsShellScript(res);
      return;
    }
    if (pathname === '/teams/hub' && method === 'GET') {
      handleTeamsShellPage(res, 'hub');
      return;
    }
    if (pathname === '/teams/tab-config' && method === 'GET') {
      handleTeamsShellPage(res, 'config');
      return;
    }
    {
      const pubToken = parsePublicationShellToken(pathname);
      if (pubToken !== null && method === 'GET') {
        handlePublicationShell(res, pubToken, url);
        return;
      }
    }

    if (pathname.startsWith('/api/')) {
      {
        const pubToken = parsePublicationSessionToken(pathname);
        if (pubToken !== null) {
          void handlePublicationSessionExchange(req, res, pubToken).catch(
            (err: unknown) => {
              if (res.writableEnded) return;
              const errorText =
                err instanceof Error ? err.message : String(err);
              const statusCode =
                err instanceof GatewayRequestError ? err.statusCode : 500;
              sendJson(res, statusCode, { error: errorText });
            },
          );
          return;
        }
      }
      if (pathname === '/api/teams/tab/apps') {
        void handleTeamsTabApps(req, res).catch((err: unknown) => {
          if (res.writableEnded) return;
          const errorText = err instanceof Error ? err.message : String(err);
          const statusCode =
            err instanceof GatewayRequestError ? err.statusCode : 500;
          sendJson(res, statusCode, { error: errorText });
        });
        return;
      }
      {
        const appId = parseTeamsTabAppPublicationPath(pathname);
        if (appId !== null) {
          void handleTeamsTabAppPublication(req, res, appId).catch(
            (err: unknown) => {
              if (res.writableEnded) return;
              const errorText =
                err instanceof Error ? err.message : String(err);
              const statusCode =
                err instanceof GatewayRequestError ? err.statusCode : 500;
              sendJson(res, statusCode, { error: errorText });
            },
          );
          return;
        }
      }
      if (pathname === MSTEAMS_WEBHOOK_PATH && method === 'POST') {
        dispatchWebhookRoute(res, async () => {
          const { handleMSTeamsWebhook } = await import(
            '../channels/msteams/runtime.js'
          );
          await handleMSTeamsWebhook(req, res);
        });
        return;
      }
      if (pathname === IMESSAGE_WEBHOOK_PATH && method === 'POST') {
        dispatchWebhookRoute(res, () => handleIMessageWebhook(req, res));
        return;
      }
      if (isPluginInboundWebhookPath(pathname)) {
        dispatchWebhookRoute(res, () =>
          handleGatewayPluginWebhook(req, res, url),
        );
        return;
      }
      if (pathname === '/api/artifact' && method === 'GET') {
        void handleApiArtifact(req, res, url).catch((err: unknown) => {
          if (res.writableEnded) return;
          const errorText = err instanceof Error ? err.message : String(err);
          const statusCode =
            err instanceof GatewayRequestError ||
            err instanceof AdminTerminalCapacityError
              ? err.statusCode
              : 500;
          sendJson(res, statusCode, { error: errorText });
        });
        return;
      }
      {
        // App viewer renders generated HTML inline in a (sandboxed) browser
        // frame, so — like /api/artifact — it accepts query-token / cookie auth
        // instead of requiring an Authorization header.
        const appViewId = parseApiAppId(pathname, '/view');
        if (appViewId !== null && method === 'GET') {
          void handleApiAppView(req, res, url, appViewId).catch(
            (err: unknown) => {
              if (res.writableEnded) return;
              const errorText =
                err instanceof Error ? err.message : String(err);
              const statusCode =
                err instanceof GatewayRequestError ? err.statusCode : 500;
              sendJson(res, statusCode, { error: errorText });
            },
          );
          return;
        }

        const appBridgeToolId = parseApiAppId(pathname, '/bridge/tool');
        if (appBridgeToolId !== null) {
          void handleApiAppBridgeTool(req, res, url, appBridgeToolId).catch(
            (err: unknown) => {
              if (res.writableEnded) return;
              const errorText =
                err instanceof Error ? err.message : String(err);
              const statusCode =
                err instanceof GatewayRequestError ? err.statusCode : 500;
              sendJson(res, statusCode, { ok: false, error: errorText });
            },
          );
          return;
        }
      }
      if (pathname === '/api/mcp/oauth/callback' && method === 'GET') {
        // Public by design: the OAuth provider redirects the user's browser
        // here without gateway credentials. The flow is bound to a
        // single-use `state` nonce validated by the pending-flow registry.
        void handleApiMcpOAuthCallback(res, url).catch((err: unknown) => {
          if (res.writableEnded) return;
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      if (pathname === '/api/connectors/oauth/callback' && method === 'GET') {
        // Public by design: the OAuth provider redirects the user's browser
        // here without gateway credentials. The flow is bound to a
        // single-use `state` nonce validated by the pending-flow registry.
        void handleApiConnectorOAuthCallback(res, url).catch((err: unknown) => {
          if (res.writableEnded) return;
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      if (pathname === '/api/agent-avatar' && method === 'GET') {
        try {
          handleApiAgentAvatar(req, res, url);
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const statusCode =
            err instanceof GatewayRequestError ? err.statusCode : 500;
          sendJson(res, statusCode, { error: errorText });
        }
        return;
      }

      const authContext = resolveAuthContext(req, url, {
        allowQueryToken: false,
        allowLocalWebSession: true,
        allowSessionCookie: true,
        requireSameOrigin: method !== 'GET',
      });
      if (authContext.kind === 'none') {
        recordUnauthenticatedAdminSecretMutation(req, pathname, method);
        sendJson(res, 401, {
          error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
        });
        return;
      }

      if (!enforceAdminRouteRbac(authContext, res, pathname, method)) {
        return;
      }

      void (async () => {
        try {
          if (pathname === '/api/events' && method === 'GET') {
            handleApiEvents(req, res, activeSseResponses);
            return;
          }
          if (pathname === '/api/status' && method === 'GET') {
            sendJson(res, 200, await getGatewayStatus());
            return;
          }
          if (
            pathname === '/api/skills/health' ||
            pathname.startsWith('/api/skills/health/') ||
            pathname === '/api/skills/amendments' ||
            pathname.startsWith('/api/skills/amendments/')
          ) {
            await handleApiAdaptiveSkills(req, res, pathname);
            return;
          }
          if (pathname === '/api/admin/overview' && method === 'GET') {
            await handleApiAdminOverview(res);
            return;
          }
          if (pathname === '/api/apps' && method === 'GET') {
            handleApiAppsList(res, url);
            return;
          }
          if (pathname === '/api/apps/generate' && method === 'POST') {
            await handleApiAppGenerate(req, res);
            return;
          }
          {
            const teamsManifestAppId = parseApiAppId(
              pathname,
              '/teams-manifest',
            );
            if (teamsManifestAppId !== null) {
              await handleApiAppTeamsManifest(
                req,
                res,
                url,
                teamsManifestAppId,
                authContext,
              );
              return;
            }
          }
          {
            const publicationsAppId =
              parseApiAppPublicationsCollectionPath(pathname);
            if (publicationsAppId !== null) {
              if (method === 'GET') {
                handleApiAppPublicationsList(res, publicationsAppId);
                return;
              }
              if (method === 'POST') {
                await handleApiAppPublicationCreate(
                  req,
                  res,
                  publicationsAppId,
                  authContext,
                );
                return;
              }
              sendMethodNotAllowed(res);
              return;
            }
            const publicationItem = parseApiAppPublicationItemPath(pathname);
            if (publicationItem !== null) {
              if (method === 'DELETE') {
                handleApiAppPublicationRevoke(
                  res,
                  publicationItem.appId,
                  publicationItem.publicationId,
                );
                return;
              }
              sendMethodNotAllowed(res);
              return;
            }
          }
          {
            const appId = parseApiAppId(pathname);
            if (appId !== null) {
              if (method === 'GET') {
                handleApiAppDetail(res, appId);
                return;
              }
              if (method === 'PATCH') {
                await handleApiAppUpdate(req, res, appId);
                return;
              }
              if (method === 'DELETE') {
                handleApiAppDelete(res, appId);
                return;
              }
              sendMethodNotAllowed(res);
              return;
            }
          }
          if (pathname === '/api/admin/secrets' && method === 'GET') {
            handleApiAdminSecrets(req, res, authContext);
            return;
          }
          const adminSecretName = parseApiAdminSecretName(pathname);
          if (adminSecretName !== null) {
            if (method === 'GET') {
              sendJson(res, 405, {
                error: 'Secret values are write-only on this route.',
              });
              return;
            }
            if (method === 'PUT') {
              await handleApiAdminSecretOverwrite(
                req,
                res,
                adminSecretName,
                authContext,
              );
              return;
            }
            if (method === 'DELETE') {
              await handleApiAdminSecretUnset(
                req,
                res,
                adminSecretName,
                authContext,
              );
              return;
            }
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/secrets') {
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/tokens' && method === 'GET') {
            handleApiAdminTokens(res, authContext);
            return;
          }
          if (pathname === '/api/admin/tokens' && method === 'POST') {
            await handleApiAdminTokenCreate(req, res, authContext);
            return;
          }
          const adminTokenId = parseApiAdminTokenId(pathname);
          if (adminTokenId !== null) {
            if (method === 'DELETE') {
              handleApiAdminTokenRevoke(req, res, adminTokenId, authContext);
              return;
            }
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/tokens') {
            sendMethodNotAllowed(res);
            return;
          }
          if (
            pathname === '/api/admin/tunnel' &&
            (method === 'GET' || method === 'PUT')
          ) {
            await handleApiAdminTunnelConfig(req, res);
            return;
          }
          if (pathname === '/api/admin/tunnel') {
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/tunnel/reconnect' && method === 'POST') {
            await handleApiAdminTunnelReconnect(res);
            return;
          }
          if (pathname === '/api/admin/tunnel/reconnect') {
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/tunnel/stop' && method === 'POST') {
            await handleApiAdminTunnelStop(res);
            return;
          }
          if (pathname === '/api/admin/tunnel/stop') {
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/statistics' && method === 'GET') {
            handleApiAdminStatistics(res, url);
            return;
          }
          if (pathname === '/api/admin/logs' && method === 'GET') {
            await handleApiAdminLogs(res, url);
            return;
          }
          if (
            pathname === '/api/admin/team-structure' ||
            pathname.startsWith('/api/admin/team-structure/')
          ) {
            await handleApiAdminTeamStructure(res, method, url);
            return;
          }
          if (
            pathname === '/api/admin/agents' ||
            pathname.startsWith('/api/admin/agents/')
          ) {
            await handleApiAdminAgents(req, res, url);
            return;
          }
          if (pathname === '/api/admin/hybridai/bots') {
            await handleApiAdminHybridAIBots(res, method, url);
            return;
          }
          if (pathname === '/api/admin/agent-scoreboard' && method === 'GET') {
            handleApiAdminAgentScoreboard(res);
            return;
          }
          if (pathname === '/api/admin/harness-evolution' && method === 'GET') {
            await handleApiAdminHarnessEvolution(res, url);
            return;
          }
          if (
            pathname === '/api/admin/models' &&
            (method === 'GET' || method === 'PUT')
          ) {
            await handleApiAdminModels(req, res);
            return;
          }
          if (pathname === '/api/admin/sessions' && method === 'GET') {
            handleApiAdminSessions(res);
            return;
          }
          if (pathname === '/api/admin/email' && method === 'GET') {
            await handleApiAdminEmail(res);
            return;
          }
          if (pathname === '/api/admin/email/messages' && method === 'GET') {
            await handleApiAdminEmailFolder(res, url);
            return;
          }
          if (pathname === '/api/admin/email/message' && method === 'GET') {
            await handleApiAdminEmailMessage(res, url);
            return;
          }
          if (pathname === '/api/admin/email/message' && method === 'DELETE') {
            await handleApiAdminEmailMessageDelete(res, url);
            return;
          }
          if (pathname === '/api/admin/sessions' && method === 'DELETE') {
            handleApiAdminSessionDelete(res, url);
            return;
          }
          if (
            pathname === '/api/admin/scheduler' &&
            (method === 'GET' ||
              method === 'PUT' ||
              method === 'DELETE' ||
              method === 'POST')
          ) {
            await handleApiAdminScheduler(req, res, url);
            return;
          }
          if (
            pathname === '/api/admin/channels' &&
            (method === 'GET' || method === 'PUT' || method === 'DELETE')
          ) {
            await handleApiAdminChannels(req, res, url);
            return;
          }
          if (pathname === '/api/admin/msteams/tab-manifest') {
            await handleApiAdminMSTeamsTabManifest(req, res);
            return;
          }
          if (pathname === '/api/admin/msteams/tab-status') {
            handleApiAdminMSTeamsTabStatus(req, res);
            return;
          }
          if (
            pathname === '/api/admin/mcp' &&
            (method === 'GET' || method === 'PUT' || method === 'DELETE')
          ) {
            await handleApiAdminMcp(req, res, url);
            return;
          }
          if (
            pathname === '/api/admin/connectors' ||
            pathname === '/api/admin/connectors/hybridai/key' ||
            pathname === '/api/admin/connectors/oauth/start' ||
            pathname === '/api/admin/connectors/test' ||
            pathname === '/api/admin/connectors/logout'
          ) {
            await handleApiAdminConnectors(req, res, url);
            return;
          }
          if (
            ((pathname === '/api/admin/mcp/oauth/start' ||
              pathname === '/api/admin/mcp/oauth/logout') &&
              method === 'POST') ||
            (pathname === '/api/admin/mcp/oauth/status' && method === 'GET')
          ) {
            await handleApiAdminMcpOAuth(req, res, url);
            return;
          }
          if (
            pathname === '/api/admin/config' &&
            (method === 'GET' || method === 'PUT')
          ) {
            await handleApiAdminConfig(req, res);
            return;
          }
          if (
            pathname === '/api/admin/browser-pool/health' &&
            method === 'GET'
          ) {
            await handleApiAdminBrowserPoolHealth(res);
            return;
          }
          if (
            pathname === '/api/admin/browser-pool/start' &&
            method === 'POST'
          ) {
            await handleApiAdminBrowserPoolStart(res);
            return;
          }
          if (
            pathname === '/api/admin/slack-webhook-targets' &&
            (method === 'POST' || method === 'PUT')
          ) {
            await handleApiAdminSlackWebhookTargets(req, res);
            return;
          }
          if (
            pathname === '/api/admin/discord-webhook-targets' &&
            (method === 'POST' || method === 'PUT')
          ) {
            await handleApiAdminDiscordWebhookTargets(req, res);
            return;
          }
          if (
            pathname === '/api/admin/a2a/trust' &&
            (method === 'GET' ||
              method === 'POST' ||
              method === 'PUT' ||
              method === 'DELETE')
          ) {
            await handleApiAdminA2ATrust(req, res, url);
            return;
          }
          if (pathname === '/api/admin/a2a/local-mode' && method === 'PUT') {
            await handleApiAdminA2ALocalMode(req, res);
            return;
          }
          if (pathname === '/api/admin/a2a/e2ee-required' && method === 'PUT') {
            await handleApiAdminA2AE2EERequired(req, res);
            return;
          }
          if (
            pathname === '/api/admin/fleet-topology' &&
            (method === 'GET' ||
              method === 'POST' ||
              method === 'PUT' ||
              method === 'DELETE')
          ) {
            await handleApiAdminFleetTopology(req, res, url);
            return;
          }
          if (
            (pathname === '/api/admin/a2a/pairing' ||
              pathname === '/api/admin/a2a/pairing/preview' ||
              pathname === '/api/admin/a2a/pairing/approve' ||
              pathname === '/api/admin/a2a/pairing/decline') &&
            method === 'POST'
          ) {
            await handleApiAdminA2APairing(req, res, pathname);
            return;
          }
          if (pathname === '/api/admin/a2a/inbox' && method === 'GET') {
            handleApiAdminA2AInbox(res, url);
            return;
          }
          if (pathname === '/api/admin/a2a/outbox/status' && method === 'GET') {
            handleApiAdminA2AOutboxStatus(res, url);
            return;
          }
          if (
            pathname === '/api/admin/signal/link' &&
            (method === 'GET' || method === 'POST')
          ) {
            await handleApiAdminSignalLink(req, res);
            return;
          }
          if (
            pathname === '/api/admin/email-config/fetch' &&
            method === 'GET'
          ) {
            await handleApiAdminEmailConfigFetch(res, url);
            return;
          }
          if (pathname === '/api/admin/audit' && method === 'GET') {
            handleApiAdminAudit(res, url);
            return;
          }
          if (pathname === '/api/admin/approvals' && method === 'GET') {
            handleApiAdminApprovals(res, url);
            return;
          }
          if (pathname === '/api/interactive-escalations' && method === 'GET') {
            handleApiListInteractiveEscalations(res);
            return;
          }
          if (
            pathname === '/api/interactive-escalations' &&
            method === 'POST'
          ) {
            await handleApiCreateInteractiveEscalation(
              req,
              res,
              activeSseResponses,
            );
            return;
          }
          if (
            pathname === '/api/interactive-escalations/resume' &&
            method === 'POST'
          ) {
            await handleApiResumeInteractiveEscalation(
              req,
              res,
              activeSseResponses,
            );
            return;
          }
          if (
            pathname === '/api/interactive-escalations/consume' &&
            method === 'POST'
          ) {
            await handleApiConsumeInteractiveEscalation(req, res);
            return;
          }
          if (
            pathname === '/api/interactive-escalations/sms-reply' &&
            method === 'POST'
          ) {
            await handleApiSmsReplyInteractiveEscalation(
              req,
              res,
              activeSseResponses,
            );
            return;
          }
          if (
            pathname === '/api/admin/policy' &&
            (method === 'PUT' || method === 'DELETE')
          ) {
            await handleApiAdminPolicy(req, res, url);
            return;
          }
          if (pathname === '/api/admin/tools' && method === 'GET') {
            await handleApiAdminTools(res);
            return;
          }
          if (pathname === '/api/admin/plugins' && method === 'GET') {
            await handleApiAdminPlugins(res);
            return;
          }
          if (pathname === '/api/admin/output-guard') {
            await handleApiAdminOutputGuard(req, res);
            return;
          }
          if (pathname === '/api/admin/output-guard/preview') {
            await handleApiAdminOutputGuardPreview(req, res);
            return;
          }
          if (
            pathname === '/api/admin/distill' ||
            pathname.startsWith('/api/admin/distill/')
          ) {
            await handleApiAdminDistill(req, res, url);
            return;
          }
          if (pathname === '/api/admin/skills') {
            await handleApiAdminSkills(req, res);
            return;
          }
          if (pathname === '/api/admin/skills/unblock') {
            await handleApiAdminSkillUnblock(req, res);
            return;
          }
          if (pathname === '/api/admin/skills/upload') {
            await handleApiAdminSkillUpload(req, res);
            return;
          }
          if (pathname.startsWith('/api/admin/skills/')) {
            await handleApiAdminSkillPackageFiles(req, res, url);
            return;
          }
          if (pathname === '/api/admin/jobs/context' && method === 'GET') {
            handleApiAdminJobsContext(res);
            return;
          }
          if (pathname === '/api/admin/jobs/budgets' && method === 'GET') {
            handleApiAdminJobsBudgets(res, url);
            return;
          }
          if (
            pathname === '/api/admin/jobs/edges' &&
            (method === 'GET' || method === 'POST' || method === 'DELETE')
          ) {
            await handleApiAdminJobsEdges(req, res, url);
            return;
          }
          if (
            pathname === '/api/admin/jobs/edge-revisions' &&
            (method === 'GET' || method === 'POST')
          ) {
            await handleApiAdminJobsEdgeRevisions(req, res, url);
            return;
          }
          if (pathname === '/api/admin/jobs/blocked' && method === 'GET') {
            handleApiAdminJobsBlocked(res, url);
            return;
          }
          if (
            pathname === '/api/admin/terminal' &&
            (method === 'POST' || method === 'DELETE')
          ) {
            await handleApiAdminTerminal(req, res, url, terminalManager);
            return;
          }
          if (pathname === '/api/history' && method === 'GET') {
            await handleApiHistory(req, res, url);
            return;
          }
          if (pathname === '/api/chat/recent' && method === 'GET') {
            handleApiChatRecent(req, res, url);
            return;
          }
          if (pathname === '/api/chat/cleanup' && method === 'POST') {
            handleApiChatCleanup(res, url);
            return;
          }
          if (pathname === '/api/chat/mobile-qr' && method === 'POST') {
            await handleApiChatMobileQr(req, res);
            return;
          }
          if (pathname === '/api/chat/commands' && method === 'GET') {
            handleApiChatCommands(res, url);
            return;
          }
          if (pathname === '/api/chat/context' && method === 'GET') {
            handleApiChatContext(res, url);
            return;
          }
          if (pathname === '/api/agents' && method === 'GET') {
            await handleApiAgents(res);
            return;
          }
          if (pathname === '/api/agents/list' && method === 'GET') {
            await handleApiAgentList(res);
            return;
          }
          if (pathname === '/api/proactive/pull' && method === 'GET') {
            handleApiProactivePull(res, url);
            return;
          }
          if (pathname === '/api/admin/shutdown' && method === 'POST') {
            handleApiShutdown(res);
            return;
          }
          if (pathname === '/api/admin/restart' && method === 'POST') {
            handleApiRestart(res);
            return;
          }

          if (pathname === '/api/admin/config/reload' && method === 'POST') {
            handleApiConfigReload(res);
            return;
          }
          if (pathname === '/api/chat' && method === 'POST') {
            await handleApiChat(req, res);
            return;
          }
          if (pathname === '/api/chat/branch' && method === 'POST') {
            await handleApiChatBranch(req, res);
            return;
          }
          if (pathname === '/api/chat/rating' && method === 'POST') {
            await handleApiChatRating(req, res);
            return;
          }
          if (pathname === '/api/media/upload' && method === 'POST') {
            await handleApiMediaUpload(req, res);
            return;
          }
          if (pathname === '/api/command' && method === 'POST') {
            await handleApiCommand(req, res);
            return;
          }
          if (pathname === '/api/message/action' && method === 'POST') {
            await handleApiMessageAction(req, res);
            return;
          }
          if (pathname === '/api/plugin/tool' && method === 'POST') {
            await handleApiPluginTool(req, res);
            return;
          }
          if (pathname === '/api/http/request' && method === 'POST') {
            await handleApiHttpRequest(req, res);
            return;
          }
          if (pathname === '/api/browser/tool' && method === 'POST') {
            if (!hasGatewayApiAuth(req)) {
              sendJson(res, 401, {
                error:
                  'Unauthorized. Set `Authorization: Bearer <GATEWAY_API_TOKEN>`.',
              });
              return;
            }
            await handleApiBrowserTool(req, res, activeSseResponses);
            return;
          }
          if (pathname === '/api/secret/inject' && method === 'POST') {
            if (!hasGatewayApiAuth(req)) {
              sendJson(res, 401, {
                error:
                  'Unauthorized. Set `Authorization: Bearer <GATEWAY_API_TOKEN>`.',
              });
              return;
            }
            await handleApiSecretInject(req, res);
            return;
          }
          if (pathname === '/api/discord/action' && method === 'POST') {
            await handleApiMessageAction(req, res);
            return;
          }
          sendJson(res, 404, { error: 'Not Found' });
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const statusCode =
            err instanceof GatewayRequestError ? err.statusCode : 500;
          sendJson(res, statusCode, { error: errorText });
        }
      })();
      return;
    }

    if (pathname.startsWith('/v1/')) {
      const authContext = resolveAuthContext(req, url);
      if (authContext.kind === 'none') {
        sendJson(res, 401, {
          error: {
            message:
              'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
            type: 'authentication_error',
            param: null,
            code: null,
          },
        });
        return;
      }
      if (
        authContext.payload !== null &&
        !isAdminActionAllowed(authContext.payload, 'openai.api')
      ) {
        sendJson(res, 403, {
          error: {
            message: 'Forbidden.',
            type: 'authentication_error',
            param: null,
            code: null,
          },
        });
        return;
      }

      void (async () => {
        if (pathname === '/v1/models' && method === 'GET') {
          await handleOpenAICompatibleModelList(res);
          return;
        }
        if (pathname === '/v1/chat/completions' && method === 'POST') {
          await handleOpenAICompatibleChatCompletions(req, res);
          return;
        }
        if (method === 'GET' && pathname.startsWith('/v1/chat/completions/')) {
          const id = decodeURIComponent(
            pathname.slice('/v1/chat/completions/'.length),
          );
          await handleOpenAICompatibleCompletionRetrieve(req, res, id, url);
          return;
        }
        sendJson(res, 404, {
          error: {
            message: 'Not Found',
            type: 'invalid_request_error',
            param: null,
            code: null,
          },
        });
      })().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'OpenAI-compatible API request failed');
        sendJson(res, 500, {
          error: {
            message,
            type: 'server_error',
            param: null,
            code: null,
          },
        });
      });
      return;
    }

    if (pathname.startsWith('/assets/')) {
      if (serveConsoleAsset(pathname, res)) return;
      sendText(res, 404, 'Not Found');
      return;
    }

    if (pathname.startsWith('/icons/')) {
      if (serveConsoleAsset(pathname, res)) return;
      sendText(res, 404, 'Not Found');
      return;
    }

    if (canUseDevViteProxy(req) && isViteSourcePath(pathname)) {
      proxyToVite(req, res, pathname + url.search);
      return;
    }

    if (requiresSessionAuth(pathname) && !ensureSessionAuth(req, res)) {
      return;
    }

    if (isLocalWebSurfacePath(pathname)) {
      if (!WEB_API_TOKEN && !isLoopbackHost(HEALTH_HOST)) {
        sendText(
          res,
          401,
          'Unauthorized. Configure WEB_API_TOKEN before exposing the web console on a non-loopback host.',
        );
        return;
      }
      if (isLocalWebSessionAllowed(req)) {
        setLocalWebSessionCookie(res);
      }
    }

    if (isConsoleSpaPath(pathname)) {
      if (canUseDevViteProxy(req)) {
        proxyToVite(req, res, '/');
        return;
      }
      if (serveConsoleIndex(pathname, res)) return;
      sendText(
        res,
        503,
        'Admin console assets not found. Run `npm run build:console`.',
      );
      return;
    }

    if (serveStatic(url, res)) return;
    sendText(res, 404, 'Not Found');
  });

  server.on('upgrade', (req, socket, head) => {
    const host = String(req.headers.host || 'localhost');
    const url = new URL(req.url || '/', `http://${host}`);

    if (
      isA2ALocalModeEnabled(getRuntimeConfig()) &&
      !isLoopbackWebRequest(req)
    ) {
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }

    if (handleVoiceUpgrade(req, socket, head, url)) {
      return;
    }

    if (url.pathname !== '/api/admin/terminal/stream') {
      if (canUseDevViteProxy(req)) {
        proxyViteUpgrade(req, socket, head);
        return;
      }
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }

    const sessionPayload = getSessionAuthPayload(req);
    const sessionAuthenticated = sessionPayload !== null;
    const tokenAuthenticated =
      resolveAuthContext(req, url, {
        allowApiTokens: false,
        allowQueryToken: false,
      }).kind !== 'none';
    const requestAuthContext = resolveAuthContext(req, url, {
      allowApiTokens: false,
      allowQueryToken: false,
      allowLocalWebSession: true,
      requireSameOrigin: true,
    });
    if (
      !sessionAuthenticated &&
      !tokenAuthenticated &&
      isLocalWebSessionAllowed(req) &&
      hasLocalWebSessionAuth(req) &&
      !hasSameGatewayOrigin(req)
    ) {
      writeUpgradeError(socket, 401, 'Unauthorized');
      return;
    }
    const requestAuthenticated = requestAuthContext.kind !== 'none';
    if (
      !sessionAuthenticated &&
      !WEB_API_TOKEN &&
      !GATEWAY_API_TOKEN &&
      !requestAuthenticated
    ) {
      writeUpgradeError(socket, 401, 'Unauthorized');
      return;
    }

    const terminalStreamAction = resolveAdminRbacAction(url.pathname, 'GET');
    const terminalRbacContext: ResolvedAuthContext = sessionAuthenticated
      ? { kind: 'session', payload: sessionPayload }
      : requestAuthContext;
    if (
      terminalStreamAction &&
      !isAdminRouteActionAllowed(terminalRbacContext, terminalStreamAction)
    ) {
      writeUpgradeError(socket, 403, 'Forbidden');
      return;
    }

    if (
      !terminalManager.handleUpgrade(req, socket, head, url, {
        hasSessionAuth: sessionAuthenticated,
        hasRequestAuth: requestAuthenticated,
        validateToken: hasApiTokenValue,
      })
    ) {
      writeUpgradeError(socket, 404, 'Not Found');
    }
  });

  server.listen(HEALTH_PORT, HEALTH_HOST, () => {
    logger.info(
      { host: HEALTH_HOST, port: HEALTH_PORT },
      'Gateway HTTP server started',
    );
  });

  return {
    setReady(): void {
      gatewayReady = true;
    },
    broadcastShutdown(): void {
      const shutdownMessage: AdminTerminalServerMessage = {
        type: 'shutdown',
        restartExpectedMs: 1500,
      };
      const shutdownPayload = JSON.stringify(shutdownMessage);
      terminalManager.broadcastShutdown(shutdownMessage);
      for (const sseRes of activeSseResponses) {
        try {
          if (!sseRes.writableEnded) {
            sseRes.write(`event: shutdown\ndata: ${shutdownPayload}\n\n`);
            sseRes.end();
          }
        } catch {
          // Ignore errors on already-closed responses.
        }
      }
      activeSseResponses.clear();
    },
  };
}
