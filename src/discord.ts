import {
  ActivityType,
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
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
const MESSAGE_DEBOUNCE_MS = 2_500;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_CONTEXT_CHARS = 16_000;
const MAX_SINGLE_ATTACHMENT_CHARS = 8_000;
const DISCORD_RETRY_MAX_ATTEMPTS = 3;
const DISCORD_RETRY_BASE_DELAY_MS = 500;
const GUILD_PENDING_HISTORY_LIMIT = 30;
const GUILD_PENDING_HISTORY_MAX_CHARS = 6_000;
const PARTICIPANT_CONTEXT_MAX_USERS = 30;
const PARTICIPANT_MEMORY_MAX_CHANNELS = 200;
const PARTICIPANT_MEMORY_MAX_USERS_PER_CHANNEL = 200;
const PARTICIPANT_MEMORY_MAX_ALIASES_PER_USER = 8;
const MENTION_ALIAS_LOOKUP_MAX = 8;
const PRESENCE_SNAPSHOT_MAX_USERS = 25;
const PRESENCE_SNAPSHOT_FETCH_LIMIT = 50;

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
  const content = entry.content.trim();
  const snippet = content.length > 300 ? `${content.slice(0, 297)}...` : content;
  return `${author}: ${snippet}`;
}

function buildPendingHistoryContext(entries: PendingGuildHistoryEntry[]): string {
  if (entries.length === 0) return '';
  const selected: string[] = [];
  let totalChars = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const line = summarizePendingHistoryEntry(entries[i]);
    if (!line) continue;
    if (totalChars + line.length > GUILD_PENDING_HISTORY_MAX_CHARS && selected.length > 0) break;
    selected.push(line);
    totalChars += line.length + 1;
  }
  if (selected.length === 0) return '';
  selected.reverse();
  return `[Channel context since last trigger]\n${selected.join('\n')}\n\n`;
}

function addParticipantAlias(info: ParticipantInfo, alias: string | null | undefined): void {
  const normalized = normalizeMentionAlias(alias);
  if (!normalized) return;
  info.aliases.add(normalized);
}

function buildParticipantContext(
  messages: DiscordMessage[],
  pendingHistory: PendingGuildHistoryEntry[],
  rememberedParticipants?: Map<string, Set<string>>,
): string {
  const participants = new Map<string, ParticipantInfo>();
  const botUserId = client.user?.id || '';

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
    addParticipantAlias(info, msg.author.username);
    addParticipantAlias(info, msg.member?.displayName);

    for (const mentioned of msg.mentions.users.values()) {
      if (!mentioned.id || mentioned.id === botUserId) continue;
      const mentionedInfo = upsert(mentioned.id);
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
    .map((entry) => `- <@${entry.id}> aliases: ${Array.from(entry.aliases).slice(0, 3).join(', ')}`);
  if (lines.length === 0) return '';
  return [
    '[Known participants]',
    'If you need to mention someone, prefer exact Discord mention IDs from this list.',
    'This list is derived from recent and remembered context; it may be incomplete.',
    ...lines,
    '',
  ].join('\n');
}

function shouldIncludePresenceContext(text: string): boolean {
  if (!text.trim()) return false;
  return /\b(online|offline|presence|anwesend|voice[-\s]?state|vc)\b|wer\s+ist\s+(hier|da|online)|who\s+is\s+(here|online)|who'?s\s+(here|online)|who\s+is\s+in\s+(this\s+)?(channel|server)|im\s+(channel|kanal).*(online|anwesend)|siehst\s+du|can\s+you\s+see|do\s+you\s+see|is\s+.+\s+online|ist\s+.+\s+online/iu.test(text);
}

function formatPresenceStatus(status: string): string {
  if (status === 'dnd') return 'do-not-disturb';
  return status;
}

function canMemberViewChannel(msg: DiscordMessage, member: GuildMember): boolean {
  if (!('permissionsFor' in msg.channel)) return true;
  try {
    const permissions = msg.channel.permissionsFor(member);
    return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel));
  } catch {
    return false;
  }
}

