import path from 'node:path';
import { isA2ALocalModeEnabled } from '../../a2a/local-mode.js';
import {
  getAgentById,
  resolveAgentForRequest,
} from '../../agents/agent-registry.js';
import { getRuntimeConfig } from '../../config/runtime-config.js';
import {
  isDiscordChannelId,
  isSupportedProactiveChannelId,
} from '../../gateway/proactive-delivery.js';
import { agentWorkspaceDir } from '../../infra/ipc.js';
import {
  enqueueProactiveMessage,
  getRecentMessages,
  getSessionById,
} from '../../memory/db.js';
import { runDiscordToolAction } from '../discord/runtime.js';
import {
  DISCORD_SEND_MEDIA_ROOT_HOST_DIR,
  resolveDiscordLocalFileForSend,
} from '../discord/send-files.js';
import type { DiscordToolActionRequest } from '../discord/tool-actions.js';
import { sendToDiscordWebhookTarget } from '../discord-webhook/runtime.js';
import { normalizeDiscordWebhookChannelTarget } from '../discord-webhook/target.js';
import { isEmailAddress, normalizeEmailAddress } from '../email/allowlist.js';
import {
  type EmailMailboxReadResult,
  readEmailMailbox,
  sendEmailAttachmentTo,
  sendToEmail,
} from '../email/runtime.js';
import { getLineAuthStatus } from '../line/auth.js';
import { sendToLineSelfChat } from '../line/runtime.js';
import { normalizeLineChannelId } from '../line/target.js';
import { sendToSignalChat } from '../signal/runtime.js';
import { normalizeSignalChannelId } from '../signal/target.js';
import { maybeRunSlackToolAction } from '../slack/tool-actions.js';
import { sendToSlackWebhookTarget } from '../slack-webhook/runtime.js';
import { normalizeSlackWebhookChannelTarget } from '../slack-webhook/target.js';
import {
  sendTelegramMediaToChat,
  sendToTelegramChat,
} from '../telegram/runtime.js';
import {
  isTelegramChannelId,
  normalizeTelegramSendTargetId,
} from '../telegram/target.js';
import { sendToThreemaChat } from '../threema/runtime.js';
import { normalizeThreemaChannelId } from '../threema/target.js';
import { getWhatsAppAuthStatus } from '../whatsapp/auth.js';
import {
  canonicalizeWhatsAppUserJid,
  isWhatsAppJid,
  normalizePhoneNumber,
  phoneToJid,
} from '../whatsapp/phone.js';
import {
  sendToWhatsAppChat,
  sendWhatsAppMediaToChat,
} from '../whatsapp/runtime.js';

const LOCAL_MESSAGE_QUEUE_LIMIT = 100;
const MESSAGE_TOOL_READ_DEFAULT_LIMIT = 20;
const MESSAGE_TOOL_READ_MAX_LIMIT = 100;
const MESSAGE_TOOL_EMAIL_SESSION_PREFIX = 'email:';
const MESSAGE_TOOL_EMAIL_MAILBOX_TARGET_RE =
  /^(?:mailbox|email(?::(?:mailbox|all|inbox|folder:.+|[^@\s]+))?)$/i;
const MESSAGE_TOOL_DISCORD_WEBHOOK_PREFIX_RE = /^discord[_-]?webhook(?::|$)/i;
const MESSAGE_TOOL_EMAIL_PREFIX_RE = /^email:/i;
const MESSAGE_TOOL_LINE_PREFIX_RE = /^line:/i;
const MESSAGE_TOOL_SIGNAL_PREFIX_RE = /^signal:/i;
const MESSAGE_TOOL_SLACK_WEBHOOK_PREFIX_RE = /^slack[_-]?webhook(?::|$)/i;
const MESSAGE_TOOL_TEAMS_CURRENT_PREFIX_RE = /^(?:msteams|teams):current$/i;
const MESSAGE_TOOL_TEAMS_SESSION_PREFIX_RE = /^teams:/i;
const MESSAGE_TOOL_TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;
const MESSAGE_TOOL_THREEMA_PREFIX_RE = /^threema:/i;
const MESSAGE_TOOL_WHATSAPP_PREFIX_RE = /^whatsapp:/i;
const MESSAGE_TOOL_DISCORD_CHANNEL_MENTION_RE = /^<#\d{16,22}>$/;
const MESSAGE_TOOL_DISCORD_PREFIXED_ID_RE =
  /^(?:channel:|discord:|user:)\d{16,22}$/i;
