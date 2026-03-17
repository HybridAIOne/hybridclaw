import type { ChannelKind } from '../channels/channel.js';
import {
  listChannels,
  normalizeChannelKind,
  normalizeChannelValue,
} from '../channels/channel-registry.js';

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
}

const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  discord: 'Discord',
  email: 'Email',
  heartbeat: 'Heartbeat',
  msteams: 'Microsoft Teams',
  scheduler: 'Scheduler',
  tui: 'TUI',
  whatsapp: 'WhatsApp',
};

function normalizeOptional(value?: string | null): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
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
  };
}

export function buildSessionContextPrompt(context: SessionContext): string {
  const connectedChannels = listChannels().map((channel) => channel.kind);
  const lines = [
    '## Session Context',
    `**Platform:** ${formatChannelKind(context.source.channelKind)} (${formatChatType(context.source.chatType)})`,
    `**Session:** ${context.sessionId}`,
    `**Chat ID:** ${context.source.chatId}`,
    `**Agent:** ${context.agentId}`,
  ];

  if (context.sessionKey && context.sessionKey !== context.sessionId) {
    lines.push(`**Session key:** ${context.sessionKey}`);
  }

  if (context.source.userId || context.source.userName) {
    const userLabel = context.source.userName
      ? context.source.userId
        ? `${context.source.userName} (id: ${context.source.userId})`
        : context.source.userName
      : context.source.userId || 'unknown';
    lines.push(`**User:** ${userLabel}`);
  }

  if (context.source.guildId || context.source.guildName) {
    const guildLabel = context.source.guildName
      ? context.source.guildId
        ? `${context.source.guildName} (id: ${context.source.guildId})`
        : context.source.guildName
      : context.source.guildId || 'unknown';
    lines.push(`**Guild:** ${guildLabel}`);
  }

  lines.push(
    `**Connected channels:** ${
      connectedChannels.length > 0 ? connectedChannels.join(', ') : 'none'
    }`,
  );

  return lines.join('\n');
}
