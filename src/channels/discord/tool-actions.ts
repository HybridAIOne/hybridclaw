import type { Client, GuildMember } from 'discord.js';

export type DiscordToolAction = 'read' | 'member-info' | 'channel-info';

export interface DiscordToolActionRequest {
  action: DiscordToolAction;
  channelId?: string;
  guildId?: string;
  userId?: string;
  username?: string;
  user?: string;
  memberId?: string;
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
}

export interface CachedDiscordPresenceActivity {
  type: number;
  name: string;
  state: string | null;
  details: string | null;
}

export interface CachedDiscordPresence {
  status: string;
  activities: CachedDiscordPresenceActivity[];
}

export interface DiscordToolActionDependencies {
  requireDiscordClientReady: () => Client;
  getDiscordPresence: (userId: string) => CachedDiscordPresence | undefined;
}

function sanitizeDiscordId(rawValue: string | undefined, label: string): string {
  const value = (rawValue || '').trim();
  if (!/^\d{16,22}$/.test(value)) {
    throw new Error(`${label} must be a Discord snowflake id.`);
  }
  return value;
}

function normalizeDiscordUserLookupQuery(rawValue: string | undefined): string {
  const trimmed = (rawValue || '').trim();
  if (!trimmed) return '';

  const mentionMatch = trimmed.match(/^<@!?(\d{16,22})>$/);
  if (mentionMatch) return mentionMatch[1];
  const prefixedId = trimmed.match(/^(?:user:|discord:)?(\d{16,22})$/i);
  if (prefixedId) return prefixedId[1];

  return trimmed.replace(/^@+/, '').trim();
}

function scoreGuildMemberForLookup(member: GuildMember, query: string): number {
  const q = query.toLowerCase();
  const username = member.user.username?.toLowerCase() || '';
  const globalName = member.user.globalName?.toLowerCase() || '';
  const nickname = member.nickname?.toLowerCase() || '';
  const displayName = member.displayName?.toLowerCase() || '';
  const candidates = [username, globalName, nickname, displayName].filter(Boolean);

  let score = 0;
  if (candidates.some((value) => value === q)) score += 3;
  if (candidates.some((value) => value.includes(q))) score += 1;
  if (!member.user.bot) score += 1;
  return score;
}

async function resolveGuildMemberIdFromLookup(params: {
  requireDiscordClientReady: () => Client;
  guildId: string;
  rawUser: string;
}): Promise<{ userId: string; note?: string }> {
  const activeClient = params.requireDiscordClientReady();
  const guildId = sanitizeDiscordId(params.guildId, 'guildId');
  const normalized = normalizeDiscordUserLookupQuery(params.rawUser);
  if (!normalized) {
    throw new Error('userId or username is required.');
  }
  if (/^\d{16,22}$/.test(normalized)) {
    return { userId: normalized };
  }

  const guild = await activeClient.guilds.fetch(guildId);
  const searchQuery = normalized.slice(0, 32);
  if (!searchQuery) {
    throw new Error('username query is empty after normalization.');
  }

  let members: Map<string, GuildMember>;
  try {
    members = await guild.members.search({ query: searchQuery, limit: 25 });
  } catch {
    const fetched = await guild.members.fetch({ query: searchQuery, limit: 25 });
    members = fetched;
  }
  let best: GuildMember | null = null;
  let bestScore = 0;
  let matchCount = 0;
  for (const member of members.values()) {
    const score = scoreGuildMemberForLookup(member, searchQuery);
    if (score <= 0) continue;
    matchCount += 1;
    if (!best || score > bestScore) {
      best = member;
      bestScore = score;
    }
  }

  if (!best) {
    throw new Error(`No guild member matched username "${searchQuery}".`);
  }

  return {
    userId: best.id,
    note: matchCount > 1 ? 'multiple matches; chose best' : undefined,
  };
}

function normalizeDate(value: Date | null | undefined): string | null {
  if (!value) return null;
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return null;
  return value.toISOString();
}

