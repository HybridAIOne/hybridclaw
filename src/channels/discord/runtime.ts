import {
  ActivityType,
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
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
} from '../../config.js';
import { buildAttachmentContext } from './attachments.js';
import {
  buildSessionIdFromContext as buildSessionIdFromContextInbound,
  cleanIncomingContent as cleanIncomingContentInbound,
  hasPrefixInvocation as hasPrefixInvocationInbound,
  isTrigger as isTriggerInbound,
  parseCommand as parseCommandInbound,
  type ParsedCommand,
} from './inbound.js';
import {
  addMentionAlias,
  extractMentionAliasHints,
  normalizeMentionAlias,
  type MentionLookup,
} from './mentions.js';
import {
  formatError,
  prepareChunkedPayloads,
  sendChunkedDirectReply as sendChunkedDirectReplyFromDelivery,
  sendChunkedInteractionReply as sendChunkedInteractionReplyFromDelivery,
  sendChunkedReply as sendChunkedReplyFromDelivery,
} from './delivery.js';
import {
  createDiscordToolActionRunner,
  type CachedDiscordPresence,
  type DiscordToolActionRequest,
} from './tool-actions.js';
import { DiscordStreamManager } from './stream.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types.js';

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
  media: MediaContextItem[],
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
const DISCORD_RETRY_MAX_ATTEMPTS = 3;
const DISCORD_RETRY_BASE_DELAY_MS = 500;
const GUILD_INBOUND_HISTORY_LIMIT = 20;
const GUILD_INBOUND_HISTORY_MAX_CHARS = 6_000;
const PARTICIPANT_CONTEXT_MAX_USERS = 30;
const PARTICIPANT_MEMORY_MAX_CHANNELS = 200;
const PARTICIPANT_MEMORY_MAX_USERS_PER_CHANNEL = 200;
const PARTICIPANT_MEMORY_MAX_ALIASES_PER_USER = 8;
const MAX_PRESENCE_CACHE_USERS = 5_000;

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

function requireDiscordClientReady(): Client {
  if (!client) {
    throw new Error('Discord client is not initialized.');
  }
  if (!client.isReady()) {
    throw new Error('Discord client is not ready yet.');
  }
  return client;
}

const runDiscordToolActionInternal = createDiscordToolActionRunner({
  requireDiscordClientReady,
  getDiscordPresence,
});

export async function runDiscordToolAction(
  request: DiscordToolActionRequest,
): Promise<Record<string, unknown>> {
  return await runDiscordToolActionInternal(request);
}

function getSessionId(msg: DiscordMessage): string {
  return buildSessionIdFromContext(msg.guild?.id ?? null, msg.channelId, msg.author.id);
}

function hasPrefixInvocation(content: string): boolean {
  return hasPrefixInvocationInbound(content, botMentionRegex, DISCORD_PREFIX);
}

function isAuthorizedCommandUserId(userId: string): boolean {
  const configuredUserId = DISCORD_COMMAND_USER_ID.trim();
  if (!configuredUserId) return true;
  return userId === configuredUserId;
}

function buildSessionIdFromContext(guildId: string | null, channelId: string, userId: string): string {
  return buildSessionIdFromContextInbound(guildId, channelId, userId);
}

function isTrigger(msg: DiscordMessage): boolean {
  return isTriggerInbound({
    content: msg.content,
    isDm: !msg.guild,
    commandsOnly: DISCORD_COMMANDS_ONLY,
    respondToAllMessages: DISCORD_RESPOND_TO_ALL_MESSAGES,
    prefix: DISCORD_PREFIX,
    botMentionRegex,
    hasBotMention: Boolean(client.user && msg.mentions.has(client.user)),
  });
}

function parseCommand(content: string): ParsedCommand {
  return parseCommandInbound(content, botMentionRegex, DISCORD_PREFIX);
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
  return cleanIncomingContentInbound(content, botMentionRegex, DISCORD_PREFIX);
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
  await sendChunkedReplyFromDelivery({
    msg,
    text,
    withRetry: withDiscordRetry,
    ...(files ? { files } : {}),
    ...(mentionLookup ? { mentionLookup } : {}),
  });
}

async function sendChunkedDirectReply(
  msg: DiscordMessage,
  text: string,
  files?: AttachmentBuilder[],
  mentionLookup?: MentionLookup,
): Promise<void> {
  await sendChunkedDirectReplyFromDelivery({
    msg,
    text,
    withRetry: withDiscordRetry,
    ...(files ? { files } : {}),
    ...(mentionLookup ? { mentionLookup } : {}),
  });
}

async function sendChunkedInteractionReply(
  interaction: Parameters<typeof sendChunkedInteractionReplyFromDelivery>[0]['interaction'],
  text: string,
  files?: AttachmentBuilder[],
): Promise<void> {
  await sendChunkedInteractionReplyFromDelivery({
    interaction,
    text,
    withRetry: withDiscordRetry,
    ...(files ? { files } : {}),
  });
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
    const combinedContent = `${feedbackNote ? `[Reaction feedback]\n${feedbackNote}\n\n` : ''}${channelInfoContext}${replyContext}${inboundHistory.context}${attachmentContext.context}${participantContext}${batchedContent}`;

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
        attachmentContext.media,
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
    const payloads = prepareChunkedPayloads(text, files);
    const send = (channel as unknown as {
      send: (payload: { content: string; files?: AttachmentBuilder[] }) => Promise<void>;
    }).send;
    for (const payload of payloads) {
      await withDiscordRetry('send-channel', () => send(payload));
    }
  }
}