const MESSAGE_TOOL_LOCAL_SOURCE = 'message-tool';
const MESSAGE_TOOL_EMAIL_BODY_MAX_LENGTH = 6_000;
const MESSAGE_TOOL_CHANNEL_INSTRUCTIONS =
  'No message channel matched the request. Specify the channel explicitly: LINE `line:<linked-user-mid>`, Signal `signal:+15551234567`, Telegram `telegram:<chatId>`, Threema `threema:<id>`/`threema:phone:<number>`/`threema:email:<address>`, WhatsApp `whatsapp:+15551234567` or a WhatsApp JID, Slack `slack:<channelId>`, Slack webhook `slack_webhook`/`slack_webhook:<target>`, Discord webhook `discord_webhook`/`discord_webhook:<target>`, email `user@example.com` or `email:user@example.com`, local `tui`, or Discord with a channel snowflake/`discord:<id>`/`<#id>`/`#name` plus `guildId`.';

function resolveMessageToolSessionWorkspaceRoot(
  sessionId: string | undefined,
): string | null {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return null;

  const session = getSessionById(normalizedSessionId);
  if (!session) return null;

  const { agentId } = resolveAgentForRequest({ session });
  return path.resolve(agentWorkspaceDir(agentId));
}

function resolveMessageToolSendFilePath(
  request: DiscordToolActionRequest,
): string | null {
  const rawPath = String(request.filePath || '').trim();
  if (!rawPath) return null;

  const workspaceRoot = resolveMessageToolSessionWorkspaceRoot(
    request.sessionId,
  );
  const resolvedPath = resolveDiscordLocalFileForSend({
    filePath: rawPath,
    sessionWorkspaceRoot: workspaceRoot,
    mediaCacheRoot: DISCORD_SEND_MEDIA_ROOT_HOST_DIR,
  });
  if (!resolvedPath) {
    if (!workspaceRoot) {
      throw new Error(
        'filePath could not be resolved. Use /discord-media-cache/... or include session context for workspace files.',
      );
    }
    throw new Error(
      'filePath must stay within the current session workspace or /discord-media-cache.',
    );
  }
  return resolvedPath;
}

function normalizeWhatsAppMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed
    .replace(MESSAGE_TOOL_WHATSAPP_PREFIX_RE, '')
    .trim();
  if (!withoutPrefix) return null;

  const canonicalJid = canonicalizeWhatsAppUserJid(withoutPrefix);
  if (canonicalJid) return canonicalJid;
  if (isWhatsAppJid(withoutPrefix)) return withoutPrefix;
  if (/[a-z]/i.test(withoutPrefix)) return null;

  const normalizedPhone = normalizePhoneNumber(withoutPrefix);
  if (!normalizedPhone) return null;
  return phoneToJid(normalizedPhone);
}

function normalizeLineMessageTarget(rawTarget: string): string | null {
  return normalizeLineChannelId(String(rawTarget || '').trim());
}

function normalizeLocalMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  if (isDiscordChannelId(trimmed)) return null;
  if (isWhatsAppJid(trimmed)) return null;
  if (normalizeLineChannelId(trimmed)) return null;
  if (isTelegramChannelId(trimmed)) return null;
  if (isEmailAddress(trimmed)) return null;
  return isSupportedProactiveChannelId(trimmed) ? trimmed : null;
}

function normalizeTelegramMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  return normalizeTelegramSendTargetId(trimmed) ?? null;
}

function normalizeSignalMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  return normalizeSignalChannelId(trimmed) ?? null;
}

function normalizeSlackWebhookMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  return normalizeSlackWebhookChannelTarget(trimmed) ?? null;
}

function normalizeDiscordWebhookMessageTarget(
  rawTarget: string,
): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  return normalizeDiscordWebhookChannelTarget(trimmed) ?? null;
}

function normalizeThreemaMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  return normalizeThreemaChannelId(trimmed) ?? null;
}

function normalizeEmailMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed
    .replace(MESSAGE_TOOL_EMAIL_PREFIX_RE, '')
    .trim();
  return normalizeEmailAddress(withoutPrefix);
}

function normalizeMessageToolValue(rawValue: string | undefined): string {
  return String(rawValue || '').trim();
}

