import path from 'node:path';
import { resolveAgentForRequest } from '../../agents/agent-registry.js';
import { DATA_DIR } from '../../config/config.js';
import {
  isDiscordChannelId,
  isSupportedProactiveChannelId,
} from '../../gateway/proactive-delivery.js';
import { agentWorkspaceDir } from '../../infra/ipc.js';
import { enqueueProactiveMessage, getSessionById } from '../../memory/db.js';
import { runDiscordToolAction } from '../discord/runtime.js';
import { resolveDiscordLocalFileForSend } from '../discord/send-files.js';
import {
  type DiscordToolAction,
  type DiscordToolActionRequest,
  normalizeDiscordToolAction,
} from '../discord/tool-actions.js';
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

export type MessageToolAction = DiscordToolAction;
export type MessageToolActionRequest = DiscordToolActionRequest;

const LOCAL_MESSAGE_QUEUE_LIMIT = 100;
const MESSAGE_TOOL_WHATSAPP_PREFIX_RE = /^whatsapp:/i;
const MESSAGE_TOOL_LOCAL_SOURCE = 'message-tool';
const MESSAGE_MEDIA_CACHE_HOST_DIR = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);

export const normalizeMessageToolAction = normalizeDiscordToolAction;

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
  request: MessageToolActionRequest,
): string | null {
  const rawPath = String(request.filePath || '').trim();
  if (!rawPath) return null;

  const workspaceRoot = resolveMessageToolSessionWorkspaceRoot(
    request.sessionId,
  );
  const resolvedPath = resolveDiscordLocalFileForSend({
    filePath: rawPath,
    sessionWorkspaceRoot: workspaceRoot,
    mediaCacheRoot: MESSAGE_MEDIA_CACHE_HOST_DIR,
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

  const normalizedPhone = normalizePhoneNumber(withoutPrefix);
  if (!normalizedPhone) return null;
  return phoneToJid(normalizedPhone);
}

function normalizeLocalMessageTarget(rawTarget: string): string | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  if (isDiscordChannelId(trimmed)) return null;
  if (isWhatsAppJid(trimmed)) return null;
  return isSupportedProactiveChannelId(trimmed) ? trimmed : null;
}

function hasMessageComponents(request: MessageToolActionRequest): boolean {
  return (
    Array.isArray(request.components) ||
    (request.components !== null && typeof request.components === 'object')
  );
}

async function runWhatsAppMessageSendAction(
  request: MessageToolActionRequest,
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

async function runLocalMessageSendAction(
  request: MessageToolActionRequest,
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
  request: MessageToolActionRequest,
): Promise<Record<string, unknown>> {
  if (request.action !== 'send') {
    return await runDiscordToolAction(request);
  }

  const rawChannelId = String(request.channelId || '').trim();
  const whatsappChannelId = normalizeWhatsAppMessageTarget(rawChannelId);
  if (whatsappChannelId) {
    return await runWhatsAppMessageSendAction(request, whatsappChannelId);
  }

  const localChannelId = normalizeLocalMessageTarget(rawChannelId);
  if (localChannelId) {
    return await runLocalMessageSendAction(request, localChannelId);
  }

  return await runDiscordToolAction(request);
}
