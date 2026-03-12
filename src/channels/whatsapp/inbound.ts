import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  downloadMediaMessage,
  extractMessageContent,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type {
  RuntimeWhatsAppConfig,
  WhatsAppDmPolicy,
  WhatsAppGroupPolicy,
} from '../../config/runtime-config.js';
import type { MediaContextItem } from '../../types.js';
import { isGroupJid, jidToPhone, normalizePhoneNumber } from './phone.js';

const STATUS_BROADCAST_JID = 'status@broadcast';
const WHATSAPP_MEDIA_TMP_PREFIX = 'hybridclaw-wa-';

function normalizeWhatsAppMediaPath(filePath: string): string | null {
  const trimmed = String(filePath || '').trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function isManagedWhatsAppMediaPath(filePath: string): boolean {
  const normalized = normalizeWhatsAppMediaPath(filePath);
  if (!normalized) return false;
  const tempRoot = path.resolve(os.tmpdir());
  if (
    normalized !== tempRoot &&
    !normalized.startsWith(`${tempRoot}${path.sep}`)
  ) {
    return false;
  }
  const dirName = path.basename(path.dirname(normalized));
  return dirName.startsWith(WHATSAPP_MEDIA_TMP_PREFIX);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function guessExtensionFromMime(mimeType: string | null): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'video/mp4':
      return '.mp4';
    case 'audio/ogg':
    case 'audio/ogg; codecs=opus':
      return '.ogg';
    case 'audio/mpeg':
      return '.mp3';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}

function resolveMessageMimeType(
  message: NonNullable<WAMessage['message']>,
): string | null {
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
  const normalized = values
    .map((entry) => normalizeAllowEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set(normalized)];
}

function isSelfChat(params: {
  chatJid: string;
  senderJid: string;
  selfJid: string | null;
}): boolean {
  if (isGroupJid(params.chatJid)) return false;
  const selfPhone = params.selfJid ? jidToPhone(params.selfJid) : null;
  const chatPhone = jidToPhone(params.chatJid);
  const senderPhone = jidToPhone(params.senderJid);
  return Boolean(
    selfPhone &&
      chatPhone &&
      senderPhone &&
      selfPhone === chatPhone &&
      selfPhone === senderPhone,
  );
}

export function evaluateWhatsAppAccessPolicy(params: {
  dmPolicy: WhatsAppDmPolicy;
  groupPolicy: WhatsAppGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  chatJid: string;
  senderJid: string;
  selfJid: string | null;
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

  const hasMedia =
    Boolean(normalizedMessage.imageMessage) ||
    Boolean(normalizedMessage.videoMessage) ||
    Boolean(normalizedMessage.documentMessage) ||
    Boolean(normalizedMessage.audioMessage) ||
    Boolean(normalizedMessage.stickerMessage);
  if (!hasMedia) return [];

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

  const mimeType = resolveMessageMimeType(normalizedMessage);
  const defaultName =
    normalizedMessage.documentMessage?.fileName?.trim() ||
    `wa-media-${params.message.key.id || Date.now()}${guessExtensionFromMime(
      mimeType,
    )}`;
  const filename = sanitizeFilename(defaultName);
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), WHATSAPP_MEDIA_TMP_PREFIX),
  );
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  const fileUrl = `file://${filePath}`;

  return [
    {
      path: filePath,
      url: fileUrl,
      originalUrl: fileUrl,
      mimeType,
      sizeBytes: buffer.length,
      filename,
    },
  ];
}

export async function cleanupWhatsAppInboundMedia(
  media: MediaContextItem[],
): Promise<void> {
  const tempDirs = new Set<string>();
  for (const item of media) {
    if (!item.path || !isManagedWhatsAppMediaPath(item.path)) continue;
    tempDirs.add(path.dirname(path.resolve(item.path)));
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
  selfJid: string | null;
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
    selfJid: params.selfJid,
    fromMe: Boolean(params.message.key.fromMe),
  });
  if (!access.allowed) return null;

  const media = await downloadInboundMedia({
    sock: params.sock,
    message: params.message,
    mediaMaxMb: params.config.mediaMaxMb,
  });
  const content = extractInboundText(params.message.message ?? {}) || '';
  if (!content.trim() && media.length === 0) {
    return null;
  }
  const userId = jidToPhone(senderJid) ?? senderJid;
  const username = String(params.message.pushName || '').trim() || userId;

  return {
    sessionId: `wa:${chatJid}`,
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