function looksLikeMSTeamsConversationId(value: string): boolean {
  return /^(?:a:|19:)/.test(normalizeMessageToolValue(value));
}

function isLikelyMSTeamsToolRequest(
  request: DiscordToolActionRequest,
): boolean {
  const sessionId = normalizeMessageToolValue(request.sessionId);
  if (MESSAGE_TOOL_TEAMS_SESSION_PREFIX_RE.test(sessionId)) {
    return true;
  }

  const channelId = normalizeMessageToolValue(request.channelId);
  if (!channelId) return false;
  return (
    MESSAGE_TOOL_TEAMS_CURRENT_PREFIX_RE.test(channelId) ||
    MESSAGE_TOOL_TEAMS_SESSION_PREFIX_RE.test(channelId) ||
    looksLikeMSTeamsConversationId(channelId)
  );
}

function isDiscordSessionId(value: string | undefined): boolean {
  const trimmed = String(value || '').trim();
  return (
    trimmed.startsWith('discord:') || trimmed.includes(':channel:discord:')
  );
}

function hasDiscordContext(request: DiscordToolActionRequest): boolean {
  return Boolean(
    String(request.guildId || '').trim() ||
      String(request.contextChannelId || '').trim() ||
      isDiscordSessionId(request.sessionId),
  );
}

function isDiscordTargetSelector(
  request: DiscordToolActionRequest,
  rawTarget: string,
): boolean {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return hasDiscordContext(request);
  if (isDiscordChannelId(trimmed)) return true;
  if (MESSAGE_TOOL_DISCORD_CHANNEL_MENTION_RE.test(trimmed)) return true;
  if (MESSAGE_TOOL_DISCORD_PREFIXED_ID_RE.test(trimmed)) return true;
  if (trimmed.startsWith('#')) return hasDiscordContext(request);
  return false;
}

function shouldDelegateToDiscordToolAction(
  request: DiscordToolActionRequest,
): boolean {
  const rawChannelId = String(request.channelId || '').trim();
  if (isDiscordTargetSelector(request, rawChannelId)) return true;
  return Boolean(
    String(request.user || '').trim() ||
      String(request.username || '').trim() ||
      String(request.memberId || '').trim() ||
      String(request.messageId || '').trim(),
  );
}

function resolveMessageToolReadLimit(limit: number | undefined): number {
  const requested =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.floor(limit)
      : MESSAGE_TOOL_READ_DEFAULT_LIMIT;
  return Math.max(1, Math.min(MESSAGE_TOOL_READ_MAX_LIMIT, requested));
}

