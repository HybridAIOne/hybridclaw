import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import { getAgentById, resolveAgentConfig } from '../agents/agent-registry.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import {
  type DiscordToolActionRequest,
  normalizeDiscordToolAction,
} from '../channels/discord/tool-actions.js';
import { normalizeEmailAddress } from '../channels/email/allowlist.js';
import { handleIMessageWebhook } from '../channels/imessage/runtime.js';
import { runMessageToolAction } from '../channels/message/tool-actions.js';
import { handleMSTeamsWebhook } from '../channels/msteams/runtime.js';
import {
  handleVoiceUpgrade,
  handleVoiceWebhook,
} from '../channels/voice/runtime.js';
import { resolveVoiceWebhookPaths } from '../channels/voice/twilio-manager.js';
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
import { logger } from '../logger.js';
import { summarizeMediaFilenames } from '../media/media-summary.js';
import { normalizeMimeType } from '../media/mime-utils.js';
import {
  resolveUploadedMediaCacheHostDir,
  UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
  writeUploadedMediaCacheFile,
} from '../media/uploaded-media-cache.js';
import { claimQueuedProactiveMessages } from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { listLoadedPluginCommands } from '../plugins/plugin-manager.js';
import { isPluginInboundWebhookPath } from '../plugins/plugin-webhooks.js';
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
import { normalizeTrimmedUniqueStringArray } from '../utils/normalized-strings.js';
import {
  AdminTerminalCapacityError,
  type AdminTerminalStartOptions,
  createAdminTerminalManager,
} from './admin-terminal.js';
import type { AdminTerminalServerMessage } from './admin-terminal-protocol.js';
import {
  hasSessionAuth,
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
import { handleGatewayMessage } from './gateway-chat-service.js';
import { handleApiHttpRequest } from './gateway-http-proxy.js';
import {
  parsePositiveInteger,
  readJsonBody,
  readRequestBody,
  sendJson,
} from './gateway-http-utils.js';
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
import {
  applyGatewayAdminPolicyPreset,
  createGatewayAdminAgent,
  createGatewayAdminSkill,
  deleteGatewayAdminAgent,
  deleteGatewayAdminEmailMessage,
  deleteGatewayAdminPolicyRule,
  deleteGatewayAdminSession,
  ensureGatewayBootstrapAutostart,
  getGatewayAdminAgentMarkdownFile,
  getGatewayAdminAgentMarkdownRevision,
  getGatewayAdminAgents,
  getGatewayAdminApprovals,
  getGatewayAdminAudit,
  getGatewayAdminChannels,
  getGatewayAdminConfig,
  getGatewayAdminEmailFolder,
  getGatewayAdminEmailMailbox,
  getGatewayAdminEmailMessage,
  getGatewayAdminJobsContext,
  getGatewayAdminMcp,
  getGatewayAdminModels,
  getGatewayAdminOverview,
  getGatewayAdminSessions,
  getGatewayAdminSkills,
  getGatewayAdminTools,
  getGatewayAgents,
  getGatewayAssistantPresentationForSession,
  getGatewayBootstrapAutostartState,
  getGatewayHistory,
  getGatewayHistorySummary,
  getGatewayRecentChatSessions,
  getGatewayStatus,
  handleGatewayCommand,
  removeGatewayAdminChannel,
  removeGatewayAdminMcpServer,
  restoreGatewayAdminAgentMarkdownRevision,
  saveGatewayAdminAgentMarkdownFile,
  saveGatewayAdminConfig,
  saveGatewayAdminModels,
  saveGatewayAdminPolicyDefault,
  saveGatewayAdminPolicyRule,
  setGatewayAdminSkillEnabled,
  updateGatewayAdminAgent,
  uploadGatewayAdminSkillZip,
  upsertGatewayAdminChannel,
  upsertGatewayAdminMcpServer,
} from './gateway-service.js';
import type {
  GatewayChatBranchRequestBody,
  GatewayChatRequest,
  GatewayChatRequestBody,
  GatewayChatResult,
  GatewayCommandRequest,
} from './gateway-types.js';
import { resolveWorkspaceRelativePath } from './gateway-utils.js';
import { consumeGatewayMediaUploadQuota } from './media-upload-quota.js';
import {
  handleOpenAICompatibleChatCompletions,
  handleOpenAICompatibleModelList,
} from './openai-compatible.js';
import {
  handleTextChannelApprovalCommand,
  renderTextChannelCommandResult,
  resolveTextChannelSlashCommands,
} from './text-channel-commands.js';

const SITE_DIR = resolveInstallPath('docs');
const CONSOLE_DIST_DIR = resolveInstallPath('console', 'dist');
const AGENT_ARTIFACT_ROOT = path.resolve(path.join(DATA_DIR, 'agents'));
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
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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
  presetName?: unknown;
  rule?: unknown;
};

