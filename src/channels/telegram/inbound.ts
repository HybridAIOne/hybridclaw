import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type {
  RuntimeTelegramConfig,
  TelegramDmPolicy,
  TelegramGroupPolicy,
} from '../../config/runtime-config.js';
import { createUploadedMediaContextItem } from '../../media/uploaded-media-cache.js';
import { buildSessionKey } from '../../session/session-key.js';
import type { MediaContextItem } from '../../types/container.js';
import {
  callTelegramApi,
  fetchTelegramFile,
  type TelegramFile,
  type TelegramMessage,
  type TelegramMessageEntity,
  type TelegramUser,
} from './api.js';
import { buildTelegramChannelId } from './target.js';

export interface ProcessedTelegramInbound {
  sessionId: string;
  guildId: null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  media: MediaContextItem[];
  isGroup: boolean;
  topicId?: number;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function normalizeTelegramIdentity(
  value: string | number | null | undefined,
): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (/^@?[a-z][a-z0-9_]{4,31}$/i.test(trimmed)) {
    return trimmed.startsWith('@')
      ? trimmed.toLowerCase()
      : `@${trimmed.toLowerCase()}`;
  }
  return null;
}

function normalizeAllowList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeTelegramIdentity(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function matchesAllowList(
  list: string[],
  senderId: string,
  senderUsername?: string | null,
): boolean {
  if (list.includes('*')) return true;
  const normalizedUsername = normalizeTelegramIdentity(senderUsername);
  return (
    list.includes(senderId) ||
    Boolean(normalizedUsername && list.includes(normalizedUsername))
  );
}

function isGroupChat(type: TelegramMessage['chat']['type']): boolean {
  return type === 'group' || type === 'supergroup';
}

function extractEntityText(
  text: string,
  entity: Pick<TelegramMessageEntity, 'offset' | 'length'>,
): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function messageMentionsBot(
  message: TelegramMessage,
  botUser: TelegramUser,
): boolean {
  const botUsername = String(botUser.username || '')
    .trim()
    .toLowerCase();
  const messageText = String(message.text || message.caption || '');
  const entities = [
    ...(message.entities || []),
    ...(message.caption_entities || []),
  ];
  const normalizedText = messageText.toLowerCase();

  if (message.reply_to_message?.from?.id === botUser.id) {
    return true;
  }
  if (normalizedText.trim().startsWith('/')) {
    return true;
  }

  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user?.id === botUser.id) {
      return true;
    }
    if (!messageText) continue;

    const token = extractEntityText(messageText, entity).trim().toLowerCase();
    if (entity.type === 'mention' && botUsername) {
      if (token === `@${botUsername}`) return true;
      continue;
    }
    if (entity.type === 'bot_command') {
      const [, explicitTarget] = token.split('@');
      if (!explicitTarget || (botUsername && explicitTarget === botUsername)) {
        return true;
      }
    }
  }

  return Boolean(botUsername && normalizedText.includes(`@${botUsername}`));
}

export function evaluateTelegramAccessPolicy(params: {
  dmPolicy: TelegramDmPolicy;
  groupPolicy: TelegramGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  chatType: TelegramMessage['chat']['type'];
  senderId: string;
  senderUsername?: string | null;
  isBotMessage: boolean;
  requireMention: boolean;
  isMentioned: boolean;
}): { allowed: boolean; isGroup: boolean } {
  const isGroup = isGroupChat(params.chatType);
  if (params.isBotMessage) {
    return { allowed: false, isGroup };
  }

  const allowFrom = normalizeAllowList(params.allowFrom);
  const groupAllowFrom =
    params.groupAllowFrom.length > 0
      ? normalizeAllowList(params.groupAllowFrom)
      : allowFrom;

  if (isGroup) {
    if (params.groupPolicy === 'disabled') {
      return { allowed: false, isGroup: true };
    }
    if (params.requireMention && !params.isMentioned) {
      return { allowed: false, isGroup: true };
    }
    if (params.groupPolicy === 'open') {
      return { allowed: true, isGroup: true };
    }
    return {
      allowed: matchesAllowList(
        groupAllowFrom,
        params.senderId,
        params.senderUsername,
      ),
      isGroup: true,
    };
  }

  if (params.dmPolicy === 'disabled') {
    return { allowed: false, isGroup: false };
  }
  if (params.dmPolicy === 'open') {
    return { allowed: true, isGroup: false };
  }
  return {
    allowed: matchesAllowList(
      allowFrom,
      params.senderId,
      params.senderUsername,
    ),
    isGroup: false,
  };
}