function normalizeStoredMessageTimestamp(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function resolveEmailReadTarget(request: DiscordToolActionRequest): {
  channelId: string;
  sessionId: string;
} | null {
  const rawChannelId = String(request.channelId || '').trim();
  if (rawChannelId) {
    const explicitChannelId = normalizeEmailMessageTarget(rawChannelId);
    if (!explicitChannelId) {
      return null;
    }
    return {
      channelId: explicitChannelId,
      sessionId: `${MESSAGE_TOOL_EMAIL_SESSION_PREFIX}${explicitChannelId}`,
    };
  }

  const normalizedSessionId = String(request.sessionId || '').trim();
  if (!normalizedSessionId) return null;

  const session = getSessionById(normalizedSessionId);
  if (!session) return null;

  const channelId = normalizeEmailAddress(session.channel_id);
  if (!channelId) return null;

  return {
    channelId,
    sessionId: session.id,
  };
}

function resolveEmailMailboxTargetFolder(rawChannelId: string): string {
  const trimmed = String(rawChannelId || '').trim();
  if (!trimmed) return '';
  const normalized = trimmed.toLowerCase();
  if (
    normalized === 'email' ||
    normalized === 'mailbox' ||
    normalized === 'email:mailbox' ||
    normalized === 'email:all'
  ) {
    return '';
  }
  if (normalized === 'email:inbox') {
    return 'INBOX';
  }
  const folderMatch = trimmed.match(/^email:folder:(.+)$/i);
  if (folderMatch) {
    return folderMatch[1].trim();
  }
  const prefixedFolder = trimmed.match(/^email:(.+)$/i);
  return prefixedFolder ? prefixedFolder[1].trim() : '';
}

function isEmailMailboxReadTarget(request: DiscordToolActionRequest): boolean {
  const rawChannelId = String(request.channelId || '').trim();
  if (!rawChannelId) return true;
  if (normalizeEmailMessageTarget(rawChannelId)) return false;
  return MESSAGE_TOOL_EMAIL_MAILBOX_TARGET_RE.test(rawChannelId);
}

function resolveMessageToolRequestAgentId(
  request: DiscordToolActionRequest,
): string | undefined {
  const sessionId = String(request.sessionId || '').trim();
  if (!sessionId) return undefined;
  const session = getSessionById(sessionId);
  if (!session) return undefined;
  return resolveAgentForRequest({ session }).agentId;
}

function normalizeEmailMailboxFolders(
  request: DiscordToolActionRequest,
  targetFolder: string,
): string[] | undefined {
  const folders = [
    targetFolder,
    String(request.folder || '').trim(),
    ...(Array.isArray(request.folders) ? request.folders : []),
  ]
    .map((folder) => String(folder || '').trim())
    .filter(Boolean);
  return folders.length > 0 ? [...new Set(folders)] : undefined;
}

function hasMessageComponents(request: DiscordToolActionRequest): boolean {
  return (
    Array.isArray(request.components) ||
    (request.components !== null && typeof request.components === 'object')
  );
}

function normalizeEmailRecipientList(
  value: string[] | undefined,
  label: 'cc' | 'bcc',
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const normalized: string[] = [];
  for (const entry of value) {
    const candidate = normalizeEmailAddress(entry);
    if (!candidate) {
      throw new Error(`${label} must contain valid email addresses.`);
    }
    normalized.push(candidate);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalThreadMessageId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new Error('inReplyTo must be a string.');
  }
  const normalized = value.trim();
  return normalized || undefined;
}
function normalizeEmailSenderName(value: unknown): string | null {
  const normalized = String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || null;
}

function resolveEmailSenderNameForRequest(
  request: DiscordToolActionRequest,
): string | null {
  const sessionId = String(request.sessionId || '').trim();
  if (!sessionId) return null;

  const session = getSessionById(sessionId);
  if (!session) return null;

  const { agentId } = resolveAgentForRequest({ session });
  const agent = getAgentById(agentId);
  return (
    normalizeEmailSenderName(agent?.displayName) ||
    normalizeEmailSenderName(agent?.name) ||
    normalizeEmailSenderName(agentId)
  );
}

function normalizeThreadReferenceList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('references must be an array of strings.');
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('references must contain only strings.');
    }
    const candidate = entry.trim();
    if (!candidate) continue;
    normalized.push(candidate);
  }

  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function buildEmailSendResultMeta(params: {
  subject: string | null;
  cc: string[] | undefined;
  bcc: string[] | undefined;
  inReplyTo?: string;
  references?: string[];
}): Record<string, unknown> {
  return {
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.cc ? { cc: params.cc } : {}),
    ...(params.bcc ? { bcc: params.bcc } : {}),
    ...(params.inReplyTo ? { inReplyTo: params.inReplyTo } : {}),
    ...(params.references ? { references: params.references } : {}),
  };
}

async function runWhatsAppMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  const filePath = resolveMessageToolSendFilePath(request);
  const hasComponents = hasMessageComponents(request);
  if (!content && !filePath) {
    throw new Error(
      'content is required for WhatsApp send unless filePath is provided.',
    );
  }
  if (hasComponents) {
    throw new Error('components are not supported for WhatsApp sends.');
  }

  const whatsappAuth = await getWhatsAppAuthStatus();
  if (!whatsappAuth.linked) {
    throw new Error('WhatsApp is not linked.');
  }

  if (filePath) {
    await sendWhatsAppMediaToChat({
      jid: channelId,
      filePath,
      caption: content || undefined,
    });
    return {
      ok: true,
      action: 'send',
      channelId,
      transport: 'whatsapp',
      attachmentCount: 1,
      contentLength: content.length,
    };
  }

  await sendToWhatsAppChat(channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'whatsapp',
    contentLength: content.length,
  };
}

async function runLineMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  if (!content) throw new Error('content is required for LINE sends.');
  if (String(request.filePath || '').trim()) {
    throw new Error('filePath is not supported for LINE sends.');
  }
  if (hasMessageComponents(request)) {
    throw new Error('components are not supported for LINE sends.');
  }
  const auth = await getLineAuthStatus();
  if (!auth.linked) throw new Error('LINE is not linked.');
  await sendToLineSelfChat(channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'line',
    contentLength: content.length,
  };
}

