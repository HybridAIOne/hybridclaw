import {
  ActivityType,
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  type GuildMember,
  type Message as DiscordMessage,
  Partials,
} from 'discord.js';

import {
  DISCORD_COMMAND_USER_ID,
  DISCORD_COMMANDS_ONLY,
  DISCORD_GUILD_MEMBERS_INTENT,
  DISCORD_PRESENCE_INTENT,
  DISCORD_PREFIX,
  DISCORD_RESPOND_TO_ALL_MESSAGES,
  DISCORD_TOKEN,
} from './config.js';
import { chunkMessage } from './chunk.js';
import { DiscordStreamManager } from './discord-stream.js';
import { logger } from './logger.js';

export type ReplyFn = (content: string, files?: AttachmentBuilder[]) => Promise<void>;

interface PendingGuildHistoryEntry {
  messageId: string;
  userId: string;
  username: string;
  displayName: string | null;
  isBot: boolean;
  timestampMs: number;
  content: string;
}

interface ParticipantInfo {
  id: string;
  aliases: Set<string>;
}

export interface MentionLookup {
  byAlias: Map<string, Set<string>>;
}

interface MentionAliasHint {
  alias: string;
  userId: string;
}

export interface MessageRunContext {
  sourceMessage: DiscordMessage;
  batchedMessages: DiscordMessage[];
  abortSignal: AbortSignal;
  stream: DiscordStreamManager;
  mentionLookup: MentionLookup;
}

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

export type MessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  reply: ReplyFn,
  context: MessageRunContext,
) => Promise<void>;

export type CommandHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  args: string[],
  reply: ReplyFn,
) => Promise<void>;

let client: Client;
let messageHandler: MessageHandler;
let commandHandler: CommandHandler;
let activeConversationRuns = 0;
let botMentionRegex: RegExp | null = null;
const MESSAGE_DEBOUNCE_MS = 2_500;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_CONTEXT_CHARS = 16_000;
const MAX_SINGLE_ATTACHMENT_CHARS = 8_000;
const DISCORD_RETRY_MAX_ATTEMPTS = 3;
const DISCORD_RETRY_BASE_DELAY_MS = 500;
const GUILD_INBOUND_HISTORY_LIMIT = 20;
const GUILD_INBOUND_HISTORY_MAX_CHARS = 6_000;
const PARTICIPANT_CONTEXT_MAX_USERS = 30;
const PARTICIPANT_MEMORY_MAX_CHANNELS = 200;
const PARTICIPANT_MEMORY_MAX_USERS_PER_CHANNEL = 200;
const PARTICIPANT_MEMORY_MAX_ALIASES_PER_USER = 8;
const MENTION_ALIAS_LOOKUP_MAX = 8;
const MAX_PRESENCE_CACHE_USERS = 5_000;

interface CachedDiscordPresenceActivity {
  type: number;
  name: string;
  state: string | null;
  details: string | null;
}

interface CachedDiscordPresence {
  status: string;
  activities: CachedDiscordPresenceActivity[];
}

const discordPresenceCache = new Map<string, CachedDiscordPresence>();

function setDiscordPresence(userId: string, data: CachedDiscordPresence): void {
  discordPresenceCache.set(userId, data);
  if (discordPresenceCache.size > MAX_PRESENCE_CACHE_USERS) {
    const oldestUserId = discordPresenceCache.keys().next().value;
    if (oldestUserId) {
      discordPresenceCache.delete(oldestUserId);
    }
  }
}

function getDiscordPresence(userId: string): CachedDiscordPresence | undefined {
  return discordPresenceCache.get(userId);
}

function normalizeMentionAlias(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/^@+/, '');
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (lowered === 'everyone' || lowered === 'here') return '';
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(trimmed)) return '';
  return lowered;
}

function addMentionAlias(lookup: MentionLookup, rawAlias: string | null | undefined, userId: string): void {
  const alias = normalizeMentionAlias(rawAlias);
  if (!alias) return;
  let ids = lookup.byAlias.get(alias);
  if (!ids) {
    ids = new Set<string>();
    lookup.byAlias.set(alias, ids);
  }
  ids.add(userId);
}

function extractMentionAliasHints(text: string): MentionAliasHint[] {
  if (!text) return [];

  const hints = new Map<string, MentionAliasHint>();
  const collect = (rawAlias: string | null | undefined, rawUserId: string | null | undefined): void => {
    const userId = (rawUserId || '').trim();
    if (!/^\d{16,22}$/.test(userId)) return;
    const alias = normalizeMentionAlias(rawAlias);
    if (!alias) return;
    const key = `${alias}:${userId}`;
    if (!hints.has(key)) hints.set(key, { alias, userId });
  };

  const aliasToId = /(^|[\s,;:.!?])@?([\p{L}\p{N}._-]{2,32})\s*(?:ist|is|=|->|=>|means|heißt)\s*(?:<@!?(\d{16,22})>|(\d{16,22}))/giu;
  let match: RegExpExecArray | null;
  while ((match = aliasToId.exec(text)) !== null) {
    collect(match[2], match[3] || match[4]);
  }

  const idToAlias = /(?:<@!?(\d{16,22})>|(\d{16,22}))\s*(?:ist|is|=|->|=>|means|heißt)\s*@?([\p{L}\p{N}._-]{2,32})/giu;
  while ((match = idToAlias.exec(text)) !== null) {
    collect(match[3], match[1] || match[2]);
  }

  return Array.from(hints.values());
}