function buildTelegramDisplayName(user: TelegramUser): string {
  const fullName = [user.first_name, user.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (fullName) return fullName;
  const username = String(user.username || '').trim();
  if (username) return `@${username}`;
  return String(user.id);
}

function buildInboundText(
  message: TelegramMessage,
  media: MediaContextItem[],
): string {
  const text = String(message.text || message.caption || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (text) return text;
  if (media.length === 0) return '';
  if (message.photo?.length) return '<media:photo>';
  if (message.video) return '<media:video>';
  if (message.audio) return '<media:audio>';
  if (message.voice) return '<media:voice>';
  if (message.document) return '<media:document>';
  return '<media:file>';
}

function resolveMediaDescriptor(message: TelegramMessage): {
  file:
    | TelegramFile
    | (Pick<TelegramFile, 'file_id' | 'file_size'> & {
        file_name?: string;
        mime_type?: string;
      });
  defaultFilename: string;
  mimeType: string | null;
  sizeBytes: number;
} | null {
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  if (photo) {
    return {
      file: photo,
      defaultFilename: `telegram-photo-${photo.file_unique_id || photo.file_id}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: Number(photo.file_size || 0),
    };
  }
  if (message.document) {
    return {
      file: message.document,
      defaultFilename:
        message.document.file_name ||
        `telegram-document-${message.document.file_id}.bin`,
      mimeType: message.document.mime_type || null,
      sizeBytes: Number(message.document.file_size || 0),
    };
  }
  if (message.video) {
    return {
      file: message.video,
      defaultFilename:
        message.video.file_name ||
        `telegram-video-${message.video.file_id}.mp4`,
      mimeType: message.video.mime_type || 'video/mp4',
      sizeBytes: Number(message.video.file_size || 0),
    };
  }
  if (message.audio) {
    return {
      file: message.audio,
      defaultFilename:
        message.audio.file_name ||
        `telegram-audio-${message.audio.file_id}.mp3`,
      mimeType: message.audio.mime_type || 'audio/mpeg',
      sizeBytes: Number(message.audio.file_size || 0),
    };
  }
  if (message.voice) {
    return {
      file: message.voice,
      defaultFilename: `telegram-voice-${message.voice.file_id}.ogg`,
      mimeType: message.voice.mime_type || 'audio/ogg',
      sizeBytes: Number(message.voice.file_size || 0),
    };
  }
  return null;
}

async function downloadTelegramMedia(params: {
  botToken: string;
  descriptor: ReturnType<typeof resolveMediaDescriptor>;
  mediaMaxMb: number;
}): Promise<MediaContextItem[]> {
  const { descriptor } = params;
  if (!descriptor) return [];

  const maxBytes = Math.max(1, params.mediaMaxMb) * 1024 * 1024;
  if (descriptor.sizeBytes > 0 && descriptor.sizeBytes > maxBytes) {
    return [];
  }

  const fileMeta = await callTelegramApi<TelegramFile>(
    params.botToken,
    'getFile',
    {
      file_id: descriptor.file.file_id,
    },
  );
  if (!fileMeta.file_path) return [];
  if (Number(fileMeta.file_size || 0) > maxBytes) {
    return [];
  }

  const buffer = await fetchTelegramFile(params.botToken, fileMeta.file_path);
  if (buffer.length > maxBytes) {
    return [];
  }

  const filename = sanitizeFilename(descriptor.defaultFilename);
  return [
    await createUploadedMediaContextItem({
      attachmentName: filename,
      buffer,
      mimeType: descriptor.mimeType,
      sizeBytes: buffer.length,
    }),
  ];
}

export async function processInboundTelegramMessage(params: {
  botToken: string;
  config: RuntimeTelegramConfig;
  message: TelegramMessage;
  botUser: TelegramUser;
  agentId?: string;
}): Promise<ProcessedTelegramInbound | null> {
  const sender = params.message.from;
  if (!sender) return null;
  if (params.message.chat.type === 'channel') return null;

  const senderId = String(sender.id);
  const isMentioned = messageMentionsBot(params.message, params.botUser);
  const access = evaluateTelegramAccessPolicy({
    dmPolicy: params.config.dmPolicy,
    groupPolicy: params.config.groupPolicy,
    allowFrom: params.config.allowFrom,
    groupAllowFrom: params.config.groupAllowFrom,
    chatType: params.message.chat.type,
    senderId,
    senderUsername: sender.username,
    isBotMessage: sender.is_bot,
    requireMention: params.config.requireMention,
    isMentioned,
  });
  if (!access.allowed) return null;

  const hasTextContent = Boolean(
    String(params.message.text || params.message.caption || '')
      .replace(/\r\n?/g, '\n')
      .trim(),
  );
  const mediaDescriptor = resolveMediaDescriptor(params.message);
  if (!hasTextContent && !mediaDescriptor) {
    return null;
  }

  const media = await downloadTelegramMedia({
    botToken: params.botToken,
    descriptor: mediaDescriptor,
    mediaMaxMb: params.config.mediaMaxMb,
  });
  const content = buildInboundText(params.message, media);
  if (!content && media.length === 0) {
    return null;
  }

  const channelId = buildTelegramChannelId(
    String(params.message.chat.id),
    params.message.message_thread_id,
  );

  return {
    sessionId: buildSessionKey(
      params.agentId || DEFAULT_AGENT_ID,
      'telegram',
      access.isGroup ? 'group' : 'dm',
      channelId,
      params.message.message_thread_id
        ? { threadId: String(params.message.message_thread_id) }
        : undefined,
    ),
    guildId: null,
    channelId,
    userId: senderId,
    username: buildTelegramDisplayName(sender),
    content,
    media,
    isGroup: access.isGroup,
    ...(params.message.message_thread_id
      ? { topicId: params.message.message_thread_id }
      : {}),
  };
}
