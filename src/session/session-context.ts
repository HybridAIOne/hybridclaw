import type { ChannelKind } from '../channels/channel.js';
import {
  listChannels,
  normalizeChannelKind,
  normalizeChannelValue,
} from '../channels/channel-registry.js';
import { normalizeEmailAddress } from '../channels/email/allowlist.js';

export type SessionChatType =
  | 'channel'
  | 'cron'
  | 'dm'
  | 'group'
  | 'system'
  | 'thread';

export interface SessionSource {
  channelKind?: string;
  chatId: string;
  chatType: SessionChatType;
  userId?: string;
  userName?: string;
  guildId?: string | null;
  guildName?: string;
}

export interface SessionContext {
  source: SessionSource;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  mainSessionKey?: string;
}

const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  discord: 'Discord',
  email: 'Email',
  heartbeat: 'Heartbeat',
  imessage: 'iMessage',
  msteams: 'Microsoft Teams',
  slack: 'Slack',
  scheduler: 'Scheduler',
  telegram: 'Telegram',
  tui: 'TUI',
  voice: 'Voice',
  whatsapp: 'WhatsApp',
};

function normalizeOptional(value?: string | null): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function sanitizePromptValue(value: string): string {
  return String(value || '')
    .split(/\r\n|\r|\n/g)
    .map((line) =>
      line
        .trim()
        .replace(/^[#*`>/]+/, '')
        .replace(/[*`]/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join(' ');
}

function sanitizeOptionalPromptValue(
  value?: string | null,
): string | undefined {
  const sanitized = sanitizePromptValue(String(value || ''));
  return sanitized || undefined;
}

function maskEmailPromptValue(value: string): string {
  const normalized = normalizeEmailAddress(value);
  if (!normalized) return '[redacted]';

  const atIndex = normalized.lastIndexOf('@');
  const localPart = normalized.slice(0, atIndex);
  const domainPart = normalized.slice(atIndex + 1);
  const [firstLabel, ...restLabels] = domainPart.split('.');
  const maskedDomain = [
    firstLabel ? `${firstLabel[0]}***` : '***',
    ...restLabels.filter(Boolean),
  ].join('.');

  return `${localPart}@${maskedDomain}`;
}

function formatChannelKind(kind?: string | null): string {
  const fallback = normalizeChannelValue(kind) || '';
  const normalized = normalizeChannelKind(fallback);
  if (normalized) {
    return CHANNEL_KIND_LABELS[normalized];
  }
  if (!fallback || fallback === 'unknown') {
    return 'Unknown';
  }
  return fallback;
}

function formatChatType(type: SessionChatType): string {
  if (type === 'channel') return 'channel';
  if (type === 'cron') return 'scheduled run';
  if (type === 'dm') return 'direct message';
  if (type === 'group') return 'group chat';
  if (type === 'thread') return 'thread';
  return 'system';
}

export function buildSessionContext(params: SessionContext): SessionContext {
  return {
    source: {
      channelKind: normalizeOptional(params.source.channelKind),
      chatId: String(params.source.chatId || '').trim(),
      chatType: params.source.chatType,
      userId: normalizeOptional(params.source.userId),
      userName: normalizeOptional(params.source.userName),
      guildId:
        params.source.guildId === null
          ? null
          : normalizeOptional(params.source.guildId),
      guildName: normalizeOptional(params.source.guildName),
    },
    agentId: String(params.agentId || '').trim(),
    sessionId: String(params.sessionId || '').trim(),
    sessionKey: normalizeOptional(params.sessionKey),
    mainSessionKey: normalizeOptional(params.mainSessionKey),
  };
}

export function buildSessionContextPrompt(context: SessionContext): string {
  const connectedChannels = listChannels().map((channel) => channel.kind);
  const normalizedChannelKind = normalizeChannelKind(
    context.source.channelKind,
  );
  const platformLabel = sanitizePromptValue(
    formatChannelKind(context.source.channelKind),
  );
  const sessionId = sanitizePromptValue(context.sessionId);
  const rawChatId = sanitizePromptValue(context.source.chatId);
  const chatId =
    normalizedChannelKind === 'email'
      ? maskEmailPromptValue(rawChatId)
      : rawChatId;
  const agentId = sanitizePromptValue(context.agentId);
  const sessionKey = sanitizeOptionalPromptValue(context.sessionKey);
  const mainSessionKey = sanitizeOptionalPromptValue(context.mainSessionKey);
  const userId = sanitizeOptionalPromptValue(context.source.userId);
  const userName = sanitizeOptionalPromptValue(context.source.userName);
  const guildId =
    context.source.guildId === null
      ? null
      : sanitizeOptionalPromptValue(context.source.guildId);
  const guildName = sanitizeOptionalPromptValue(context.source.guildName);
  const lines = [
    '## Session Context',
    `**Platform:** ${platformLabel} (${formatChatType(context.source.chatType)})`,
    `**Session:** ${sessionId}`,
    `**Chat ID:** ${chatId}`,
    `**Agent:** ${agentId}`,
  ];

  if (
    sessionKey &&
    context.sessionKey &&
    context.sessionKey !== context.sessionId
  ) {
    lines.push(`**Session key:** ${sessionKey}`);
  }
  if (
    mainSessionKey &&
    context.mainSessionKey &&
    context.mainSessionKey !== context.sessionKey &&
    context.mainSessionKey !== context.sessionId
  ) {
    lines.push(`**Main session key:** ${mainSessionKey}`);
  }

  if (userId || userName) {
    const userLabel = userName
      ? userId
        ? `${userName} (id: ${userId})`
        : userName
      : userId || 'unknown';
    lines.push(`**User:** ${userLabel}`);
  }

  if (guildId || guildName) {
    const guildLabel = guildName
      ? guildId
        ? `${guildName} (id: ${guildId})`
        : guildName
      : guildId || 'unknown';
    lines.push(`**Guild:** ${guildLabel}`);
  }

  lines.push(
    `**Connected channels:** ${
      connectedChannels.length > 0 ? connectedChannels.join(', ') : 'none'
    }`,
  );

  return lines.join('\n');
}