function buildMentionLookup(
  messages: DiscordMessage[],
  pendingHistory: PendingGuildHistoryEntry[],
  rememberedParticipants?: Map<string, Set<string>>,
): MentionLookup {
  const lookup: MentionLookup = { byAlias: new Map<string, Set<string>>() };
  const botUserId = client.user?.id || '';

  const addUser = (userId: string, aliases: Array<string | null | undefined>): void => {
    if (!userId || userId === botUserId) return;
    for (const alias of aliases) {
      addMentionAlias(lookup, alias, userId);
    }
  };

  for (const msg of messages) {
    const authorAliases = [msg.author?.username];
    if (msg.member?.displayName) authorAliases.push(msg.member.displayName);
    addUser(msg.author.id, authorAliases);

    for (const mentioned of msg.mentions.users.values()) {
      const aliases = [mentioned.username];
      const mentionedMember = msg.mentions.members?.get(mentioned.id);
      if (mentionedMember?.displayName) aliases.push(mentionedMember.displayName);
      addUser(mentioned.id, aliases);
    }

    for (const hint of extractMentionAliasHints(msg.content || '')) {
      addMentionAlias(lookup, hint.alias, hint.userId);
    }
  }

  for (const entry of pendingHistory) {
    addUser(entry.userId, [entry.username, entry.displayName]);
    for (const hint of extractMentionAliasHints(entry.content)) {
      addMentionAlias(lookup, hint.alias, hint.userId);
    }
  }

  if (rememberedParticipants) {
    for (const [userId, aliases] of rememberedParticipants) {
      addUser(userId, Array.from(aliases));
    }
  }

  return lookup;
}