async function runEmailMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  const filePath = resolveMessageToolSendFilePath(request);
  const hasComponents = hasMessageComponents(request);
  const subject = String(request.subject || '').trim() || null;
  const cc = normalizeEmailRecipientList(request.cc, 'cc');
  const bcc = normalizeEmailRecipientList(request.bcc, 'bcc');
  const inReplyTo = normalizeOptionalThreadMessageId(request.inReplyTo);
  const references = normalizeThreadReferenceList(request.references);
  const fromName = resolveEmailSenderNameForRequest(request);
  const session = getSessionById(String(request.sessionId || '').trim());
  const agentId = session
    ? resolveAgentForRequest({ session }).agentId
    : undefined;
  const emailOptions = {
    ...(agentId ? { agentId } : {}),
    ...(subject ? { subject } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    ...(fromName ? { fromName } : {}),
  };
  const emailMeta = buildEmailSendResultMeta({
    subject,
    cc,
    bcc,
    inReplyTo,
    references,
  });
  if (!content && !filePath) {
    throw new Error(
      'content is required for email send unless filePath is provided.',
    );
  }
  if (hasComponents) {
    throw new Error('components are not supported for email sends.');
  }

  if (filePath) {
    await sendEmailAttachmentTo({
      to: channelId,
      filePath,
      body: content || '',
      ...emailOptions,
    });
    return {
      ok: true,
      action: 'send',
      channelId,
      transport: 'email',
      attachmentCount: 1,
      contentLength: content.length,
      ...emailMeta,
    };
  }

  await sendToEmail(channelId, content, emailOptions);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'email',
    contentLength: content.length,
    ...emailMeta,
  };
}

async function runTelegramMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  const filePath = resolveMessageToolSendFilePath(request);
  const hasComponents = hasMessageComponents(request);
  if (!content && !filePath) {
    throw new Error(
      'content is required for Telegram send unless filePath is provided.',
    );
  }
  if (hasComponents) {
    throw new Error('components are not supported for Telegram sends.');
  }

  if (filePath) {
    await sendTelegramMediaToChat({
      target: channelId,
      filePath,
      caption: content || undefined,
    });
    return {
      ok: true,
      action: 'send',
      channelId,
      transport: 'telegram',
      attachmentCount: 1,
      contentLength: content.length,
    };
  }

  await sendToTelegramChat(channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'telegram',
    contentLength: content.length,
  };
}

async function runSignalMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  const hasFilePath = Boolean(String(request.filePath || '').trim());
  const hasComponents = hasMessageComponents(request);
  if (!content && !hasFilePath) {
    throw new Error(
      'content is required for Signal send unless filePath is provided.',
    );
  }
  if (hasFilePath) {
    throw new Error('filePath is not supported for Signal sends.');
  }
  if (hasComponents) {
    throw new Error('components are not supported for Signal sends.');
  }

  await sendToSignalChat(channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'signal',
    contentLength: content.length,
  };
}

async function runSlackWebhookMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  const hasFilePath = Boolean(String(request.filePath || '').trim());
  const hasComponents = hasMessageComponents(request);
  if (hasFilePath) {
    throw new Error('filePath is not supported for Slack webhook sends.');
  }
  if (!content) {
    throw new Error('content is required for Slack webhook sends.');
  }
  if (hasComponents) {
    throw new Error('components are not supported for Slack webhook sends.');
  }

  await sendToSlackWebhookTarget(channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'slack_webhook',
    contentLength: content.length,
  };
}

async function runDiscordWebhookMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  const hasFilePath = Boolean(String(request.filePath || '').trim());
  const hasComponents = hasMessageComponents(request);
  if (hasFilePath) {
    throw new Error('filePath is not supported for Discord webhook sends.');
  }
  if (!content) {
    throw new Error('content is required for Discord webhook sends.');
  }
  if (hasComponents) {
    throw new Error('components are not supported for Discord webhook sends.');
  }

  await sendToDiscordWebhookTarget(channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'discord_webhook',
    contentLength: content.length,
  };
}

