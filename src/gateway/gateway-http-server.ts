import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
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
import { handleA2APairingRequestInbound } from '../a2a/pairing.js';
import {
  handleA2AWebhookInbound,
  parseA2AWebhookInboundPath,
} from '../a2a/webhook-inbound.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import { getAgentById, resolveAgentConfig } from '../agents/agent-registry.js';
import {
  type AgentProxyConfig,
  DEFAULT_AGENT_ID,
  normalizeAgentProxyConfig,
  resolveSnakeCamelAlias,
} from '../agents/agent-types.js';
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
  claimQueuedProactiveMessages,
  enqueueProactiveMessage,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { listLoadedPluginCommands } from '../plugins/plugin-manager.js';
import { isPluginInboundWebhookPath } from '../plugins/plugin-webhooks.js';
import {
  type AdminRbacAction,
  isAdminActionAllowed,
  resolveAdminRbacAction,
} from '../security/admin-rbac.js';
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
import type { MediaContextItem } from '../types/container.js';
import type { PendingApproval, ToolProgressEvent } from '../types/execution.js';
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
import { serveDocs } from './docs.js';
import {
  getGatewayAdminSecrets,
  overwriteGatewayAdminSecret,
  recordGatewayAdminSecretMutationFailure,
  unsetGatewayAdminSecret,
} from './gateway-admin-secrets.js';
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
  getGatewayAdminModels,
  getGatewayAdminOverview,
  getGatewayAdminSessions,
  getGatewayAdminSkills,
  getGatewayAdminStatistics,
  getGatewayAdminTeamStructure,
  getGatewayAdminTeamStructureRevision,
  getGatewayAdminTools,
  getGatewayAgentList,
  getGatewayAgents,
  getGatewayBootstrapAutostartState,
  getGatewayHistory,
  getGatewayHistorySummary,
  getGatewayRecentChatSessions,
  getGatewaySessionContextUsage,
  getGatewayStatus,
  handleGatewayCommand,
  previewGatewayAdminA2APairing,
  reconnectGatewayAdminTunnel,
  removeGatewayAdminChannel,
  removeGatewayAdminMcpServer,
  restoreGatewayAdminAgentMarkdownRevision,
  restoreGatewayAdminTeamStructureRevision,
  revokeGatewayAdminA2ATrustPeer,
  saveGatewayAdminAgentMarkdownFile,
  saveGatewayAdminConfig,
  saveGatewayAdminDiscordWebhookTarget,
  saveGatewayAdminModels,
  saveGatewayAdminPolicyDefault,
  saveGatewayAdminPolicyLanHttpAccess,
  saveGatewayAdminPolicyRule,
  saveGatewayAdminSlackWebhookTarget,
  setGatewayAdminSkillEnabled,
  startGatewayAdminA2APairing,
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
  handleOpenAICompatibleChatCompletions,
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