async function runDiscordReadAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const activeClient = deps.requireDiscordClientReady();
  const channelId = sanitizeDiscordId(request.channelId, 'channelId');
  const channel = await activeClient.channels.fetch(channelId);
  if (!channel || !('messages' in channel)) {
    throw new Error('Channel does not support message reads.');
  }

  const requestedLimit =
    typeof request.limit === 'number' && Number.isFinite(request.limit)
      ? Math.floor(request.limit)
      : 20;
  const limit = Math.max(1, Math.min(100, requestedLimit));
  const before = request.before?.trim();
  const after = request.after?.trim();
  const around = request.around?.trim();

  const query: { limit: number; before?: string; after?: string; around?: string } = { limit };
  if (before) query.before = before;
  if (after) query.after = after;
  if (around) query.around = around;

  const fetched = await channel.messages.fetch(query);
  const messages = Array.from(fetched.values())
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id))
    .map((message) => ({
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? null,
      content: message.content || '',
      createdAt: new Date(message.createdTimestamp).toISOString(),
      editedAt: normalizeDate(message.editedAt),
      author: {
        id: message.author?.id || 'unknown',
        username: message.author?.username || 'unknown',
        handle: message.author?.username ? `@${message.author.username}` : null,
        globalName: message.author?.globalName || null,
        bot: Boolean(message.author?.bot),
      },
      member: message.member
        ? {
            id: message.member.id,
            nickname: message.member.nickname || null,
            displayName: message.member.displayName || null,
          }
        : null,
      attachments: Array.from(message.attachments.values()).map((attachment) => ({
        id: attachment.id,
        name: attachment.name || null,
        url: attachment.url,
        contentType: attachment.contentType || null,
        size: attachment.size,
      })),
      mentions: {
        users: Array.from(message.mentions.users.values()).map((user) => ({
          id: user.id,
          username: user.username,
          bot: Boolean(user.bot),
        })),
        roles: Array.from(message.mentions.roles.values()).map((role) => ({
          id: role.id,
          name: role.name,
        })),
        channels: Array.from(message.mentions.channels.values()).map((mentionedChannel) => ({
          id: mentionedChannel.id,
          name: 'name' in mentionedChannel && typeof mentionedChannel.name === 'string'
            ? mentionedChannel.name
            : null,
        })),
      },
    }));

  return {
    ok: true,
    action: 'read',
    channelId,
    count: messages.length,
    messages,
  };
}

async function runDiscordMemberInfoAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const activeClient = deps.requireDiscordClientReady();
  const guildId = sanitizeDiscordId(request.guildId, 'guildId');
  const userLookupRaw =
    request.userId
    || request.memberId
    || request.user
    || request.username;
  const resolvedUser = await resolveGuildMemberIdFromLookup({
    requireDiscordClientReady: deps.requireDiscordClientReady,
    guildId,
    rawUser: userLookupRaw || '',
  });
  const userId = sanitizeDiscordId(resolvedUser.userId, 'userId');

  const guild = await activeClient.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  const presence = deps.getDiscordPresence(userId);

  const roles = member.roles.cache
    .filter((role) => role.id !== guild.id)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.hexColor,
      position: role.position,
    }))
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));

  return {
    ok: true,
    action: 'member-info',
    guildId,
    userId,
    ...(resolvedUser.note ? { note: resolvedUser.note } : {}),
    member: {
      id: member.id,
      username: member.user.username,
      handle: member.user.username ? `@${member.user.username}` : null,
      globalName: member.user.globalName || null,
      bot: Boolean(member.user.bot),
      displayName: member.displayName,
      nickname: member.nickname || null,
      joinedAt: normalizeDate(member.joinedAt),
      premiumSince: normalizeDate(member.premiumSince),
      communicationDisabledUntil: normalizeDate(member.communicationDisabledUntil),
      roles,
    },
    ...(presence
      ? {
          status: presence.status,
          activities: presence.activities,
        }
      : {}),
  };
}

async function runDiscordChannelInfoAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const activeClient = deps.requireDiscordClientReady();
  const channelId = sanitizeDiscordId(request.channelId, 'channelId');
  const channel = await activeClient.channels.fetch(channelId);
  if (!channel) {
    throw new Error('Channel not found.');
  }

  const channelData: Record<string, unknown> = {
    id: channel.id,
    type: channel.type,
    guildId: 'guildId' in channel ? channel.guildId || null : null,
    name: 'name' in channel && typeof channel.name === 'string' ? channel.name : null,
    parentId: 'parentId' in channel ? channel.parentId || null : null,
    topic: 'topic' in channel && typeof channel.topic === 'string' ? channel.topic : null,
    nsfw: 'nsfw' in channel && typeof channel.nsfw === 'boolean' ? channel.nsfw : null,
    rateLimitPerUser:
      'rateLimitPerUser' in channel && typeof channel.rateLimitPerUser === 'number'
        ? channel.rateLimitPerUser
        : null,
    isTextBased: typeof channel.isTextBased === 'function' ? channel.isTextBased() : false,
    isDMBased: typeof channel.isDMBased === 'function' ? channel.isDMBased() : false,
    isThread: typeof channel.isThread === 'function' ? channel.isThread() : false,
    lastMessageId: 'lastMessageId' in channel ? channel.lastMessageId || null : null,
  };

  if (typeof channel.isThread === 'function' && channel.isThread()) {
    channelData.archived =
      'archived' in channel && typeof channel.archived === 'boolean' ? channel.archived : null;
    channelData.locked =
      'locked' in channel && typeof channel.locked === 'boolean' ? channel.locked : null;
    channelData.ownerId = 'ownerId' in channel ? channel.ownerId || null : null;
  }

  return {
    ok: true,
    action: 'channel-info',
    channel: channelData,
  };
}

export function createDiscordToolActionRunner(deps: DiscordToolActionDependencies): (
  request: DiscordToolActionRequest,
) => Promise<Record<string, unknown>> {
  return async (request: DiscordToolActionRequest) => {
    switch (request.action) {
      case 'read':
        return await runDiscordReadAction(request, deps);
      case 'member-info':
        return await runDiscordMemberInfoAction(request, deps);
      case 'channel-info':
        return await runDiscordChannelInfoAction(request, deps);
      default:
        throw new Error(`Unsupported Discord action: ${request.action as string}`);
    }
  };
}