async function runThreemaMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  const hasFilePath = Boolean(String(request.filePath || '').trim());
  const hasComponents = hasMessageComponents(request);
  if (hasFilePath) {
    throw new Error('filePath is not supported for Threema sends.');
  }
  if (!content) {
    throw new Error('content is required for Threema sends.');
  }
  if (hasComponents) {
    throw new Error('components are not supported for Threema sends.');
  }

  await sendToThreemaChat(channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'threema',
    contentLength: content.length,
  };
}

async function runEmailReadAction(
  request: DiscordToolActionRequest,
  params: {
    channelId: string;
    sessionId: string;
  },
): Promise<Record<string, unknown>> {
  if (
    String(request.before || '').trim() ||
    String(request.after || '').trim() ||
    String(request.around || '').trim()
  ) {
    throw new Error(
      'before, after, and around are not supported for email reads.',
    );
  }

  const session = getSessionById(params.sessionId);
  if (!session) {
    throw new Error(
      `No ingested email thread found for ${params.channelId}. Only emails already received by the gateway can be read.`,
    );
  }

  const limit = resolveMessageToolReadLimit(request.limit);
  const messages = getRecentMessages(params.sessionId, limit).map((message) => {
    const emailAddress = normalizeEmailAddress(message.user_id);
    const isAssistant = message.role === 'assistant';
    return {
      id: message.id,
      sessionId: message.session_id,
      channelId: params.channelId,
      content: message.content,
      createdAt: normalizeStoredMessageTimestamp(message.created_at),
      role: message.role,
      author: {
        id: message.user_id,
        username: message.username || (emailAddress ?? message.user_id),
        address: emailAddress,
        assistant: isAssistant,
      },
    };
  });

  return {
    ok: true,
    action: 'read',
    channelId: params.channelId,
    sessionId: params.sessionId,
    transport: 'email',
    count: messages.length,
    messages,
  };
}

type EmailMailboxMessage = Extract<
  EmailMailboxReadResult,
  { kind: 'search' }
>['snapshot']['messages'][number];