function hasQueryToken(url: URL): boolean {
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return false;
  if (WEB_API_TOKEN && safeEqualToken(token, WEB_API_TOKEN)) return true;
  return Boolean(GATEWAY_API_TOKEN) && safeEqualToken(token, GATEWAY_API_TOKEN);
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

function resolveRequestOriginForAuth(req: IncomingMessage): string | null {
  const host = String(req.headers.host || '').trim();
  if (!host) return null;
  const protocol = requestUsesHttps(req) ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function hasSameGatewayOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return false;
  return origin === resolveRequestOriginForAuth(req);
}

function hasApiAuth(
  req: IncomingMessage,
  url?: URL,
  opts?: {
    allowLocalWebSession?: boolean;
    allowQueryToken?: boolean;
    allowSessionCookie?: boolean;
    requireSameOrigin?: boolean;
  },
): boolean {
  const authHeader = req.headers.authorization || '';
  const gatewayTokenMatch = hasBearerToken(authHeader, GATEWAY_API_TOKEN);
  if (opts?.allowQueryToken && url && hasQueryToken(url)) return true;

  if (hasBearerToken(authHeader, WEB_API_TOKEN)) return true;
  if (
    opts?.allowSessionCookie &&
    hasSessionAuth(req) &&
    (!opts.requireSameOrigin || hasSameGatewayOrigin(req))
  ) {
    return true;
  }
  if (
    opts?.allowLocalWebSession &&
    isLocalWebSessionAllowed(req) &&
    hasLocalWebSessionAuth(req) &&
    (!opts.requireSameOrigin || hasSameGatewayOrigin(req))
  ) {
    return true;
  }
  return gatewayTokenMatch;
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

function resolveAdminSecretAuditContext(
  req: IncomingMessage,
  sessionPayload: Record<string, unknown> | null,
): {
  sessionId?: string;
  actor?: string | null;
  sourceIp?: string | null;
} {
  return {
    sessionId: resolveAdminSessionAuditId(sessionPayload) || undefined,
    actor: resolveAdminSessionActor(sessionPayload),
    sourceIp: req.socket.remoteAddress || null,
  };
}

function shouldDeferAdminRbacToHandler(action: AdminRbacAction): boolean {
  return action.startsWith('secret.');
}

function isAdminRouteActionAllowed(
  req: IncomingMessage,
  action: AdminRbacAction,
): boolean {
  return isAdminActionAllowed(getSessionAuthPayload(req), action);
}

function enforceAdminRouteRbac(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): boolean {
  const action = resolveAdminRbacAction(pathname, method);
  if (!action || shouldDeferAdminRbacToHandler(action)) return true;
  if (isAdminRouteActionAllowed(req, action)) return true;
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

function normalizePublicBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function resolveRequestOrigin(
  req: IncomingMessage,
  bodyBaseUrl?: unknown,
): string {
  const explicitBaseUrl = normalizePublicBaseUrl(bodyBaseUrl);
  if (explicitBaseUrl) return explicitBaseUrl;

  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    ?.trim();
  const proto = requestUsesHttps(req) ? 'https' : 'http';
  const host = forwardedHost || req.headers.host || `127.0.0.1:${HEALTH_PORT}`;
  return `${proto}://${host}`;
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
    pathname.startsWith('/chat/')
  );
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
    ...(isIndex
      ? {
          'Content-Security-Policy':
            "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:",
        }
      : {}),
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

function serveConsoleAsset(pathname: string, res: ServerResponse): boolean {
  return serveConsoleFile(resolveStaticFile(CONSOLE_DIST_DIR, pathname), res);
}

function serveConsoleIndex(res: ServerResponse): boolean {
  return serveConsoleFile(
    resolveStaticFile(CONSOLE_DIST_DIR, '/index.html'),
    res,
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

  const onToolProgress = (event: ToolProgressEvent): void => {
    sendEvent({
      type: 'tool',
      toolName: event.toolName,
      phase: event.phase,
      preview: event.preview,
      durationMs: event.durationMs,
    });
  };

  const streamFilter = createSilentReplyStreamFilter();
  const onTextDelta = (delta: string): void => {
    const filteredDelta = streamFilter.push(delta);
    if (!filteredDelta) return;
    sendEvent({
      type: 'text',
      delta: filteredDelta,
    });
  };
  const onThinkingDelta = (delta: string): void => {
    if (!delta) return;
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
    sendEvent({
      type: 'result',
      result: filteredResult,
    });
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
  void ensureGatewayBootstrapAutostart({
    sessionId,
  }).catch((error) => {
    logger.warn(
      { sessionId, error },
      'Failed to start gateway bootstrap autostart',
    );
  });
  const operatorUserId = resolveGatewayRequestUserId({
    req,
    channelId: 'web',
    requestedUserId: url.searchParams.get('userId'),
    fallbackUserId: 'web',
  });
  const historyPage = getGatewayHistory(sessionId, limit, {
    operatorUserId,
  });
  const summary = getGatewayHistorySummary(sessionId, {
    sinceMs: Number.isNaN(parsedSummarySinceMs) ? null : parsedSummarySinceMs,
  });
  const bootstrapAutostart = getGatewayBootstrapAutostartState({
    sessionId,
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
  if (
    !hasApiAuth(req, url, {
      allowLocalWebSession: true,
      allowSessionCookie: true,
    })
  ) {
    sendJson(res, 401, {
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
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

function handleApiAgentList(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAgentList());
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
): void {
  const sessionPayload = getSessionAuthPayload(req);
  if (!isAdminActionAllowed(sessionPayload, 'secret.list_metadata')) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  sendJson(
    res,
    200,
    getGatewayAdminSecrets({
      audit: resolveAdminSecretAuditContext(req, sessionPayload),
      sessionPayload,
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

async function handleApiAdminSecretOverwrite(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  const sessionPayload = getSessionAuthPayload(req);
  const audit = resolveAdminSecretAuditContext(req, sessionPayload);
  if (!isAdminActionAllowed(sessionPayload, 'secret.overwrite')) {
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
  sendJson(
    res,
    200,
    overwriteGatewayAdminSecret({
      name,
      value: readAdminSecretBodyValue(body),
      audit,
    }),
  );
}

async function handleApiAdminSecretUnset(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  const sessionPayload = getSessionAuthPayload(req);
  const audit = resolveAdminSecretAuditContext(req, sessionPayload);
  if (!isAdminActionAllowed(sessionPayload, 'secret.unset')) {
    recordGatewayAdminSecretMutationFailure({
      type: 'secret.unset',
      name,
      audit,
      errorCode: 'forbidden',
    });
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  sendJson(res, 200, unsetGatewayAdminSecret({ name, audit }));
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
  proxy?: unknown;
  role?: unknown;
  reportsTo?: unknown;
  reports_to?: unknown;
  delegatesTo?: unknown;
  delegates_to?: unknown;
  peers?: unknown;
  workspace?: unknown;
};

type ApiAdminAgentPayload = {
  id?: string;
  name?: string;
  model?: string;
  skills?: string[] | null;
  chatbotId?: string;
  enableRag?: boolean;
  proxy?: AgentProxyConfig | null;
  role?: string;
  reportsTo?: string | null;
  delegatesTo?: string[] | null;
  peers?: string[] | null;
  workspace?: string;
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
          proxy: payload.proxy,
          role: payload.role,
          reportsTo: payload.reportsTo,
          delegatesTo: payload.delegatesTo,
          peers: payload.peers,
          workspace: payload.workspace,
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
  sendJson(res, 200, deleteGatewayAdminSession(sessionId));
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
  if (
    !hasApiAuth(req, url, {
      allowLocalWebSession: true,
      allowQueryToken: true,
      allowSessionCookie: true,
    })
  ) {
    sendJson(res, 401, {
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass `?token=<WEB_API_TOKEN>`.',
    });
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
      sendRedirect(res, 302, '/chat');
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

      // Determine post-auth redirect destination.  Only accept relative
      // paths (starting with `/` but not `//`) to prevent open redirects,
      // and reject values containing control characters that would be
      // invalid in HTTP headers (e.g. CR/LF from `%0d%0a`).
      const rawNext = url.searchParams.get('next');
      const safeNext =
        rawNext?.startsWith('/') &&
        !rawNext.startsWith('//') &&
        !/[\r\n\0]/.test(rawNext)
          ? rawNext
          : undefined;
      const redirectTo = safeNext ?? '/admin';

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
      const origin = resolveRequestOrigin(req);
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

    if (pathname.startsWith('/api/')) {
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

      if (
        !hasApiAuth(req, url, {
          allowQueryToken: false,
          allowLocalWebSession: true,
          allowSessionCookie: true,
          requireSameOrigin: method !== 'GET',
        })
      ) {
        recordUnauthenticatedAdminSecretMutation(req, pathname, method);
        sendJson(res, 401, {
          error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
        });
        return;
      }

      if (!enforceAdminRouteRbac(req, res, pathname, method)) {
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
          if (pathname === '/api/admin/secrets' && method === 'GET') {
            handleApiAdminSecrets(req, res);
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
              await handleApiAdminSecretOverwrite(req, res, adminSecretName);
              return;
            }
            if (method === 'DELETE') {
              await handleApiAdminSecretUnset(req, res, adminSecretName);
              return;
            }
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/secrets') {
            sendMethodNotAllowed(res);
            return;
          }
          if (pathname === '/api/admin/tunnel/reconnect' && method === 'POST') {
            await handleApiAdminTunnelReconnect(res);
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
          if (
            pathname === '/api/admin/mcp' &&
            (method === 'GET' || method === 'PUT' || method === 'DELETE')
          ) {
            await handleApiAdminMcp(req, res, url);
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
            handleApiAgentList(res);
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
      if (!hasApiAuth(req, url)) {
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

      void (async () => {
        if (pathname === '/v1/models' && method === 'GET') {
          await handleOpenAICompatibleModelList(res);
          return;
        }
        if (pathname === '/v1/chat/completions' && method === 'POST') {
          await handleOpenAICompatibleChatCompletions(req, res);
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
      if (serveConsoleIndex(res)) return;
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

    const sessionAuthenticated = hasSessionAuth(req);
    const tokenAuthenticated = hasApiAuth(req, url, {
      allowQueryToken: false,
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
    const requestAuthenticated = hasApiAuth(req, url, {
      allowQueryToken: false,
      allowLocalWebSession: true,
      requireSameOrigin: true,
    });
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
    if (
      terminalStreamAction &&
      !isAdminRouteActionAllowed(req, terminalStreamAction)
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