export function rewriteUserMentions(text: string, lookup: MentionLookup): string {
  if (!text) return text;
  if (!lookup.byAlias.size) return text;
  return text.replace(/(^|[\s([{:>])@([\p{L}\p{N}._-]{2,32})\b/gu, (full, prefix: string, rawAlias: string) => {
    const alias = normalizeMentionAlias(rawAlias);
    if (!alias) return full;
    const ids = lookup.byAlias.get(alias);
    if (!ids || ids.size !== 1) return full;
    const [id] = Array.from(ids);
    if (!id) return full;
    return `${prefix}<@${id}>`;
  });
}

function extractMentionAliases(text: string): string[] {
  if (!text) return [];
  const aliases = new Set<string>();
  const re = /(^|[\s([{:>])@([\p{L}\p{N}._-]{2,32})\b/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const alias = normalizeMentionAlias(match[2]);
    if (!alias) continue;
    aliases.add(alias);
    if (aliases.size >= MENTION_ALIAS_LOOKUP_MAX) break;
  }
  return Array.from(aliases);
}

async function enrichMentionLookupFromGuild(
  msg: DiscordMessage,
  lookup: MentionLookup,
  aliases: string[],
): Promise<void> {
  if (!msg.guild || aliases.length === 0) return;

  for (const alias of aliases) {
    if (lookup.byAlias.has(alias)) continue;
    try {
      const members = await msg.guild.members.search({ query: alias, limit: 5 });
      const exactMatches = Array.from(members.values()).filter((member) => {
        const username = normalizeMentionAlias(member.user?.username || '');
        const displayName = normalizeMentionAlias(member.displayName || '');
        return username === alias || displayName === alias;
      });
      if (exactMatches.length !== 1) continue;
      const match = exactMatches[0];
      addMentionAlias(lookup, alias, match.id);
      addMentionAlias(lookup, match.user?.username || '', match.id);
      addMentionAlias(lookup, match.displayName || '', match.id);
    } catch (error) {
      logger.debug(
        { error, guildId: msg.guild.id, alias },
        'Failed to resolve guild member alias for mention rewrite',
      );
    }
  }
}

export async function rewriteUserMentionsForMessage(
  text: string,
  msg: DiscordMessage,
  lookup: MentionLookup,
): Promise<string> {
  const aliases = extractMentionAliases(text);
  if (aliases.length > 0) {
    await enrichMentionLookupFromGuild(msg, lookup, aliases);
  }
  return rewriteUserMentions(text, lookup);
}

function summarizePendingHistoryEntry(entry: PendingGuildHistoryEntry): string {
  const author = entry.displayName || entry.username || 'user';
  const authorLabel = entry.isBot ? `${author} [bot]` : author;
  const content = entry.content.trim();
  const snippet = content.length > 300 ? `${content.slice(0, 297)}...` : content;
  return `${authorLabel}: ${snippet}`;
}

function buildPendingHistoryContext(entries: PendingGuildHistoryEntry[]): string {
  if (entries.length === 0) return '';
  const selected: string[] = [];
  let totalChars = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const line = summarizePendingHistoryEntry(entries[i]);
    if (!line) continue;
    if (totalChars + line.length > GUILD_INBOUND_HISTORY_MAX_CHARS && selected.length > 0) break;
    selected.push(line);
    totalChars += line.length + 1;
  }
  if (selected.length === 0) return '';
  selected.reverse();
  return [
    '[InboundHistory]',
    'Recent channel messages (most recent last):',
    ...selected,
    '',
    '',
  ].join('\n');
}

async function buildInboundHistorySnapshot(
  msg: DiscordMessage,
  excludeMessageIds: Set<string>,
): Promise<{ entries: PendingGuildHistoryEntry[]; context: string }> {
  if (!msg.guild || !('messages' in msg.channel)) return { entries: [], context: '' };

  try {
    const recentMessages = await msg.channel.messages.fetch({ limit: GUILD_INBOUND_HISTORY_LIMIT });
    const entries: PendingGuildHistoryEntry[] = [];
    let hiddenTextCount = 0;
    let hiddenBotTextCount = 0;

    const summarizeHistoryMessageContent = (recent: DiscordMessage): string => {
      const plainText = cleanIncomingContent(recent.content || '').trim();
      if (plainText) return plainText;

      const embedChunks = recent.embeds
        .map((embed) => [embed.title?.trim(), embed.description?.trim()].filter(Boolean).join(' — '))
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (embedChunks.length > 0) {
        return `[embed] ${embedChunks.join(' | ')}`;
      }

      const attachmentNames = Array.from(recent.attachments.values())
        .map((attachment) => attachment.name?.trim())
        .filter((name): name is string => Boolean(name))
        .slice(0, 5);
      if (attachmentNames.length > 0) {
        return `[attachments] ${attachmentNames.join(', ')}`;
      }

      const systemContent = recent.system ? (recent.cleanContent || '').trim() : '';
      if (systemContent) return `[system] ${systemContent}`;

      hiddenTextCount += 1;
      if (recent.author?.bot) hiddenBotTextCount += 1;
      return '[no visible text]';
    };

    for (const recent of recentMessages.values()) {
      if (excludeMessageIds.has(recent.id)) continue;
      if (!recent.author?.id) continue;
      if (recent.author.id === client.user?.id) continue;
      const content = summarizeHistoryMessageContent(recent);
      if (!content) continue;
      entries.push({
        messageId: recent.id,
        userId: recent.author.id,
        username: recent.author.username || 'user',
        displayName: recent.member?.displayName || null,
        isBot: Boolean(recent.author.bot),
        timestampMs: Number.isFinite(recent.createdTimestamp) ? recent.createdTimestamp : 0,
        content,
      });
    }
    entries.sort((a, b) => a.timestampMs - b.timestampMs || a.messageId.localeCompare(b.messageId));
    let context = buildPendingHistoryContext(entries);
    if (hiddenTextCount > 0) {
      const visibilityNote = [
        '[Discord visibility note]',
        `${hiddenTextCount} recent message(s) had no visible text via API${hiddenBotTextCount > 0 ? ` (${hiddenBotTextCount} from bot users)` : ''}.`,
        'If asked for exact wording of those messages, say text was not visible in this snapshot.',
        '',
        '',
      ].join('\n');
      context = `${visibilityNote}${context}`;
    }
    return {
      entries,
      context,
    };
  } catch (error) {
    logger.debug({ error, guildId: msg.guild.id, channelId: msg.channelId }, 'Failed to build inbound channel history snapshot');
    return { entries: [], context: '' };
  }
}

function addParticipantAlias(info: ParticipantInfo, alias: string | null | undefined): void {
  const normalized = normalizeMentionAlias(alias);
  if (!normalized) return;
  info.aliases.add(normalized);
}

function formatDiscordHandleFromAlias(alias: string | null | undefined): string | null {
  const normalized = normalizeMentionAlias(alias);
  if (!normalized) return null;
  return `@${normalized}`;
}

function buildParticipantContext(
  messages: DiscordMessage[],
  pendingHistory: PendingGuildHistoryEntry[],
  rememberedParticipants?: Map<string, Set<string>>,
): string {
  const participants = new Map<string, ParticipantInfo>();
  const botUserId = client.user?.id || '';
  const botParticipantIds = new Set<string>();

  const upsert = (userId: string): ParticipantInfo => {
    let info = participants.get(userId);
    if (!info) {
      info = { id: userId, aliases: new Set<string>() };
      participants.set(userId, info);
    }
    return info;
  };

  for (const msg of messages) {
    if (!msg.author?.id || msg.author.id === botUserId) continue;
    const info = upsert(msg.author.id);
    if (msg.author.bot) {
      botParticipantIds.add(msg.author.id);
    }
    addParticipantAlias(info, msg.author.username);
    addParticipantAlias(info, msg.member?.displayName);

    for (const mentioned of msg.mentions.users.values()) {
      if (!mentioned.id || mentioned.id === botUserId) continue;
      const mentionedInfo = upsert(mentioned.id);
      if (mentioned.bot) {
        botParticipantIds.add(mentioned.id);
      }
      addParticipantAlias(mentionedInfo, mentioned.username);
      const mentionedMember = msg.mentions.members?.get(mentioned.id);
      addParticipantAlias(mentionedInfo, mentionedMember?.displayName);
    }

    for (const hint of extractMentionAliasHints(msg.content || '')) {
      if (hint.userId === botUserId) continue;
      const hintedInfo = upsert(hint.userId);
      addParticipantAlias(hintedInfo, hint.alias);
    }
  }

  for (const entry of pendingHistory) {
    if (!entry.userId || entry.userId === botUserId) continue;
    const info = upsert(entry.userId);
    if (entry.isBot) {
      botParticipantIds.add(entry.userId);
    }
    addParticipantAlias(info, entry.username);
    addParticipantAlias(info, entry.displayName);
    for (const hint of extractMentionAliasHints(entry.content)) {
      if (hint.userId === botUserId) continue;
      const hintedInfo = upsert(hint.userId);
      addParticipantAlias(hintedInfo, hint.alias);
    }
  }

  if (rememberedParticipants) {
    for (const [userId, aliases] of rememberedParticipants) {
      if (!userId || userId === botUserId) continue;
      const info = upsert(userId);
      for (const alias of aliases) {
        addParticipantAlias(info, alias);
      }
    }
  }

  if (participants.size === 0) return '';
  const lines = Array.from(participants.values())
    .filter((entry) => entry.aliases.size > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, PARTICIPANT_CONTEXT_MAX_USERS)
    .map((entry) => {
      const aliases = Array.from(entry.aliases).slice(0, 3);
      const preferredHandle = formatDiscordHandleFromAlias(aliases[0]) || `id:${entry.id}`;
      const botSuffix = botParticipantIds.has(entry.id) ? ' [bot]' : '';
      return `- ${preferredHandle}${botSuffix} id:${entry.id} aliases: ${aliases.join(', ')}`;
    });
  if (lines.length === 0) return '';
  return [
    '[Known participants]',
    'Use @handles from this list in normal replies.',
    'Use raw <@id> mention syntax only when the user explicitly asks for mention IDs/tokens.',
    'This list is derived from recent and remembered context; it may be incomplete.',
    ...lines,
    '',
  ].join('\n');
}

interface DiscordErrorLike {
  status?: number;
  httpStatus?: number;
  retryAfter?: number;
  data?: {
    retry_after?: number;
  };
}

/**
 * Format an agent response as plain text.
 * Appends a subtle tools line if any tools were used.
 */
export function buildResponseText(text: string, toolsUsed?: string[]): string {
  let body = text;
  if (toolsUsed && toolsUsed.length > 0) {
    const toolsLine = `\n*Tools: ${toolsUsed.join(', ')}*`;
    body = `${text}${toolsLine}`;
  }
  return body;
}

export function formatInfo(title: string, body: string): string {
  return `**${title}**\n${body}`;
}

export function formatError(title: string, detail: string): string {
  return `**${title}:** ${detail}`;
}

function requireDiscordClientReady(): Client {
  if (!client) {
    throw new Error('Discord client is not initialized.');
  }
  if (!client.isReady()) {
    throw new Error('Discord client is not ready yet.');
  }
  return client;
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
  guildId: string;
  rawUser: string;
}): Promise<{ userId: string; note?: string }> {
  const activeClient = requireDiscordClientReady();
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

async function runDiscordReadAction(request: DiscordToolActionRequest): Promise<Record<string, unknown>> {
  const activeClient = requireDiscordClientReady();
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

async function runDiscordMemberInfoAction(request: DiscordToolActionRequest): Promise<Record<string, unknown>> {
  const activeClient = requireDiscordClientReady();
  const guildId = sanitizeDiscordId(request.guildId, 'guildId');
  const userLookupRaw =
    request.userId
    || request.memberId
    || request.user
    || request.username;
  const resolvedUser = await resolveGuildMemberIdFromLookup({
    guildId,
    rawUser: userLookupRaw || '',
  });
  const userId = sanitizeDiscordId(resolvedUser.userId, 'userId');

  const guild = await activeClient.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  const presence = getDiscordPresence(userId);

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

async function runDiscordChannelInfoAction(request: DiscordToolActionRequest): Promise<Record<string, unknown>> {
  const activeClient = requireDiscordClientReady();
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

export async function runDiscordToolAction(
  request: DiscordToolActionRequest,
): Promise<Record<string, unknown>> {
  switch (request.action) {
    case 'read':
      return await runDiscordReadAction(request);
    case 'member-info':
      return await runDiscordMemberInfoAction(request);
    case 'channel-info':
      return await runDiscordChannelInfoAction(request);
    default:
      throw new Error(`Unsupported Discord action: ${request.action as string}`);
  }
}

function getSessionId(msg: DiscordMessage): string {
  return buildSessionIdFromContext(msg.guild?.id ?? null, msg.channelId, msg.author.id);
}

function stripBotMentions(text: string): string {
  if (!botMentionRegex) return text;
  return text.replace(botMentionRegex, '').trim();
}

function hasPrefixInvocation(content: string): boolean {
  const text = stripBotMentions(content);
  return text.startsWith(DISCORD_PREFIX);
}

function isAuthorizedCommandUserId(userId: string): boolean {
  const configuredUserId = DISCORD_COMMAND_USER_ID.trim();
  if (!configuredUserId) return true;
  return userId === configuredUserId;
}

function buildSessionIdFromContext(guildId: string | null, channelId: string, userId: string): string {
  return guildId ? `${guildId}:${channelId}` : `dm:${userId}`;
}

function isTrigger(msg: DiscordMessage): boolean {
  if (DISCORD_COMMANDS_ONLY) return hasPrefixInvocation(msg.content);
  if (!msg.guild) return true;
  if (DISCORD_RESPOND_TO_ALL_MESSAGES) return true;
  if (client.user && msg.mentions.has(client.user)) return true;
  if (msg.content.startsWith(DISCORD_PREFIX)) return true;
  return false;
}

function parseCommand(content: string): { isCommand: boolean; command: string; args: string[] } {
  let text = stripBotMentions(content);

  if (text.startsWith(DISCORD_PREFIX)) {
    text = text.slice(DISCORD_PREFIX.length).trim();
  }

  const parts = text.split(/\s+/);
  const subcommands = ['bot', 'rag', 'model', 'sessions', 'audit', 'schedule', 'clear', 'help'];

  if (parts.length > 0 && subcommands.includes(parts[0].toLowerCase())) {
    return { isCommand: true, command: parts[0].toLowerCase(), args: parts.slice(1) };
  }

  return { isCommand: false, command: '', args: [] };
}

function isRetryableDiscordError(error: unknown): boolean {
  const maybe = error as DiscordErrorLike;
  const status = maybe.status ?? maybe.httpStatus;
  return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
}

function retryDelayMs(error: unknown, fallbackMs: number): number {
  const maybe = error as DiscordErrorLike;
  const retryAfterSeconds = maybe.retryAfter ?? maybe.data?.retry_after;
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.max(50, Math.ceil(retryAfterSeconds * 1_000));
  }
  return fallbackMs + Math.floor(Math.random() * 250);
}

async function withDiscordRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let delayMs = DISCORD_RETRY_BASE_DELAY_MS;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (attempt >= DISCORD_RETRY_MAX_ATTEMPTS || !isRetryableDiscordError(error)) {
        throw error;
      }
      const waitMs = retryDelayMs(error, delayMs);
      logger.warn({ label, attempt, waitMs, error }, 'Discord API call failed; retrying');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      delayMs = Math.min(delayMs * 2, 4_000);
    }
  }
}

function cleanIncomingContent(content: string): string {
  let text = stripBotMentions(content);
  if (text.startsWith(DISCORD_PREFIX)) {
    text = text.slice(DISCORD_PREFIX.length).trim();
  }
  return text;
}

function summarizeContextMessage(msg: DiscordMessage): string {
  const author = msg.author?.username || 'user';
  const content = (msg.content || '').trim();
  const snippet = content.length > 500 ? `${content.slice(0, 497)}...` : content;
  return `${author}: ${snippet || '(no text)'}`;
}

function buildChannelInfoContext(msg: DiscordMessage): string {
  if (!msg.guild) return '';

  const lines: string[] = [
    '[Channel info]',
    `- guild_id: ${msg.guild.id}`,
    `- channel_id: ${msg.channelId}`,
  ];

  const namedChannel = msg.channel as unknown as { name?: string; topic?: string; parent?: { name?: string | null } | null };
  const channelName = typeof namedChannel.name === 'string' ? namedChannel.name.trim() : '';
  if (channelName) {
    lines.push(`- channel_name: #${channelName}`);
  }
  const channelTopic = typeof namedChannel.topic === 'string' ? namedChannel.topic.trim() : '';
  if (channelTopic) {
    lines.push(`- channel_topic: ${channelTopic}`);
  }
  const parentName = typeof namedChannel.parent?.name === 'string' ? namedChannel.parent.name.trim() : '';
  if (parentName) {
    lines.push(`- parent_channel: ${parentName}`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function looksLikeTextAttachment(name: string, contentType: string): boolean {
  if (contentType.startsWith('text/')) return true;
  if (contentType.includes('json') || contentType.includes('xml') || contentType.includes('yaml')) return true;
  return /\.(txt|md|markdown|json|ya?ml|js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|html?|css|scss|sql|log|csv)$/i.test(name);
}

async function fetchAttachmentText(url: string, maxChars: number): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(1_000, maxChars - 32))}\n...[truncated]`;
  } catch {
    return null;
  }
}

async function buildReplyContext(msg: DiscordMessage): Promise<string> {
  const blocks: string[] = [];

  if ('isThread' in msg.channel && typeof msg.channel.isThread === 'function' && msg.channel.isThread()) {
    try {
      const starter = await msg.channel.fetchStarterMessage();
      if (starter) {
        blocks.push(`[Thread starter]\n${summarizeContextMessage(starter)}`);
      }
    } catch (error) {
      logger.debug({ error, channelId: msg.channelId }, 'Failed to fetch thread starter message');
    }
  }

  const replyLines: string[] = [];
  let replyId = msg.reference?.messageId || null;
  let depth = 0;
  while (replyId && depth < 5) {
    try {
      const referenced = await msg.channel.messages.fetch(replyId);
      replyLines.push(summarizeContextMessage(referenced));
      replyId = referenced.reference?.messageId || null;
      depth += 1;
    } catch {
      break;
    }
  }
  if (replyLines.length > 0) {
    blocks.push(`[Reply context]\n${replyLines.reverse().join('\n')}`);
  }

  if (blocks.length === 0) return '';
  return `${blocks.join('\n\n')}\n\n`;
}

async function buildAttachmentContext(messages: DiscordMessage[]): Promise<string> {
  const lines: string[] = [];
  let remainingChars = MAX_ATTACHMENT_CONTEXT_CHARS;

  for (const msg of messages) {
    if (!msg.attachments || msg.attachments.size === 0) continue;
    for (const attachment of msg.attachments.values()) {
      const name = attachment.name || 'unnamed';
      const size = attachment.size || 0;
      const contentType = (attachment.contentType || '').toLowerCase();
      if (size > MAX_ATTACHMENT_BYTES) {
        lines.push(`- ${name}: skipped (size ${size} bytes exceeds 10MB limit)`);
        continue;
      }

      if (contentType.startsWith('image/')) {
        lines.push(`- ${name}: image attachment (${size} bytes, ${contentType || 'unknown type'})`);
        continue;
      }

      if (looksLikeTextAttachment(name, contentType)) {
        const maxChars = Math.min(MAX_SINGLE_ATTACHMENT_CHARS, Math.max(500, remainingChars));
        const text = await fetchAttachmentText(attachment.url, maxChars);
        if (!text) {
          lines.push(`- ${name}: text attachment (failed to read content)`);
          continue;
        }

        const block = `- ${name} (text attachment):\n\`\`\`\n${text}\n\`\`\``;
        remainingChars -= block.length;
        lines.push(block);
        if (remainingChars <= 0) {
          lines.push('- Additional attachment content omitted (context budget reached).');
          return `[Attachments]\n${lines.join('\n')}\n\n`;
        }
        continue;
      }

      lines.push(`- ${name}: attachment (${size} bytes, ${contentType || 'unknown type'})`);
    }
  }

  if (lines.length === 0) return '';
  return `[Attachments]\n${lines.join('\n')}\n\n`;
}