function truncateEmailMailboxText(
  value: string | null | undefined,
): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (normalized.length <= MESSAGE_TOOL_EMAIL_BODY_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MESSAGE_TOOL_EMAIL_BODY_MAX_LENGTH).trimEnd()}\n[truncated]`;
}

function mapEmailMailboxParticipants(
  participants: EmailMailboxMessage['to'],
): Array<{ name: string | null; address: string | null }> {
  return participants.map((participant) => ({
    name: participant.name,
    address: participant.address,
  }));
}

function mapEmailMailboxMessage(message: EmailMailboxMessage) {
  return {
    id: `${message.folder}:${message.uid}`,
    folder: message.folder,
    uid: message.uid,
    messageId: message.messageId,
    subject: message.subject,
    from: {
      name: message.fromName,
      address: message.fromAddress,
    },
    to: mapEmailMailboxParticipants(message.to),
    cc: mapEmailMailboxParticipants(message.cc),
    replyTo: mapEmailMailboxParticipants(message.replyTo),
    receivedAt: message.receivedAt,
    seen: message.seen,
    flagged: message.flagged,
    answered: message.answered,
    hasAttachments: message.hasAttachments,
    attachments: message.attachments,
    preview: message.preview,
    text: truncateEmailMailboxText(message.text),
  };
}

async function runEmailMailboxReadAction(
  request: DiscordToolActionRequest,
): Promise<Record<string, unknown>> {
  if (
    String(request.before || '').trim() ||
    String(request.after || '').trim() ||
    String(request.around || '').trim()
  ) {
    throw new Error(
      'before, after, and around are not supported for live email mailbox reads. Use since or beforeDate for date filtering.',
    );
  }

  const rawChannelId = String(request.channelId || '').trim();
  const targetFolder = resolveEmailMailboxTargetFolder(rawChannelId);
  const folders = normalizeEmailMailboxFolders(request, targetFolder);
  const uid =
    typeof request.uid === 'number' && Number.isFinite(request.uid)
      ? Math.trunc(request.uid)
      : undefined;
  const result = await readEmailMailbox({
    agentId: resolveMessageToolRequestAgentId(request),
    query: String(request.query || '').trim() || undefined,
    folder: folders?.[0],
    folders,
    limit: resolveMessageToolReadLimit(request.limit),
    unreadOnly: request.unreadOnly === true,
    from: String(request.from || '').trim() || undefined,
    subject: String(request.subject || '').trim() || undefined,
    since: String(request.since || '').trim() || undefined,
    beforeDate: String(request.beforeDate || '').trim() || undefined,
    uid,
  });

  if (result.kind === 'message') {
    return {
      ok: true,
      action: 'read',
      channelId: rawChannelId || 'email:mailbox',
      scope: 'mailbox-message',
      transport: 'email',
      accountAddress: result.accountAddress,
      agentId: result.agentId,
      folder: result.folder,
      uid: result.uid,
      message: result.snapshot.message
        ? mapEmailMailboxMessage(result.snapshot.message)
        : null,
      thread: result.snapshot.thread.map(mapEmailMailboxMessage),
      count: result.snapshot.thread.length,
    };
  }

  const messages = result.snapshot.messages.map(mapEmailMailboxMessage);
  return {
    ok: true,
    action: 'read',
    channelId: rawChannelId || 'email:mailbox',
    scope: 'mailbox-search',
    transport: 'email',
    accountAddress: result.accountAddress,
    agentId: result.agentId,
    query: result.snapshot.query,
    folders: result.snapshot.folders,
    limit: result.snapshot.limit,
    count: messages.length,
    messages,
  };
}

async function runLocalMessageSendAction(
  request: DiscordToolActionRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const content = String(request.content || '').trim();
  if (!content) {
    throw new Error('content is required for local channel sends.');
  }
  if (String(request.filePath || '').trim()) {
    throw new Error('filePath is not supported for local channel sends.');
  }
  if (hasMessageComponents(request)) {
    throw new Error('components are not supported for local channel sends.');
  }

  const { queued, dropped } = enqueueProactiveMessage(
    channelId,
    content,
    MESSAGE_TOOL_LOCAL_SOURCE,
    LOCAL_MESSAGE_QUEUE_LIMIT,
  );
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'local',
    queued,
    dropped,
    note: 'Queued local delivery.',
    contentLength: content.length,
  };
}

export async function runMessageToolAction(
  request: DiscordToolActionRequest,
): Promise<Record<string, unknown>> {
  if (isA2ALocalModeEnabled(getRuntimeConfig())) {
    const localChannelId = normalizeLocalMessageTarget(request.channelId || '');
    if (request.action === 'send' && localChannelId === 'tui') {
      return await runLocalMessageSendAction(request, localChannelId);
    }
    throw new Error(
      'Message channel actions are disabled while A2A local mode is enabled.',
    );
  }

  if (isLikelyMSTeamsToolRequest(request)) {
    const { maybeRunMSTeamsToolAction } = await import(
      '../msteams/tool-actions.js'
    );
    const teamsResult = await maybeRunMSTeamsToolAction(request, {
      resolveSendFilePath: resolveMessageToolSendFilePath,
    });
    if (teamsResult) {
      return teamsResult;
    }
  }

  const slackResult = await maybeRunSlackToolAction(request, {
    resolveSendFilePath: resolveMessageToolSendFilePath,
  });
  if (slackResult) {
    return slackResult;
  }

  const rawChannelId = String(request.channelId || '').trim();
  if (
    rawChannelId &&
    MESSAGE_TOOL_SLACK_WEBHOOK_PREFIX_RE.test(rawChannelId) &&
    request.action !== 'send'
  ) {
    throw new Error('Slack webhook only supports outbound send actions.');
  }
  if (
    rawChannelId &&
    MESSAGE_TOOL_DISCORD_WEBHOOK_PREFIX_RE.test(rawChannelId) &&
    request.action !== 'send'
  ) {
    throw new Error('Discord webhook only supports outbound send actions.');
  }

  if (request.action === 'read') {
    const emailReadTarget = resolveEmailReadTarget(request);
    if (emailReadTarget) {
      return await runEmailReadAction(request, emailReadTarget);
    }
    if (shouldDelegateToDiscordToolAction(request)) {
      return await runDiscordToolAction(request);
    }
    if (isEmailMailboxReadTarget(request)) {
      return await runEmailMailboxReadAction(request);
    }
    throw new Error(MESSAGE_TOOL_CHANNEL_INSTRUCTIONS);
  }

  if (request.action !== 'send') {
    if (shouldDelegateToDiscordToolAction(request)) {
      return await runDiscordToolAction(request);
    }
    throw new Error(MESSAGE_TOOL_CHANNEL_INSTRUCTIONS);
  }

  if (
    rawChannelId &&
    MESSAGE_TOOL_SIGNAL_PREFIX_RE.test(rawChannelId) &&
    !normalizeSignalMessageTarget(rawChannelId)
  ) {
    throw new Error(
      'Signal send targets must use `signal:<phone>`, `signal:<uuid>`, or `signal:group:<groupId>`.',
    );
  }

  if (
    rawChannelId &&
    MESSAGE_TOOL_LINE_PREFIX_RE.test(rawChannelId) &&
    !normalizeLineMessageTarget(rawChannelId)
  ) {
    throw new Error('LINE send targets must use `line:<linked-user-mid>`.');
  }

  if (
    rawChannelId &&
    MESSAGE_TOOL_SLACK_WEBHOOK_PREFIX_RE.test(rawChannelId) &&
    !normalizeSlackWebhookMessageTarget(rawChannelId)
  ) {
    throw new Error(
      'Slack webhook send targets must use `slack_webhook` or `slack_webhook:<target>`.',
    );
  }
  if (
    rawChannelId &&
    MESSAGE_TOOL_DISCORD_WEBHOOK_PREFIX_RE.test(rawChannelId) &&
    !normalizeDiscordWebhookMessageTarget(rawChannelId)
  ) {
    throw new Error(
      'Discord webhook send targets must use `discord_webhook` or `discord_webhook:<target>`.',
    );
  }

  if (
    rawChannelId &&
    MESSAGE_TOOL_TELEGRAM_PREFIX_RE.test(rawChannelId) &&
    !normalizeTelegramMessageTarget(rawChannelId)
  ) {
    throw new Error(
      'Telegram send targets must use `telegram:<numericChatId>` or `telegram:<numericChatId>:topic:<topicId>`. The `tg:` alias is also accepted and will be normalized to `telegram:`.',
    );
  }

  if (
    rawChannelId &&
    MESSAGE_TOOL_THREEMA_PREFIX_RE.test(rawChannelId) &&
    !normalizeThreemaMessageTarget(rawChannelId)
  ) {
    throw new Error(
      'Threema send targets must use `threema:<id>`, `threema:phone:<number>`, or `threema:email:<address>`.',
    );
  }

  const whatsappChannelId = normalizeWhatsAppMessageTarget(rawChannelId);
  if (whatsappChannelId) {
    return await runWhatsAppMessageSendAction(request, whatsappChannelId);
  }

  const lineChannelId = normalizeLineMessageTarget(rawChannelId);
  if (lineChannelId) {
    return await runLineMessageSendAction(request, lineChannelId);
  }

  const telegramChannelId = normalizeTelegramMessageTarget(rawChannelId);
  if (telegramChannelId) {
    return await runTelegramMessageSendAction(request, telegramChannelId);
  }

  const signalChannelId = normalizeSignalMessageTarget(rawChannelId);
  if (signalChannelId) {
    return await runSignalMessageSendAction(request, signalChannelId);
  }

  const slackWebhookChannelId =
    normalizeSlackWebhookMessageTarget(rawChannelId);
  if (slackWebhookChannelId) {
    return await runSlackWebhookMessageSendAction(
      request,
      slackWebhookChannelId,
    );
  }

  const discordWebhookChannelId =
    normalizeDiscordWebhookMessageTarget(rawChannelId);
  if (discordWebhookChannelId) {
    return await runDiscordWebhookMessageSendAction(
      request,
      discordWebhookChannelId,
    );
  }

  const threemaChannelId = normalizeThreemaMessageTarget(rawChannelId);
  if (threemaChannelId) {
    return await runThreemaMessageSendAction(request, threemaChannelId);
  }

  const emailChannelId = normalizeEmailMessageTarget(rawChannelId);
  if (emailChannelId) {
    return await runEmailMessageSendAction(request, emailChannelId);
  }

  const localChannelId = normalizeLocalMessageTarget(rawChannelId);
  if (localChannelId) {
    return await runLocalMessageSendAction(request, localChannelId);
  }

  if (shouldDelegateToDiscordToolAction(request)) {
    return await runDiscordToolAction(request);
  }

  throw new Error(MESSAGE_TOOL_CHANNEL_INSTRUCTIONS);
}
