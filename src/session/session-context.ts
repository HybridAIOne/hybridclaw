import type { ChannelKind } from '../channels/channel.js';

export type SessionChatType =
  | 'channel'
  | 'cron'
  | 'dm'
  | 'group'
  | 'system'
  | 'thread';

export interface SessionSource {
  channelKind: ChannelKind | string;
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
  connectedChannels: string[];
}

function normalizeOptional(value?: string | null): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function normalizeChannelKind(value?: string | null): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

function normalizeChannelList(
  values?: string[],
  sourceChannelKind?: string | null,
): string[] {
  const normalizedValues = Array.isArray(values)
    ? values
        .map((value) => normalizeChannelKind(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const normalizedSourceChannelKind = normalizeChannelKind(sourceChannelKind);
  if (normalizedSourceChannelKind) {
    normalizedValues.unshift(normalizedSourceChannelKind);
  }
  return Array.from(new Set(normalizedValues));
}

function formatChannelKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (normalized === 'discord') return 'Discord';
  if (normalized === 'email') return 'Email';
  if (normalized === 'heartbeat') return 'Heartbeat';
  if (normalized === 'msteams') return 'Microsoft Teams';
  if (normalized === 'scheduler') return 'Scheduler';
  if (normalized === 'tui') return 'TUI';
  if (normalized === 'whatsapp') return 'WhatsApp';
  if (normalized === 'web') return 'Web';
  if (normalized === 'cli') return 'CLI';
  if (normalized === 'api') return 'API';
  return normalized || 'Unknown';
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
      channelKind: normalizeOptional(params.source.channelKind) || 'unknown',
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
    connectedChannels: normalizeChannelList(
      params.connectedChannels,
      params.source.channelKind,
    ),
  };
}

export function buildSessionContextPrompt(context: SessionContext): string {
  const lines = [
    '## Session Context',
    `**Platform:** ${formatChannelKind(String(context.source.channelKind))} (${formatChatType(context.source.chatType)})`,
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
      context.connectedChannels.length > 0
        ? context.connectedChannels.join(', ')
        : 'none'
    }`,
  );

  return lines.join('\n');
}
