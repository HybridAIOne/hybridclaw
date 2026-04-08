import path from 'node:path';
import { resolveAgentForRequest } from '../../agents/agent-registry.js';
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
import { isEmailAddress, normalizeEmailAddress } from '../email/allowlist.js';
import { sendEmailAttachmentTo, sendToEmail } from '../email/runtime.js';
import { maybeRunMSTeamsToolAction } from '../msteams/tool-actions.js';
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
const MESSAGE_TOOL_EMAIL_PREFIX_RE = /^email:/i;
const MESSAGE_TOOL_WHATSAPP_PREFIX_RE = /^whatsapp:/i;
const MESSAGE_TOOL_LOCAL_SOURCE = 'message-tool';

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

function normalizeLocalMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  if (isDiscordChannelId(trimmed)) return null;
  if (isWhatsAppJid(trimmed)) return null;
  if (isEmailAddress(trimmed)) return null;
  return isSupportedProactiveChannelId(trimmed) ? trimmed : null;
}

function normalizeEmailMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed
    .replace(MESSAGE_TOOL_EMAIL_PREFIX_RE, '')
    .trim();
  return normalizeEmailAddress(withoutPrefix);
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
      subject,
      cc,
      bcc,
      inReplyTo,
      references,
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

  await sendToEmail(channelId, content, {
    subject,
    cc,
    bcc,
    inReplyTo,
    references,
  });
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'email',
    contentLength: content.length,
    ...emailMeta,
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
  const teamsResult = await maybeRunMSTeamsToolAction(request, {
    resolveSendFilePath: resolveMessageToolSendFilePath,
  });
  if (teamsResult) {
    return teamsResult;
  }

  if (request.action === 'read') {
    const emailReadTarget = resolveEmailReadTarget(request);
    if (emailReadTarget) {
      return await runEmailReadAction(request, emailReadTarget);
    }
    return await runDiscordToolAction(request);
  }

  if (request.action !== 'send') {
    return await runDiscordToolAction(request);
  }

  const rawChannelId = String(request.channelId || '').trim();
  const whatsappChannelId = normalizeWhatsAppMessageTarget(rawChannelId);
  if (whatsappChannelId) {
    return await runWhatsAppMessageSendAction(request, whatsappChannelId);
  }

  const emailChannelId = normalizeEmailMessageTarget(rawChannelId);
  if (emailChannelId) {
    return await runEmailMessageSendAction(request, emailChannelId);
  }

  const localChannelId = normalizeLocalMessageTarget(rawChannelId);
  if (localChannelId) {
    return await runLocalMessageSendAction(request, localChannelId);
  }

  return await runDiscordToolAction(request);
}
