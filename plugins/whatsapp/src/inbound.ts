import fs from 'node:fs/promises';
import type {
  ChannelTransportMessageHandler,
  RuntimeWhatsAppConfig,
  WhatsAppTransportHost,
} from '@hybridaione/hybridclaw/plugin-sdk';
import {
  downloadMediaMessage,
  extractMessageContent,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { guessWhatsAppExtensionFromMimeType } from './mime-utils.js';

type MediaContextItem = Parameters<ChannelTransportMessageHandler>[6][number];

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

function normalizeAllowEntry(
  host: WhatsAppTransportHost,
  value: string,
): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return (
    host.phone.normalizePhoneNumber(trimmed) ?? host.phone.jidToPhone(trimmed)
  );
}

function isLidJid(value: string | null | undefined): boolean {
  return /@(hosted\.)?lid$/i.test(String(value || '').trim());
}

function resolveInboundSenderJid(message: WAMessage): string {
  const participant = (
    message.key.participant ||
    message.participant ||
    ''
  ).trim();
  if (isLidJid(participant)) {
    const participantAlt = message.key.participantAlt?.trim();
    if (participantAlt) return participantAlt;
  }

  const chatJid = message.key.remoteJid?.trim() || '';
  if (isLidJid(chatJid)) {
    const senderAlt = message.key.remoteJidAlt?.trim();
    if (senderAlt) return senderAlt;
  }

  return participant || chatJid;
}

function matchesAllowList(list: string[], senderPhone: string | null): boolean {
  if (list.includes('*')) return true;
  if (!senderPhone) return false;
  return list.includes(senderPhone);
}

function normalizeAllowList(
  host: WhatsAppTransportHost,
  values: string[],
): string[] {
  const cached = normalizedAllowListCache.get(values);
  if (cached) return cached;

  const normalized = values
    .map((entry) => normalizeAllowEntry(host, entry))
    .filter((entry): entry is string => Boolean(entry));
  const deduplicated = [...new Set(normalized)];
  normalizedAllowListCache.set(values, deduplicated);
  return deduplicated;
}

function isSelfChat(
  host: WhatsAppTransportHost,
  params: {
    chatJid: string;
    senderJid: string;
    selfJids: string[];
  },
): boolean {
  if (host.phone.isGroupJid(params.chatJid)) return false;
  const chatIdentity = host.phone.normalizeUserIdentity(params.chatJid);
  const senderIdentity = host.phone.normalizeUserIdentity(params.senderJid);
  const selfIdentities = new Set(
    params.selfJids
      .map((jid) => host.phone.normalizeUserIdentity(jid))
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
  host: WhatsAppTransportHost,
  selfJids: string[],
  fallbackChatJid: string,
): string {
  for (const jid of selfJids) {
    const canonical = host.phone.canonicalizeUserJid(jid);
    if (canonical?.endsWith('@s.whatsapp.net')) {
      return canonical;
    }
  }

  for (const jid of selfJids) {
    const canonical = host.phone.canonicalizeUserJid(jid);
    if (canonical) {
      return canonical;
    }
  }

  return host.phone.canonicalizeUserJid(fallbackChatJid) ?? fallbackChatJid;
}

export function evaluateWhatsAppAccessPolicy(
  host: WhatsAppTransportHost,
  params: {
    dmPolicy: RuntimeWhatsAppConfig['dmPolicy'];
    groupPolicy: RuntimeWhatsAppConfig['groupPolicy'];
    allowFrom: string[];
    groupAllowFrom: string[];
    chatJid: string;
    senderJid: string;
    selfJids: string[];
    fromMe: boolean;
  },
): {
  allowed: boolean;
  isGroup: boolean;
  isSelfChat: boolean;
} {
  const isGroup = host.phone.isGroupJid(params.chatJid);
  const selfChat = isSelfChat(host, params);
  const senderPhone = host.phone.jidToPhone(params.senderJid);
  const allowFrom = normalizeAllowList(host, params.allowFrom);
  const groupAllowFrom =
    params.groupAllowFrom.length > 0
      ? normalizeAllowList(host, params.groupAllowFrom)
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

async function downloadInboundMedia(
  host: WhatsAppTransportHost,
  params: {
    sock: Pick<WASocket, 'updateMediaMessage' | 'logger'>;
    message: WAMessage;
    mediaMaxMb: number;
  },
): Promise<MediaContextItem[]> {
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
      host,
      mimeType,
    )}`;
  const filename = sanitizeFilename(defaultName);
  return [
    await host.media.createContextItem({
      attachmentName: filename,
      buffer,
      mimeType,
      sizeBytes: buffer.length,
    }),
  ];
}

export async function cleanupWhatsAppInboundMedia(
  host: WhatsAppTransportHost,
  media: MediaContextItem[],
): Promise<void> {
  const tempDirs = new Set<string>();
  for (const item of media) {
    if (!item.path) continue;
    const managedDir = host.media.resolveManagedTempDir({
      filePath: item.path,
    });
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

export async function processInboundWhatsAppMessage(
  host: WhatsAppTransportHost,
  params: {
    message: WAMessage;
    sock: Pick<WASocket, 'updateMediaMessage' | 'logger'>;
    config: RuntimeWhatsAppConfig;
    selfJids: string[];
    agentId?: string;
  },
): Promise<ProcessedWhatsAppInbound | null> {
  const chatJid = params.message.key.remoteJid?.trim();
  if (
    !chatJid ||
    chatJid === STATUS_BROADCAST_JID ||
    chatJid.endsWith('@broadcast')
  ) {
    return null;
  }

  const senderJid = resolveInboundSenderJid(params.message);
  if (!senderJid) return null;

  const access = evaluateWhatsAppAccessPolicy(host, {
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
    host.logger.debug(
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

  const media = await downloadInboundMedia(host, {
    sock: params.sock,
    message: params.message,
    mediaMaxMb: params.config.mediaMaxMb,
  });
  const content = host.text.normalizeNativeAgentAddressingText(
    extractInboundText(params.message.message ?? {}) || '',
  );
  if (!content.trim() && media.length === 0) {
    return null;
  }
  const preferredSelfPhone =
    params.selfJids
      .map((jid) => host.phone.jidToPhone(jid))
      .find((phone): phone is string => Boolean(phone)) ?? null;
  const userId = access.isSelfChat
    ? (preferredSelfPhone ?? host.phone.jidToPhone(senderJid) ?? senderJid)
    : (host.phone.jidToPhone(senderJid) ?? senderJid);
  const username = String(params.message.pushName || '').trim() || userId;
  const sessionChatJid = access.isSelfChat
    ? resolveCanonicalSelfChatSessionJid(host, params.selfJids, chatJid)
    : chatJid;

  return {
    sessionId: host.buildSessionKey(
      params.agentId || host.defaultAgentId,
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
