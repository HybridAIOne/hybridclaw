import fs from 'node:fs/promises';
import {
  downloadMediaMessage,
  extractMessageContent,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type {
  RuntimeWhatsAppConfig,
  WhatsAppDmPolicy,
  WhatsAppGroupPolicy,
} from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import { resolveManagedTempMediaDir } from '../../media/managed-temp-media.js';
import { createUploadedMediaContextItem } from '../../media/uploaded-media-cache.js';
import { buildSessionKey } from '../../session/session-key.js';
import type { MediaContextItem } from '../../types/container.js';
import { guessWhatsAppExtensionFromMimeType } from './mime-utils.js';
import {
  canonicalizeWhatsAppUserJid,
  isGroupJid,
  jidToPhone,
  normalizePhoneNumber,
  normalizeWhatsAppUserIdentity,
} from './phone.js';

const STATUS_BROADCAST_JID = 'status@broadcast';
const normalizedAllowListCache = new WeakMap<string[], string[]>();

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function resolveMessageMimeType(
  message: NonNullable<WAMessage['message']>,
): string | null {
  // Prefer the explicit WhatsApp-declared mimetype, but fall back to the
  // media kind when Baileys gives us the message object without that field.
  return (
    message.imageMessage?.mimetype ??
    message.videoMessage?.mimetype ??
    message.documentMessage?.mimetype ??
    message.audioMessage?.mimetype ??
    message.stickerMessage?.mimetype ??
    (message.audioMessage ? 'audio/ogg; codecs=opus' : null) ??
    (message.imageMessage ? 'image/jpeg' : null) ??
    (message.videoMessage ? 'video/mp4' : null) ??
    (message.stickerMessage ? 'image/webp' : null)
  );
}

function extractInboundText(
  message: NonNullable<WAMessage['message']>,
): string {
  const normalized = normalizeMessageContent(message);
  const extracted = normalized ? extractMessageContent(normalized) : undefined;
  const candidates = [normalized, extracted].filter(Boolean) as Array<
    NonNullable<WAMessage['message']>
  >;

  for (const candidate of candidates) {
    const conversation = candidate.conversation?.trim();
    if (conversation) return conversation;
    const extended = candidate.extendedTextMessage?.text?.trim();
    if (extended) return extended;
    const caption =
      candidate.imageMessage?.caption?.trim() ??
      candidate.videoMessage?.caption?.trim() ??
      candidate.documentMessage?.caption?.trim();
    if (caption) return caption;
    const buttonText =
      candidate.buttonsResponseMessage?.selectedDisplayText?.trim() ??
      candidate.listResponseMessage?.title?.trim();
    if (buttonText) return buttonText;
  }

  if (normalized?.imageMessage) return '<media:image>';
  if (normalized?.videoMessage) return '<media:video>';
  if (normalized?.audioMessage) return '<media:audio>';
  if (normalized?.documentMessage) return '<media:document>';
  if (normalized?.stickerMessage) return '<media:sticker>';
  return '';
}

function normalizeAllowEntry(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return normalizePhoneNumber(trimmed) ?? jidToPhone(trimmed);
}

function matchesAllowList(list: string[], senderPhone: string | null): boolean {
  if (list.includes('*')) return true;
  if (!senderPhone) return false;
  return list.includes(senderPhone);
}

function normalizeAllowList(values: string[]): string[] {
  const cached = normalizedAllowListCache.get(values);
  if (cached) return cached;

  const normalized = values
    .map((entry) => normalizeAllowEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
  const deduplicated = [...new Set(normalized)];
  normalizedAllowListCache.set(values, deduplicated);
  return deduplicated;
}

function isSelfChat(params: {
  chatJid: string;
  senderJid: string;
  selfJids: string[];
}): boolean {
  if (isGroupJid(params.chatJid)) return false;
  const chatIdentity = normalizeWhatsAppUserIdentity(params.chatJid);
  const senderIdentity = normalizeWhatsAppUserIdentity(params.senderJid);
  const selfIdentities = new Set(
    params.selfJids
      .map((jid) => normalizeWhatsAppUserIdentity(jid))
      .filter((identity): identity is string => Boolean(identity)),
  );
  return Boolean(
    chatIdentity &&
      senderIdentity &&
      selfIdentities.size > 0 &&
      selfIdentities.has(chatIdentity) &&
      selfIdentities.has(senderIdentity),
  );
}

function resolveCanonicalSelfChatSessionJid(
  selfJids: string[],
  fallbackChatJid: string,
): string {
  for (const jid of selfJids) {
    const canonical = canonicalizeWhatsAppUserJid(jid);
    if (canonical?.endsWith('@s.whatsapp.net')) {
      return canonical;
    }
  }

  for (const jid of selfJids) {
    const canonical = canonicalizeWhatsAppUserJid(jid);
    if (canonical) {
      return canonical;
    }
  }

  return canonicalizeWhatsAppUserJid(fallbackChatJid) ?? fallbackChatJid;
}

export function evaluateWhatsAppAccessPolicy(params: {
  dmPolicy: WhatsAppDmPolicy;
  groupPolicy: WhatsAppGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  chatJid: string;
  senderJid: string;
  selfJids: string[];
  fromMe: boolean;
}): {
  allowed: boolean;
  isGroup: boolean;
  isSelfChat: boolean;
} {
  const isGroup = isGroupJid(params.chatJid);
  const selfChat = isSelfChat(params);
  const senderPhone = jidToPhone(params.senderJid);
  const allowFrom = normalizeAllowList(params.allowFrom);
  const groupAllowFrom =
    params.groupAllowFrom.length > 0
      ? normalizeAllowList(params.groupAllowFrom)
      : allowFrom;

  if (params.fromMe && !selfChat) {
    return { allowed: false, isGroup, isSelfChat: selfChat };
  }

  if (isGroup) {
    if (params.groupPolicy === 'disabled') {
      return { allowed: false, isGroup, isSelfChat: selfChat };
    }
    if (params.groupPolicy === 'open') {
      return { allowed: true, isGroup, isSelfChat: selfChat };
    }
    return {
      allowed: matchesAllowList(groupAllowFrom, senderPhone),
      isGroup,
      isSelfChat: selfChat,
    };
  }

  if (selfChat) {
    return { allowed: true, isGroup, isSelfChat: true };
  }
  if (params.dmPolicy === 'disabled') {
    return { allowed: false, isGroup, isSelfChat: selfChat };
  }
  if (params.dmPolicy === 'open') {
    return { allowed: true, isGroup, isSelfChat: selfChat };
  }

  return {
    // HybridClaw does not yet have a WhatsApp pairing store. Treat pairing as
    // the same gate as allowlist until that workflow exists.
    allowed: matchesAllowList(allowFrom, senderPhone),
    isGroup,
    isSelfChat: selfChat,
  };
}

async function downloadInboundMedia(params: {
  sock: Pick<WASocket, 'updateMediaMessage' | 'logger'>;
  message: WAMessage;
  mediaMaxMb: number;
}): Promise<MediaContextItem[]> {
  const normalizedMessage = normalizeMessageContent(params.message.message);
  if (!normalizedMessage) return [];

  const mimeType = resolveMessageMimeType(normalizedMessage);
  if (!mimeType) return [];

  const mediaBytes =
    normalizedMessage.imageMessage?.fileLength ??
    normalizedMessage.videoMessage?.fileLength ??
    normalizedMessage.documentMessage?.fileLength ??
    normalizedMessage.audioMessage?.fileLength ??
    normalizedMessage.stickerMessage?.fileLength ??
    undefined;

  const sizeBytes =
    typeof mediaBytes === 'number' ? mediaBytes : Number(mediaBytes || 0) || 0;
  const maxBytes = Math.max(1, params.mediaMaxMb) * 1024 * 1024;
  if (sizeBytes > 0 && sizeBytes > maxBytes) return [];

  const buffer = await downloadMediaMessage(
    params.message,
    'buffer',
    {},
    {
      reuploadRequest: params.sock.updateMediaMessage,
      logger: params.sock.logger,
    },
  ).catch(() => null);
  if (!buffer) return [];

  const defaultName =
    normalizedMessage.documentMessage?.fileName?.trim() ||
    `wa-media-${params.message.key.id || Date.now()}${guessWhatsAppExtensionFromMimeType(
      mimeType,
    )}`;
  const filename = sanitizeFilename(defaultName);
  return [
    await createUploadedMediaContextItem({
      attachmentName: filename,
      buffer,
      mimeType,
      sizeBytes: buffer.length,
    }),
  ];
}

export async function cleanupWhatsAppInboundMedia(
  media: MediaContextItem[],
): Promise<void> {
  const tempDirs = new Set<string>();
  for (const item of media) {
    if (!item.path) continue;
    const managedDir = resolveManagedTempMediaDir({ filePath: item.path });
    if (!managedDir) continue;
    tempDirs.add(managedDir);
  }
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface ProcessedWhatsAppInbound {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  media: MediaContextItem[];
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
  isSelfChat: boolean;
  rawMessage: WAMessage;
}

export async function processInboundWhatsAppMessage(params: {
  message: WAMessage;
  sock: Pick<WASocket, 'updateMediaMessage' | 'logger'>;
  config: RuntimeWhatsAppConfig;
  selfJids: string[];
  agentId?: string;
}): Promise<ProcessedWhatsAppInbound | null> {
  const chatJid = params.message.key.remoteJid?.trim();
  if (
    !chatJid ||
    chatJid === STATUS_BROADCAST_JID ||
    chatJid.endsWith('@broadcast')
  ) {
    return null;
  }

  const senderJid = (
    params.message.key.participant ||
    params.message.participant ||
    params.message.key.remoteJid ||
    ''
  ).trim();
  if (!senderJid) return null;

  const access = evaluateWhatsAppAccessPolicy({
    dmPolicy: params.config.dmPolicy,
    groupPolicy: params.config.groupPolicy,
    allowFrom: params.config.allowFrom,
    groupAllowFrom: params.config.groupAllowFrom,
    chatJid,
    senderJid,
    selfJids: params.selfJids,
    fromMe: Boolean(params.message.key.fromMe),
  });
  if (!access.allowed) {
    logger.debug(
      {
        channel: 'whatsapp',
        chatJid,
        senderJid,
        fromMe: Boolean(params.message.key.fromMe),
        isGroup: access.isGroup,
        isSelfChat: access.isSelfChat,
        dmPolicy: params.config.dmPolicy,
        groupPolicy: params.config.groupPolicy,
      },
      'Dropped WhatsApp inbound message by access policy',
    );
    return null;
  }

  const media = await downloadInboundMedia({
    sock: params.sock,
    message: params.message,
    mediaMaxMb: params.config.mediaMaxMb,
  });
  const content = extractInboundText(params.message.message ?? {}) || '';
  if (!content.trim() && media.length === 0) {
    return null;
  }
  const preferredSelfPhone =
    params.selfJids
      .map((jid) => jidToPhone(jid))
      .find((phone): phone is string => Boolean(phone)) ?? null;
  const userId = access.isSelfChat
    ? (preferredSelfPhone ?? jidToPhone(senderJid) ?? senderJid)
    : (jidToPhone(senderJid) ?? senderJid);
  const username = String(params.message.pushName || '').trim() || userId;
  const sessionChatJid = access.isSelfChat
    ? resolveCanonicalSelfChatSessionJid(params.selfJids, chatJid)
    : chatJid;

  return {
    sessionId: buildSessionKey(
      params.agentId || DEFAULT_AGENT_ID,
      'whatsapp',
      access.isGroup ? 'group' : 'dm',
      access.isGroup ? sessionChatJid : userId,
    ),
    guildId: access.isGroup ? chatJid : null,
    channelId: chatJid,
    userId,
    username,
    content,
    media,
    chatJid,
    senderJid,
    isGroup: access.isGroup,
    isSelfChat: access.isSelfChat,
    rawMessage: params.message,
  };
}