async function buildPresenceContext(msg: DiscordMessage, triggerContent: string): Promise<string> {
  if (!msg.guild) return '';
  if (!shouldIncludePresenceContext(triggerContent)) return '';

  if (!DISCORD_GUILD_MEMBERS_INTENT || !DISCORD_PRESENCE_INTENT) {
    return [
      '[Discord presence lookup]',
      'Presence data is unavailable for this run because privileged intents are disabled.',
      `Current flags: guildMembersIntent=${DISCORD_GUILD_MEMBERS_INTENT}, presenceIntent=${DISCORD_PRESENCE_INTENT}.`,
      'To answer online-status questions, enable both flags in config.json and enable both intents in the Discord Developer Portal.',
      '',
    ].join('\n');
  }

  try {
    const presences = Array.from(msg.guild.presences.cache.values())
      .filter((presence) => presence.status && presence.status !== 'offline' && presence.status !== 'invisible');

    const members: Array<{ id: string; label: string; status: string }> = [];
    let fetchBudget = PRESENCE_SNAPSHOT_FETCH_LIMIT;
    for (const presence of presences) {
      if (members.length >= PRESENCE_SNAPSHOT_MAX_USERS) break;

      let member = msg.guild.members.cache.get(presence.userId) || null;
      if (!member && fetchBudget > 0) {
        fetchBudget -= 1;
        member = await msg.guild.members.fetch(presence.userId).catch(() => null);
      }
      if (!member) continue;
      if (!canMemberViewChannel(msg, member)) continue;

      const label = member.displayName || member.user.username || 'user';
      members.push({
        id: member.id,
        label,
        status: formatPresenceStatus(presence.status),
      });
    }

    if (members.length === 0) {
      return [
        '[Discord presence snapshot]',
        `Captured at: ${new Date().toISOString()}`,
        'No online/idle/dnd members with access to this channel were resolved.',
        'If asked about a specific person, treat them as not visible online in this snapshot (offline/invisible/not cached).',
        '',
      ].join('\n');
    }

    members.sort((a, b) => a.label.localeCompare(b.label));
    return [
      '[Discord presence snapshot]',
      `Captured at: ${new Date().toISOString()}`,
      'Guild-level presence filtered to users who can view this channel.',
      'This snapshot is authoritative for this response. Do not claim missing Discord access when this section exists.',
      'If asked about a specific person not listed, treat them as not visible online in this snapshot (offline/invisible/not cached).',
      ...members.map((entry) => `- <@${entry.id}> (${entry.label}) status=${entry.status}`),
      '',
    ].join('\n');
  } catch (error) {
    logger.debug({ error, guildId: msg.guild.id, channelId: msg.channelId }, 'Failed to build Discord presence context');
    return [
      '[Discord presence snapshot]',
      'Presence lookup failed in this run. If asked, explain that presence data could not be resolved.',
      '',
    ].join('\n');
  }
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

function getSessionId(msg: DiscordMessage): string {
  return msg.guild ? `${msg.guild.id}:${msg.channelId}` : `dm:${msg.author.id}`;
}

function hasPrefixInvocation(content: string): boolean {
  let text = content;
  if (client.user) {
    text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  }
  return text.startsWith(DISCORD_PREFIX);
}

function isAuthorizedCommandUser(msg: DiscordMessage): boolean {
  const configuredUserId = DISCORD_COMMAND_USER_ID.trim();
  if (!configuredUserId) return true;
  return msg.author.id === configuredUserId;
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
  let text = content;

  if (client.user) {
    text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  }

  if (text.startsWith(DISCORD_PREFIX)) {
    text = text.slice(DISCORD_PREFIX.length).trim();
  }

  const parts = text.split(/\s+/);
  const subcommands = ['bot', 'rag', 'model', 'status', 'sessions', 'audit', 'schedule', 'clear', 'help'];

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
  let text = content;
  if (client.user) {
    text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  }
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

async function sendChunkedReply(
  msg: DiscordMessage,
  text: string,
  files?: AttachmentBuilder[],
  mentionLookup?: MentionLookup,
): Promise<void> {
  const prepared = mentionLookup ? rewriteUserMentions(text, mentionLookup) : text;
  const chunks = chunkMessage(prepared, { maxChars: 1_900, maxLines: 20 });
  const safeChunks = chunks.length > 0 ? chunks : ['(no content)'];

  for (let i = 0; i < safeChunks.length; i += 1) {
    const payload: { content: string; files?: AttachmentBuilder[] } = {
      content: safeChunks[i],
      ...(i === safeChunks.length - 1 && files && files.length > 0 ? { files } : {}),
    };
    if (i === 0) {
      await withDiscordRetry('reply', () => msg.reply(payload));
    } else {
      await withDiscordRetry('send', () => (msg.channel as unknown as {
        send: (next: { content: string; files?: AttachmentBuilder[] }) => Promise<void>;
      }).send(payload));
    }
  }
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
    pendingHistory: PendingGuildHistoryEntry[];
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
  const pendingGuildHistoryByChannel = new Map<string, PendingGuildHistoryEntry[]>();
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

  const rememberPendingGuildHistory = (msg: DiscordMessage, content: string): void => {
    if (!msg.guild || !content.trim()) return;
    const next: PendingGuildHistoryEntry = {
      messageId: msg.id,
      userId: msg.author.id,
      username: msg.author.username || 'user',
      displayName: msg.member?.displayName || null,
      content: content.trim(),
    };
    const existing = pendingGuildHistoryByChannel.get(msg.channelId) || [];
    existing.push(next);
    while (existing.length > GUILD_PENDING_HISTORY_LIMIT) {
      existing.shift();
    }
    pendingGuildHistoryByChannel.set(msg.channelId, existing);
  };

  const consumePendingGuildHistory = (channelId: string): PendingGuildHistoryEntry[] => {
    const entries = pendingGuildHistoryByChannel.get(channelId) || [];
    pendingGuildHistoryByChannel.delete(channelId);
    return entries;
  };

  const updatePendingGuildHistory = (msg: DiscordMessage, content: string): void => {
    if (!msg.guild) return;
    const existing = pendingGuildHistoryByChannel.get(msg.channelId);
    if (!existing || existing.length === 0) return;
    const index = existing.findIndex((entry) => entry.messageId === msg.id);
    if (index === -1) return;
    const nextContent = content.trim();
    if (!nextContent) {
      existing.splice(index, 1);
    } else {
      existing[index] = {
        ...existing[index],
        username: msg.author.username || existing[index].username,
        displayName: msg.member?.displayName || existing[index].displayName,
        content: nextContent,
      };
    }
    if (existing.length === 0) {
      pendingGuildHistoryByChannel.delete(msg.channelId);
      return;
    }
    pendingGuildHistoryByChannel.set(msg.channelId, existing);
  };

  const removePendingGuildHistoryByMessageId = (messageId: string): void => {
    for (const [channelId, entries] of pendingGuildHistoryByChannel) {
      const next = entries.filter((entry) => entry.messageId !== messageId);
      if (next.length === entries.length) continue;
      if (next.length === 0) {
        pendingGuildHistoryByChannel.delete(channelId);
      } else {
        pendingGuildHistoryByChannel.set(channelId, next);
      }
      return;
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

  client.on('clientReady', () => {
    logger.info({ user: client.user?.tag }, 'Discord bot connected');
    updatePresence();
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
    const replyContext = await buildReplyContext(msg);
    const feedbackNote = negativeFeedbackByChannel.get(channelId) || '';
    if (feedbackNote) {
      negativeFeedbackByChannel.delete(channelId);
    }
    const pendingHistory = items.flatMap((item) => item.pendingHistory);
    const pendingHistoryContext = buildPendingHistoryContext(pendingHistory);
    const attachmentContext = await buildAttachmentContext(items.map((item) => item.msg));
    const rememberedParticipants = participantMemoryByChannel.get(msg.channelId);
    const participantContext = buildParticipantContext(
      items.map((item) => item.msg),
      pendingHistory,
      rememberedParticipants,
    );
    const presenceContext = await buildPresenceContext(msg, batchedContent);
    const mentionLookup = buildMentionLookup(
      items.map((item) => item.msg),
      pendingHistory,
      rememberedParticipants,
    );
    const combinedContent = `${feedbackNote ? `[Reaction feedback]\n${feedbackNote}\n\n` : ''}${replyContext}${pendingHistoryContext}${attachmentContext}${participantContext}${presenceContext}${batchedContent}`;

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
    pendingHistory: PendingGuildHistoryEntry[] = [],
  ): Promise<void> => {
    const key = `${msg.channelId}:${msg.author.id}`;
    const clearReaction = await addProcessingReaction(msg);
    const queued: QueuedConversationMessage = { msg, content, clearReaction, pendingHistory };
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
    if (pendingHistory.length > 0 && existing.items.length > 0) {
      existing.items[0].pendingHistory.push(...pendingHistory);
    }
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

    const parsed = parseCommand(msg.content);
    if (DISCORD_COMMANDS_ONLY) {
      if (!hasPrefixInvocation(msg.content)) return;
      if (!isAuthorizedCommandUser(msg)) {
        logger.debug(
          { userId: msg.author.id, channelId: msg.channelId },
          'Ignoring unauthorized Discord command in commands-only mode',
        );
        return;
      }
      if (!parsed.isCommand) {
        if (!content) {
          await reply(`How can I help? Try \`${DISCORD_PREFIX} help\`.`);
        } else {
          await reply(`Unknown command. Try \`${DISCORD_PREFIX} help\`.`);
        }
        return;
      }
      await commandHandler(sessionId, guildId, channelId, [parsed.command, ...parsed.args], reply);
      return;
    }

    if (!isTrigger(msg)) {
      rememberPendingGuildHistory(msg, content);
      return;
    }

    if (parsed.isCommand && hasPrefixInvocation(msg.content)) {
      if (!isAuthorizedCommandUser(msg)) {
        logger.debug(
          { userId: msg.author.id, channelId: msg.channelId },
          'Ignoring unauthorized Discord command; processing as normal chat message',
        );
      } else {
        await commandHandler(sessionId, guildId, channelId, [parsed.command, ...parsed.args], reply);
        return;
      }
    }

    if (!content) {
      await reply('How can I help? Send me a message or try `!claw help`.');
      return;
    }

    const pendingHistory = msg.guild ? consumePendingGuildHistory(msg.channelId) : [];
    await queueConversationMessage(msg, content, pendingHistory);
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
    if (!isTrigger(fetched)) {
      updatePendingGuildHistory(fetched, updatedContent);
      return;
    }
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
    removePendingGuildHistoryByMessageId(msg.id);
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