// Keep this local instead of importing the container helper. The gateway and
// container ship as separate packages and intentionally normalize request
// payloads at their own trust boundaries.
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

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

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

  for (const args of slashCommands) {
    if ((args[0] || '').trim().toLowerCase() === 'approve') {
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

    const commandResult = await handleGatewayCommand({
      sessionId,
      sessionMode: chatRequest.sessionMode,
      guildId: chatRequest.guildId,
      channelId: chatRequest.channelId,
      args,
      userId: chatRequest.userId,
      username: chatRequest.username,
    });
    sessionId = commandResult.sessionId || sessionId;
    sessionKey = commandResult.sessionKey || sessionKey;
    mainSessionKey = commandResult.mainSessionKey || mainSessionKey;
    const text = renderTextChannelCommandResult(commandResult).trim();
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

  return {
    status: 'success',
    result:
      renderedText ||
      (handledApprovalCommand ? 'Approval submitted.' : 'Done.'),
    toolsUsed: [],
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(mainSessionKey ? { mainSessionKey } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(pendingApproval ? { pendingApproval } : {}),
  };
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

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function hasQueryToken(url: URL): boolean {
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return false;
  if (WEB_API_TOKEN && token === WEB_API_TOKEN) return true;
  return token === GATEWAY_API_TOKEN;
}

function hasApiAuth(
  req: IncomingMessage,
  url?: URL,
  opts?: { allowQueryToken?: boolean },
): boolean {
  const authHeader = req.headers.authorization || '';
  const gatewayTokenMatch =
    Boolean(GATEWAY_API_TOKEN) && authHeader === `Bearer ${GATEWAY_API_TOKEN}`;
  if (opts?.allowQueryToken && url && hasQueryToken(url)) return true;

  if (!WEB_API_TOKEN) {
    return gatewayTokenMatch || isLoopbackAddress(req.socket.remoteAddress);
  }
  if (authHeader === `Bearer ${WEB_API_TOKEN}`) return true;
  return gatewayTokenMatch;
}

function hasApiTokenValue(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (WEB_API_TOKEN && trimmed === WEB_API_TOKEN) return true;
  return Boolean(GATEWAY_API_TOKEN) && trimmed === GATEWAY_API_TOKEN;
}

function resolveApiMediaUploadQuotaKey(req: IncomingMessage): string {
  const authHeader = req.headers.authorization || '';
  if (WEB_API_TOKEN && authHeader === `Bearer ${WEB_API_TOKEN}`) {
    return 'web-token';
  }
  if (GATEWAY_API_TOKEN && authHeader === `Bearer ${GATEWAY_API_TOKEN}`) {
    return 'gateway-token';
  }

  const normalizedAddress = String(req.socket.remoteAddress || '')
    .replace(/^::ffff:/, '')
    .trim();
  if (isLoopbackAddress(req.socket.remoteAddress)) {
    return `loopback:${normalizedAddress || 'unknown'}`;
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

function resolveHybridAILoginUrl(): string | null {
  const baseUrl = HYBRIDAI_BASE_URL.trim().replace(/\/+$/, '');
  if (!baseUrl) return null;
  return `${baseUrl}${HYBRIDAI_LOGIN_PATH}`;
}

function requiresSessionAuth(pathname: string): boolean {
  if (!getSandboxAutoDetectionState().runningInsideContainer) {
    return false;
  }

  return (
    pathname === '/chat' ||
    pathname === '/chat.html' ||
    pathname === '/agents' ||
    pathname === '/agents.html' ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
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

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function resolvePathForContainmentCheck(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
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

function resolveValidatedApiChatMediaHostPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (matchesDisplayPathAlias(trimmed, DISCORD_MEDIA_CACHE_ROOT_DISPLAY)) {
    const resolved = resolveDisplayPathAlias(
      trimmed,
      DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
      DISCORD_MEDIA_CACHE_DIR,
    );
    return resolved ? resolvePathForContainmentCheck(resolved) : null;
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
    return resolved ? resolvePathForContainmentCheck(resolved) : null;
  }

  if (!path.isAbsolute(trimmed)) {
    return null;
  }

  return resolvePathForContainmentCheck(trimmed);
}

function isAllowedApiChatMediaHostPath(hostPath: string): boolean {
  const normalizedHostPath = resolvePathForContainmentCheck(hostPath);
  if (
    isWithinRoot(
      normalizedHostPath,
      resolvePathForContainmentCheck(DISCORD_MEDIA_CACHE_DIR),
    )
  ) {
    return true;
  }

  const uploadedMediaCacheDir = getUploadedMediaCacheDirOrNull();
  if (!uploadedMediaCacheDir) {
    return false;
  }
  return isWithinRoot(
    normalizedHostPath,
    resolvePathForContainmentCheck(uploadedMediaCacheDir),
  );
}

function normalizeApiChatMediaItems(raw: unknown): MediaContextItem[] {
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

    const resolvedHostPath = resolveValidatedApiChatMediaHostPath(pathValue);
    if (!resolvedHostPath || !isAllowedApiChatMediaHostPath(resolvedHostPath)) {
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

function resolveArtifactFile(url: URL): string | null {
  const raw = (url.searchParams.get('path') || '').trim();
  if (!raw) return null;
  const resolved = resolveArtifactRequestPath(raw);
  if (!resolved) return null;
  const uploadedMediaCacheDir = getUploadedMediaCacheDirOrNull();
  let realFilePath: string;
  try {
    realFilePath = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (
    !isWithinRoot(
      realFilePath,
      resolvePathForContainmentCheck(AGENT_ARTIFACT_ROOT),
    ) &&
    !isWithinRoot(
      realFilePath,
      resolvePathForContainmentCheck(DISCORD_MEDIA_CACHE_DIR),
    ) &&
    !(
      uploadedMediaCacheDir &&
      isWithinRoot(
        realFilePath,
        resolvePathForContainmentCheck(uploadedMediaCacheDir),
      )
    )
  ) {
    return null;
  }
  if (!fs.existsSync(realFilePath) || !fs.statSync(realFilePath).isFile())
    return null;
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
    pathname === '/chat'
      ? '/chat.html'
      : pathname === '/agents'
        ? '/agents.html'
        : pathname,
  );
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(fs.readFileSync(filePath));
  return true;
}

function resolveConsoleFile(pathname: string): string | null {
  const subPath = pathname.replace(/^\/admin/, '') || '/index.html';
  const directFile = resolveStaticFile(CONSOLE_DIST_DIR, subPath);
  if (directFile) return directFile;
  return resolveStaticFile(CONSOLE_DIST_DIR, '/index.html');
}

function serveConsole(pathname: string, res: ServerResponse): boolean {
  const filePath = resolveConsoleFile(pathname);
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Cache-Control': filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

async function handleApiChat(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<ApiChatRequestBody>;
  const wantsStream = body.stream === true;
  const media = normalizeApiChatMediaItems(body.media);

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
  const chatRequest: GatewayChatRequest = {
    sessionId,
    sessionMode:
      body.sessionMode === 'resume' || body.sessionMode === 'new'
        ? body.sessionMode
        : undefined,
    guildId: body.guildId ?? null,
    channelId: body.channelId || 'web',
    userId: normalizeOptionalString(body.userId) || sessionId,
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
    (await resolveApiChatSlashCommandResult(chatRequest)) ||
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

  const slashResult = await resolveApiChatSlashCommandResult(chatRequest);
  if (slashResult) {
    const filteredResult = filterChatResultForSession(
      slashResult.sessionId || chatRequest.sessionId,
      slashResult,
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
    userId: normalizeOptionalString(body.userId) || sessionId,
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

async function handleApiHistory(res: ServerResponse, url: URL): Promise<void> {
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
  void ensureGatewayBootstrapAutostart({ sessionId }).catch((error) => {
    logger.warn(
      { sessionId, error },
      'Failed to start gateway bootstrap autostart',
    );
  });
  const historyPage = getGatewayHistory(sessionId, limit);
  const summary = getGatewayHistorySummary(sessionId, {
    sinceMs: Number.isNaN(parsedSummarySinceMs) ? null : parsedSummarySinceMs,
  });
  const bootstrapAutostart = getGatewayBootstrapAutostartState({ sessionId });
  // These keys are returned only as chat-routing metadata for the web client.
  // Auth stays anchored to the existing API/session auth checks above, never to
  // sessionKey/mainSessionKey. If these fields ever become auth-sensitive,
  // remove them from this response instead of widening their meaning here.
  sendJson(res, 200, {
    sessionId,
    sessionKey: historyPage.sessionKey || undefined,
    mainSessionKey: historyPage.mainSessionKey || undefined,
    history: historyPage.history,
    assistantPresentation: getGatewayAssistantPresentationForSession(sessionId),
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
  if (!hasApiAuth(req, url)) {
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

function handleApiChatRecent(res: ServerResponse, url: URL): void {
  const userId = (url.searchParams.get('userId') || '').trim();
  if (!userId) {
    sendJson(res, 400, { error: 'Missing `userId` query parameter.' });
    return;
  }
  const channelId = (url.searchParams.get('channelId') || 'web').trim();
  const parsedLimit = parseInt(url.searchParams.get('limit') || '10', 10);
  const limit = Number.isNaN(parsedLimit) ? 10 : parsedLimit;
  sendJson(res, 200, {
    sessions: getGatewayRecentChatSessions({
      userId,
      channelId,
      limit,
    }),
  });
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

function handleApiAdminJobsContext(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAdminJobsContext());
}

function handleApiProactivePull(res: ServerResponse, url: URL): void {
  const channelId = (url.searchParams.get('channelId') || '').trim();
  if (!channelId) {
    sendJson(res, 400, { error: 'Missing `channelId` query parameter.' });
    return;
  }
  const parsedLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;
  const messages = claimQueuedProactiveMessages(channelId, limit);
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

async function handleApiAdminOverview(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getGatewayAdminOverview());
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
  workspace?: unknown;
};

type ApiAdminAgentPayload = {
  id?: string;
  name?: string;
  model?: string;
  skills?: string[] | null;
  chatbotId?: string;
  enableRag?: boolean;
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
    /^Revision ["`].+["`] was not found\.$/.test(message);
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

async function readApiAdminAgentPayload(
  req: IncomingMessage,
  options?: { requireId?: boolean },
): Promise<ApiAdminAgentPayload> {
  const body = (await readJsonBody(req)) as ApiAdminAgentPayloadBody;
  const payload: ApiAdminAgentPayload = {
    id: String(body.id || '').trim() || undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    skills: normalizeApiAdminAgentSkills(body.skills),
    chatbotId: typeof body.chatbotId === 'string' ? body.chatbotId : undefined,
    enableRag: typeof body.enableRag === 'boolean' ? body.enableRag : undefined,
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

  const activeHandle = handles.find((h) => h.status === 'active') || handles[0];
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
        : 'config';
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
        : 'config';
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
  sendJson(
    res,
    200,
    getGatewayAdminAudit({
      query: url.searchParams.get('query') || '',
      sessionId: url.searchParams.get('sessionId') || '',
      eventType: url.searchParams.get('eventType') || '',
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

  try {
    const buffer = await readRequestBody(req, MAX_SKILL_ZIP_UPLOAD_BYTES);
    if (buffer.length === 0) {
      sendJson(res, 400, {
        error: 'Expected a non-empty skill zip upload body.',
      });
      return;
    }
    sendJson(res, 201, await uploadGatewayAdminSkillZip(buffer));
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

function handleApiArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (!hasApiAuth(req, url, { allowQueryToken: true })) {
    sendJson(res, 401, {
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass `?token=<WEB_API_TOKEN>`.',
    });
    return;
  }

  const filePath = resolveArtifactFile(url);
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
      void getGatewayStatus().then(
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
        // Respond with a small HTML page that stores the WEB_API_TOKEN in
        // localStorage before redirecting.  This lets the console make
        // Bearer-authenticated API calls without ever showing the manual
        // token prompt.  The token never appears in the URL (avoiding
        // leaks via browser history, referrer headers, or server logs).
        if (WEB_API_TOKEN) {
          // Escape for safe inline-script embedding: JSON.stringify handles
          // JS-level escaping, then replace `<` to prevent the HTML parser
          // from closing the <script> block early (e.g. a token containing
          // "</script>").
          const escaped = JSON.stringify(WEB_API_TOKEN).replace(
            /</g,
            '\\u003c',
          );
          const escapedRedirect = JSON.stringify(redirectTo).replace(
            /</g,
            '\\u003c',
          );
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'unsafe-inline'",
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(
            `<!DOCTYPE html><html><body><script>` +
              `localStorage.setItem('hybridclaw_token',${escaped});` +
              `window.location.replace(${escapedRedirect});` +
              `</script></body></html>`,
          );
        } else {
          sendRedirect(res, 302, redirectTo);
        }
      } catch {
        sendText(res, 401, 'Unauthorized. Invalid or expired auth token.');
      }
      return;
    }

    const voicePaths = resolveVoiceWebhookPaths(
      getRuntimeConfig().voice.webhookPath,
    );
    if (
      method === 'POST' &&
      (pathname === voicePaths.webhookPath ||
        pathname === voicePaths.actionPath)
    ) {
      dispatchWebhookRoute(res, () => handleVoiceWebhook(req, res, url));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === MSTEAMS_WEBHOOK_PATH && method === 'POST') {
        dispatchWebhookRoute(res, () => handleMSTeamsWebhook(req, res));
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
        try {
          handleApiArtifact(req, res, url);
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const statusCode =
            err instanceof GatewayRequestError ||
            err instanceof AdminTerminalCapacityError
              ? err.statusCode
              : 500;
          sendJson(res, statusCode, { error: errorText });
        }
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
          allowQueryToken: pathname === '/api/events',
        })
      ) {
        sendJson(res, 401, {
          error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
        });
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
          if (
            pathname === '/api/admin/agents' ||
            pathname.startsWith('/api/admin/agents/')
          ) {
            await handleApiAdminAgents(req, res, url);
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
            pathname === '/api/admin/email-config/fetch' &&
            method === 'GET'
          ) {
            await handleApiAdminEmailConfigFetch(res);
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
          if (pathname === '/api/admin/skills') {
            await handleApiAdminSkills(req, res);
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
          if (
            pathname === '/api/admin/terminal' &&
            (method === 'POST' || method === 'DELETE')
          ) {
            await handleApiAdminTerminal(req, res, url, terminalManager);
            return;
          }
          if (pathname === '/api/history' && method === 'GET') {
            await handleApiHistory(res, url);
            return;
          }
          if (pathname === '/api/chat/recent' && method === 'GET') {
            handleApiChatRecent(res, url);
            return;
          }
          if (pathname === '/api/chat/commands' && method === 'GET') {
            handleApiChatCommands(res, url);
            return;
          }
          if (pathname === '/api/agents' && method === 'GET') {
            await handleApiAgents(res);
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

    if (requiresSessionAuth(pathname) && !ensureSessionAuth(req, res)) {
      return;
    }

    if (pathname.startsWith('/admin')) {
      if (serveConsole(pathname, res)) return;
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
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }

    const sessionAuthenticated = hasSessionAuth(req);
    const requestAuthenticated = hasApiAuth(req, url, {
      allowQueryToken: false,
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