async function addProcessingReaction(msg: DiscordMessage): Promise<() => Promise<void>> {
  if (!client.user) return async () => {};
  const botUserId = client.user.id;
  try {
    await withDiscordRetry('react', () => msg.react('👀'));
  } catch (error) {
    logger.debug({ error, channelId: msg.channelId, messageId: msg.id }, 'Failed to add processing reaction');
    return async () => {};
  }

  return async () => {
    try {
      const reaction = msg.reactions.resolve('👀');
      if (!reaction) return;
      await withDiscordRetry('reaction-remove', () => reaction.users.remove(botUserId));
    } catch (error) {
      logger.debug({ error, channelId: msg.channelId, messageId: msg.id }, 'Failed to remove processing reaction');
    }
  };
}

function startTypingLoop(msg: DiscordMessage): { stop: () => void } {
  let stopped = false;
  const sendTyping = async (): Promise<void> => {
    if (stopped) return;
    if (!('sendTyping' in msg.channel)) return;
    try {
      await msg.channel.sendTyping();
    } catch (error) {
      logger.debug({ error, channelId: msg.channelId }, 'Failed to send typing indicator');
    }
  };

  void sendTyping();
  const timer = setInterval(() => {
    void sendTyping();
  }, 8_000);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

function prepareChunkedPayloads(
  text: string,
  files?: AttachmentBuilder[],
  mentionLookup?: MentionLookup,
): { content: string; files?: AttachmentBuilder[] }[] {
  const prepared = mentionLookup ? rewriteUserMentions(text, mentionLookup) : text;
  const chunks = chunkMessage(prepared, { maxChars: 1_900, maxLines: 20 });
  const safeChunks = chunks.length > 0 ? chunks : ['(no content)'];
  return safeChunks.map((content, i) => ({
    content,
    ...(i === safeChunks.length - 1 && files && files.length > 0 ? { files } : {}),
  }));
}

async function sendChunkedReply(
  msg: DiscordMessage,
  text: string,
  files?: AttachmentBuilder[],
  mentionLookup?: MentionLookup,
): Promise<void> {
  const payloads = prepareChunkedPayloads(text, files, mentionLookup);
  for (let i = 0; i < payloads.length; i += 1) {
    if (i === 0) {
      await withDiscordRetry('reply', () => msg.reply(payloads[i]));
    } else {
      await withDiscordRetry('send', () => (msg.channel as unknown as {
        send: (next: { content: string; files?: AttachmentBuilder[] }) => Promise<void>;
      }).send(payloads[i]));
    }
  }
}

async function sendChunkedDirectReply(
  msg: DiscordMessage,
  text: string,
  files?: AttachmentBuilder[],
  mentionLookup?: MentionLookup,
): Promise<void> {
  const payloads = prepareChunkedPayloads(text, files, mentionLookup);
  const dm = await withDiscordRetry('dm-open', () => msg.author.createDM());
  for (const payload of payloads) {
    await withDiscordRetry('dm-send', () => dm.send(payload));
  }
}

async function sendChunkedInteractionReply(
  interaction: ChatInputCommandInteraction,
  text: string,
  files?: AttachmentBuilder[],
): Promise<void> {
  const payloads = prepareChunkedPayloads(text, files);
  for (let i = 0; i < payloads.length; i += 1) {
    const payload = { ...payloads[i], ephemeral: true };
    if (i === 0) {
      if (interaction.replied || interaction.deferred) {
        await withDiscordRetry('interaction-followup', () => interaction.followUp(payload));
      } else {
        await withDiscordRetry('interaction-reply', () => interaction.reply(payload));
      }
      continue;
    }
    await withDiscordRetry('interaction-followup', () => interaction.followUp(payload));
  }
}

async function ensureSlashStatusCommand(): Promise<void> {
  const definition = {
    name: 'status',
    description: 'Show HybridClaw runtime status (only visible to you)',
  };

  if (!client.application) return;
  await Promise.allSettled(
    [...client.guilds.cache.values()].map(async (guild) => {
      try {
        const existing = await guild.commands.fetch();
        const current = existing.find((command) => command.name === definition.name);
        if (!current) {
          await guild.commands.create(definition);
          logger.info({ guildId: guild.id }, 'Registered slash command /status');
          return;
        }
        if (current.description !== definition.description) {
          await guild.commands.edit(current.id, definition);
          logger.info({ guildId: guild.id }, 'Updated slash command /status');
        }
      } catch (error) {
        logger.warn({ error, guildId: guild.id }, 'Failed to register slash command /status');
      }
    }),
  );
}

function updatePresence(): void {
  if (!client.user) return;
  if (activeConversationRuns > 0) {
    client.user.setPresence({
      activities: [{ name: 'Thinking...', type: ActivityType.Playing }],
      status: 'online',
    });
    return;
  }
  client.user.setPresence({
    activities: [{ name: `in ${client.guilds.cache.size} servers`, type: ActivityType.Listening }],
    status: 'online',
  });
}

export function initDiscord(onMessage: MessageHandler, onCommand: CommandHandler): Client {
  messageHandler = onMessage;
  commandHandler = onCommand;

  interface QueuedConversationMessage {
    msg: DiscordMessage;
    content: string;
    clearReaction: () => Promise<void>;
  }
  interface PendingConversationBatch {
    items: QueuedConversationMessage[];
    timer: ReturnType<typeof setTimeout>;
  }
  interface InFlightConversation {
    abortController: AbortController;
    stream: DiscordStreamManager;
    messageIds: Set<string>;
    aborted: boolean;
  }
  const pendingBatches = new Map<string, PendingConversationBatch>();
  const inFlightByMessageId = new Map<string, InFlightConversation>();
  const negativeFeedbackByChannel = new Map<string, string>();
  const participantMemoryByChannel = new Map<string, Map<string, Set<string>>>();

  const touchParticipantMemoryChannel = (channelId: string): Map<string, Set<string>> => {
    const existing = participantMemoryByChannel.get(channelId);
    if (existing) {
      participantMemoryByChannel.delete(channelId);
      participantMemoryByChannel.set(channelId, existing);
      return existing;
    }
    const created = new Map<string, Set<string>>();
    participantMemoryByChannel.set(channelId, created);
    while (participantMemoryByChannel.size > PARTICIPANT_MEMORY_MAX_CHANNELS) {
      const oldestKey = participantMemoryByChannel.keys().next().value;
      if (!oldestKey) break;
      participantMemoryByChannel.delete(oldestKey);
    }
    return created;
  };

  const rememberParticipantAliasForChannel = (channelId: string, userId: string, rawAlias: string | null | undefined): void => {
    if (!userId || userId === client.user?.id) return;
    const alias = normalizeMentionAlias(rawAlias);
    if (!alias) return;
    const channelMemory = touchParticipantMemoryChannel(channelId);
    let aliases = channelMemory.get(userId);
    if (!aliases) {
      aliases = new Set<string>();
      channelMemory.set(userId, aliases);
      while (channelMemory.size > PARTICIPANT_MEMORY_MAX_USERS_PER_CHANNEL) {
        const oldestUserId = channelMemory.keys().next().value;
        if (!oldestUserId) break;
        channelMemory.delete(oldestUserId);
      }
    }
    aliases.add(alias);
    if (aliases.size > PARTICIPANT_MEMORY_MAX_ALIASES_PER_USER) {
      const kept = new Set(Array.from(aliases).slice(-PARTICIPANT_MEMORY_MAX_ALIASES_PER_USER));
      channelMemory.set(userId, kept);
    }
    // Refresh user recency.
    const refreshed = channelMemory.get(userId);
    if (refreshed) {
      channelMemory.delete(userId);
      channelMemory.set(userId, refreshed);
    }
  };

  const rememberParticipantForChannel = (channelId: string, userId: string, aliases: Array<string | null | undefined>): void => {
    if (!userId || userId === client.user?.id) return;
    for (const alias of aliases) {
      rememberParticipantAliasForChannel(channelId, userId, alias);
    }
  };

  const observeMessageParticipants = (msg: DiscordMessage, content: string): void => {
    if (!msg.guild) return;
    rememberParticipantForChannel(msg.channelId, msg.author.id, [
      msg.author.username,
      msg.member?.displayName,
    ]);
    for (const mentioned of msg.mentions.users.values()) {
      const mentionedMember = msg.mentions.members?.get(mentioned.id);
      rememberParticipantForChannel(msg.channelId, mentioned.id, [
        mentioned.username,
        mentionedMember?.displayName,
      ]);
    }
    for (const hint of extractMentionAliasHints(content)) {
      rememberParticipantAliasForChannel(msg.channelId, hint.userId, hint.alias);
    }
  };

  const intents: GatewayIntentBits[] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ];
  if (DISCORD_GUILD_MEMBERS_INTENT) intents.push(GatewayIntentBits.GuildMembers);
  if (DISCORD_PRESENCE_INTENT) intents.push(GatewayIntentBits.GuildPresences);

  client = new Client({
    intents,
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });

  client.on('presenceUpdate', (_oldPresence, nextPresence) => {
    const userId = nextPresence.userId || nextPresence.user?.id;
    if (!userId) return;
    setDiscordPresence(userId, {
      status: nextPresence.status,
      activities: nextPresence.activities.map((activity) => ({
        type: activity.type,
        name: activity.name,
        state: activity.state || null,
        details: activity.details || null,
      })),
    });
  });

  client.on('clientReady', () => {
    logger.info({ user: client.user?.tag }, 'Discord bot connected');
    if (client.user) {
      botMentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    }
    updatePresence();
    void ensureSlashStatusCommand();
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'status') return;

    if (!isAuthorizedCommandUserId(interaction.user.id)) {
      await sendChunkedInteractionReply(
        interaction,
        'You are not authorized to run commands for this bot.',
      );
      return;
    }

    const guildId = interaction.guildId ?? null;
    const channelId = interaction.channelId;
    const sessionId = buildSessionIdFromContext(guildId, channelId, interaction.user.id);
    try {
      await commandHandler(
        sessionId,
        guildId,
        channelId,
        ['status'],
        async (text, files) => sendChunkedInteractionReply(interaction, text, files),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(
        { error, guildId, channelId, userId: interaction.user.id },
        'Discord slash /status command failed',
      );
      await sendChunkedInteractionReply(interaction, formatError('Gateway Error', detail));
    }
  });

  const dispatchConversationBatch = async (batchKey: string): Promise<void> => {
    const pending = pendingBatches.get(batchKey);
    if (!pending) return;
    pendingBatches.delete(batchKey);
    const items = pending.items;
    if (items.length === 0) return;

    const sourceItem = items[items.length - 1];
    const msg = sourceItem.msg;
    const sessionId = getSessionId(msg);
    const guildId = msg.guild?.id || null;
    const channelId = msg.channelId;
    const userId = msg.author.id;
    const username = msg.author.username;

    const batchedContent = items.length > 1
      ? items.map((item, index) => `Message ${index + 1}:\n${item.content}`).join('\n\n')
      : sourceItem.content;
    const channelInfoContext = buildChannelInfoContext(msg);
    const replyContext = await buildReplyContext(msg);
    const feedbackNote = negativeFeedbackByChannel.get(channelId) || '';
    if (feedbackNote) {
      negativeFeedbackByChannel.delete(channelId);
    }
    const currentBatchMessageIds = new Set(items.map((item) => item.msg.id));
    const inboundHistory = await buildInboundHistorySnapshot(msg, currentBatchMessageIds);
    const attachmentContext = await buildAttachmentContext(items.map((item) => item.msg));
    const rememberedParticipants = participantMemoryByChannel.get(msg.channelId);
    const participantContext = buildParticipantContext(
      items.map((item) => item.msg),
      inboundHistory.entries,
      rememberedParticipants,
    );
    const mentionLookup = buildMentionLookup(
      items.map((item) => item.msg),
      inboundHistory.entries,
      rememberedParticipants,
    );
    const combinedContent = `${feedbackNote ? `[Reaction feedback]\n${feedbackNote}\n\n` : ''}${channelInfoContext}${replyContext}${inboundHistory.context}${attachmentContext}${participantContext}${batchedContent}`;

    const abortController = new AbortController();
    const typingLoop = startTypingLoop(msg);
    const stream = new DiscordStreamManager(msg, {
      onFirstMessage: () => typingLoop.stop(),
    });
    const inFlight: InFlightConversation = {
      abortController,
      stream,
      messageIds: new Set(items.map((item) => item.msg.id)),
      aborted: false,
    };
    for (const messageId of inFlight.messageIds) {
      inFlightByMessageId.set(messageId, inFlight);
    }

    try {
      activeConversationRuns += 1;
      updatePresence();
      await messageHandler(
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        combinedContent,
        async (text, files) => {
          typingLoop.stop();
          await sendChunkedReply(msg, text, files, mentionLookup);
        },
        {
          sourceMessage: msg,
          batchedMessages: items.map((item) => item.msg),
          abortSignal: abortController.signal,
          stream,
          mentionLookup,
        },
      );
    } catch (error) {
      logger.error({ error, channelId, sessionId }, 'Conversation batch handling failed');
      const detail = error instanceof Error ? error.message : String(error);
      if (stream.hasSentMessages()) {
        await stream.fail(formatError('Gateway Error', detail));
      } else {
        await sendChunkedReply(msg, formatError('Gateway Error', detail), undefined, mentionLookup);
      }
    } finally {
      activeConversationRuns = Math.max(0, activeConversationRuns - 1);
      updatePresence();
      for (const messageId of inFlight.messageIds) {
        if (inFlightByMessageId.get(messageId) === inFlight) {
          inFlightByMessageId.delete(messageId);
        }
      }
      typingLoop.stop();
      await Promise.all(items.map(async (item) => {
        await item.clearReaction();
      }));
    }
  };

  const queueConversationMessage = async (
    msg: DiscordMessage,
    content: string,
  ): Promise<void> => {
    const key = `${msg.channelId}:${msg.author.id}`;
    const clearReaction = await addProcessingReaction(msg);
    const queued: QueuedConversationMessage = { msg, content, clearReaction };
    const existing = pendingBatches.get(key);

    if (!existing) {
      const timer = setTimeout(() => {
        void dispatchConversationBatch(key);
      }, MESSAGE_DEBOUNCE_MS);
      pendingBatches.set(key, {
        items: [queued],
        timer,
      });
      return;
    }

    clearTimeout(existing.timer);
    existing.items.push(queued);
    existing.timer = setTimeout(() => {
      void dispatchConversationBatch(key);
    }, MESSAGE_DEBOUNCE_MS);
  };

  const dropPendingMessage = async (messageId: string): Promise<void> => {
    for (const [key, pending] of pendingBatches) {
      const index = pending.items.findIndex((item) => item.msg.id === messageId);
      if (index === -1) continue;
      const [removed] = pending.items.splice(index, 1);
      await removed.clearReaction();
      if (pending.items.length === 0) {
        clearTimeout(pending.timer);
        pendingBatches.delete(key);
      }
      return;
    }
  };

  const updatePendingMessage = async (
    messageId: string,
    nextMsg: DiscordMessage,
    nextContent: string,
  ): Promise<boolean> => {
    for (const [key, pending] of pendingBatches) {
      const index = pending.items.findIndex((item) => item.msg.id === messageId);
      if (index === -1) continue;

      if (!nextContent) {
        const [removed] = pending.items.splice(index, 1);
        await removed.clearReaction();
      } else {
        pending.items[index].msg = nextMsg;
        pending.items[index].content = nextContent;
      }

      if (pending.items.length === 0) {
        clearTimeout(pending.timer);
        pendingBatches.delete(key);
      }
      return true;
    }
    return false;
  };

  client.on('messageCreate', async (msg: DiscordMessage) => {
    if (msg.author.bot) return;

    const sessionId = getSessionId(msg);
    const guildId = msg.guild?.id || null;
    const channelId = msg.channelId;
    const content = cleanIncomingContent(msg.content);
    observeMessageParticipants(msg, content);
    const immediateMentionLookup = buildMentionLookup(
      [msg],
      [],
      msg.guild ? participantMemoryByChannel.get(msg.channelId) : undefined,
    );

    const reply: ReplyFn = async (text, files) => {
      await sendChunkedReply(msg, text, files, immediateMentionLookup);
    };
    const commandReply: ReplyFn = async (text, files) => {
      try {
        await sendChunkedDirectReply(msg, text, files, immediateMentionLookup);
      } catch (error) {
        logger.warn(
          { error, userId: msg.author.id, channelId: msg.channelId },
          'Failed to send command reply via DM; command response dropped',
        );
      }
    };

    const parsed = parseCommand(msg.content);
    const prefixedToken = hasPrefixInvocation(msg.content)
      ? cleanIncomingContent(msg.content).split(/\s+/)[0]?.toLowerCase() || ''
      : '';
    const ignorePrefixCommand = prefixedToken === 'status';
    if (DISCORD_COMMANDS_ONLY) {
      if (!hasPrefixInvocation(msg.content)) return;
      if (!isAuthorizedCommandUserId(msg.author.id)) {
        logger.debug(
          { userId: msg.author.id, channelId: msg.channelId },
          'Ignoring unauthorized Discord command in commands-only mode',
        );
        return;
      }
      if (ignorePrefixCommand) {
        return;
      }
      if (!parsed.isCommand) {
        if (!content) {
          await commandReply(`How can I help? Try \`${DISCORD_PREFIX} help\`.`);
        } else {
          await commandReply(`Unknown command. Try \`${DISCORD_PREFIX} help\`.`);
        }
        return;
      }
      await commandHandler(sessionId, guildId, channelId, [parsed.command, ...parsed.args], commandReply);
      return;
    }

    if (!isTrigger(msg)) return;

    if (ignorePrefixCommand) {
      return;
    }

    if (parsed.isCommand && hasPrefixInvocation(msg.content)) {
      if (!isAuthorizedCommandUserId(msg.author.id)) {
        logger.debug(
          { userId: msg.author.id, channelId: msg.channelId },
          'Ignoring unauthorized Discord command; processing as normal chat message',
        );
      } else {
        await commandHandler(sessionId, guildId, channelId, [parsed.command, ...parsed.args], commandReply);
        return;
      }
    }

    if (!content) {
      await reply('How can I help? Send me a message or try `!claw help`.');
      return;
    }

    await queueConversationMessage(msg, content);
  });

  client.on('messageUpdate', async (_oldMsg, nextMsg) => {
    if (DISCORD_COMMANDS_ONLY) return;
    const fetched = nextMsg.partial
      ? await nextMsg.fetch().catch(() => null)
      : nextMsg;
    if (!fetched) return;
    if (fetched.author?.bot) return;

    const updatedContent = cleanIncomingContent(fetched.content || '');
    observeMessageParticipants(fetched, updatedContent);
    if (!isTrigger(fetched)) return;
    await updatePendingMessage(fetched.id, fetched, updatedContent);

    const inFlight = inFlightByMessageId.get(fetched.id);
    if (!inFlight || inFlight.aborted) return;
    inFlight.aborted = true;
    inFlight.abortController.abort();
    for (const messageId of inFlight.messageIds) {
      if (inFlightByMessageId.get(messageId) === inFlight) {
        inFlightByMessageId.delete(messageId);
      }
    }
    await inFlight.stream.discard();
    if (updatedContent) {
      await queueConversationMessage(fetched, updatedContent);
    }
  });

  client.on('messageDelete', async (msg) => {
    await dropPendingMessage(msg.id);
    const inFlight = inFlightByMessageId.get(msg.id);
    if (!inFlight || inFlight.aborted) return;
    inFlight.aborted = true;
    inFlight.abortController.abort();
    for (const messageId of inFlight.messageIds) {
      if (inFlightByMessageId.get(messageId) === inFlight) {
        inFlightByMessageId.delete(messageId);
      }
    }
    await inFlight.stream.discard();
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    const fullReaction = reaction.partial
      ? await reaction.fetch().catch(() => null)
      : reaction;
    if (!fullReaction) return;
    if (fullReaction.emoji.name !== '👎') return;

    const message = fullReaction.message.partial
      ? await fullReaction.message.fetch().catch(() => null)
      : fullReaction.message;
    if (!message) return;
    if (!client.user || message.author?.id !== client.user.id) return;

    negativeFeedbackByChannel.set(
      message.channelId,
      `${user.username} reacted with 👎 to assistant message ${message.id}.`,
    );
  });

  if (!DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN is required to start the Discord bot');
  }
  client.login(DISCORD_TOKEN);
  return client;
}

/**
 * Send a message to a channel by ID (used by scheduler).
 */
export async function sendToChannel(channelId: string, text: string, files?: AttachmentBuilder[]): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (channel && 'send' in channel) {
    const chunks = chunkMessage(text, { maxChars: 1_900, maxLines: 20 });
    const safeChunks = chunks.length > 0 ? chunks : ['(no content)'];
    const send = (channel as unknown as {
      send: (payload: { content: string; files?: AttachmentBuilder[] }) => Promise<void>;
    }).send;
    for (let i = 0; i < safeChunks.length; i += 1) {
      await withDiscordRetry('send-channel', () => send({
        content: safeChunks[i],
        ...(i === safeChunks.length - 1 && files && files.length > 0 ? { files } : {}),
      }));
    }
  }
}
