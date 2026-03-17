import fs from 'node:fs';
import path from 'node:path';
import {
  type ApplicationCommandDataResolvable,
  AttachmentBuilder,
  Client,
  type Message as DiscordMessage,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { resolveAgentForRequest } from '../../agents/agent-registry.js';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import {
  DISCORD_ACK_REACTION,
  DISCORD_ACK_REACTION_SCOPE,
  DISCORD_COMMAND_ALLOWED_USER_IDS,
  DISCORD_COMMAND_MODE,
  DISCORD_COMMAND_USER_ID,
  DISCORD_COMMANDS_ONLY,
  DISCORD_DEBOUNCE_MS,
  DISCORD_FREE_RESPONSE_CHANNELS,
  DISCORD_GROUP_POLICY,
  DISCORD_GUILD_MEMBERS_INTENT,
  DISCORD_GUILDS,
  DISCORD_HUMAN_DELAY,
  DISCORD_LIFECYCLE_REACTIONS,
  DISCORD_MAX_CONCURRENT_PER_CHANNEL,
  DISCORD_PREFIX,
  DISCORD_PRESENCE_INTENT,
  DISCORD_RATE_LIMIT_EXEMPT_ROLES,
  DISCORD_RATE_LIMIT_PER_USER,
  DISCORD_REMOVE_ACK_AFTER_REPLY,
  DISCORD_SELF_PRESENCE,
  DISCORD_SUPPRESS_PATTERNS,
  DISCORD_TOKEN,
  DISCORD_TYPING_MODE,
} from '../../config/config.js';
import { claimPendingApprovalByApprovalId } from '../../gateway/pending-approvals.js';
import { parseResetConfirmationCustomId } from '../../gateway/reset-confirmation.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsThinking,
} from '../../gateway/show-mode.js';
import { agentWorkspaceDir } from '../../infra/ipc.js';
import { logger } from '../../logger.js';
import { getSessionById, resolveSessionIdCompat } from '../../memory/db.js';
import { getAvailableModelChoices } from '../../providers/model-catalog.js';
import { recordSkillFeedback } from '../../skills/skills-observation.js';
import type { MediaContextItem } from '../../types.js';
import { publishWorkflowEvent } from '../../workflow/event-bus.js';
import { sleep } from '../../utils/sleep.js';
import { DISCORD_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import {
  buildApprovalActionRow,
  disableApprovalButtons,
  parseApprovalCustomId,
} from './approval-buttons.js';
import { buildAttachmentContext } from './attachments.js';
import {
  DEFAULT_DEBOUNCE_MAX_BUFFER,
  resolveInboundDebounceMs,
  shouldDebounceInbound,
} from './debounce.js';
import {
  type DiscordMessageComponents,
  formatError,
  prepareChunkedPayloads,
  sendChunkedDirectReply as sendChunkedDirectReplyFromDelivery,
  sendChunkedInteractionReply as sendChunkedInteractionReplyFromDelivery,
  sendChunkedReply as sendChunkedReplyFromDelivery,
} from './delivery.js';
import type { HumanDelayConfig } from './human-delay.js';
import {
  buildSessionIdFromContext as buildSessionIdFromContextInbound,
  cleanIncomingContent as cleanIncomingContentInbound,
  type DiscordGuildMessageMode,
  hasLooseBotMention as hasLooseBotMentionInbound,
  hasPrefixInvocation as hasPrefixInvocationInbound,
  hasSlashCommandInvocation as hasSlashCommandInvocationInbound,
  isAddressedToChannel as isAddressedToChannelInbound,
  isAuthorizedCommandUser as isAuthorizedCommandUserInbound,
  isTrigger as isTriggerInbound,
  type ParsedCommand,
  parseCommand as parseCommandInbound,
  shouldReplyInFreeMode as shouldReplyInFreeModeInbound,
  shouldSkipFreeReplyBecauseOtherUsersMentioned as shouldSkipFreeReplyBecauseOtherUsersMentionedInbound,
} from './inbound.js';
import {
  addMentionAlias,
  extractMentionAliasHints,
  type MentionLookup,
  normalizeMentionAlias,
} from './mentions.js';
import {
  DiscordAutoPresenceController,
  type PresenceHealthState,
} from './presence.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';
import {
  addAckReaction,
  type LifecyclePhase,
  LifecycleReactionController,
} from './reactions.js';
import {
  DISCORD_SEND_MEDIA_ROOT_HOST_DIR,
  resolveDiscordLocalFileForSend,
} from './send-files.js';
import { resolveSendAllowed } from './send-permissions.js';
import {
  classifyDiscordSkillFeedbackSentiment,
  formatDiscordSkillFeedbackMessage,
  resolveDiscordSkillFeedbackSessionId,
} from './skill-feedback.js';
import {
  buildSlashCommandDefinitions,
  parseSlashInteractionArgs,
} from './slash-commands.js';
import { DiscordStreamManager } from './stream.js';
import { publishDiscordReactionWorkflowEvent } from './workflow-events.js';
import {
  type CachedDiscordPresence,
  createDiscordToolActionRunner,
  type DiscordToolActionRequest,
} from './tool-actions.js';
import { createTypingController } from './typing.js';

export type ReplyFn = (
  content: string,
  files?: AttachmentBuilder[],
  components?: DiscordMessageComponents,
) => Promise<void>;

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
  emitLifecyclePhase: (phase: LifecyclePhase) => void;
  sendApprovalNotification?: (params: {
    text: string;
    approvalId: string;
    userId: string;
  }) => Promise<{ disableButtons: () => Promise<void> } | null>;
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
  userId: string,
  username: string,
  args: string[],
  reply: ReplyFn,
) => Promise<void>;

let client: Client;
let messageHandler: MessageHandler;
let commandHandler: CommandHandler;
let activeConversationRuns = 0;
let botMentionRegex: RegExp | null = null;
const DISCORD_RETRY_MAX_ATTEMPTS = 3;
const DISCORD_RETRY_BASE_DELAY_MS = 500;
const GUILD_INBOUND_HISTORY_LIMIT = 20;
const GUILD_INBOUND_HISTORY_MAX_CHARS = 6_000;
const PARTICIPANT_CONTEXT_MAX_USERS = 30;
const PARTICIPANT_MEMORY_MAX_CHANNELS = 200;
const PARTICIPANT_MEMORY_MAX_USERS_PER_CHANNEL = 200;
const PARTICIPANT_MEMORY_MAX_ALIASES_PER_USER = 8;
const MAX_PRESENCE_CACHE_USERS = 5_000;
const RATE_LIMIT_NOTIFY_COOLDOWN_MS = 12_000;
const CONCURRENCY_RETRY_DELAY_MS = 250;
const PRESENCE_WINDOW_MS = 5 * 60_000;
const PRESENCE_DEGRADED_DURATION_MS = 45_000;
const PRESENCE_EXHAUSTED_ERROR_RE =
  /(api down|unavailable|rate limit|too many active containers|quota|token limit|timeout)/i;
const FRIENDLY_RATE_LIMIT_MESSAGE =
  "You're sending messages too fast — give me a moment to catch up!";
const READ_WITHOUT_REPLY_RE =
  /^(thanks|thank you|thx|ty|got it|ok|okay|cool|perfect|awesome|sounds good|roger)[!. ]*$/i;
const READ_WITHOUT_REPLY_PROBABILITY = 0.6;
const STARTUP_STAGGER_WINDOW_MS = 120_000;
const STARTUP_STAGGER_MIN_DELAY_MS = 500;
const STARTUP_STAGGER_MAX_DELAY_MS = 3_500;
const SELECTIVE_SILENCE_BASE_PROBABILITY = 0.25;
const SELECTIVE_SILENCE_ACTIVE_CHAT_PROBABILITY = 0.5;
const SELECTIVE_SILENCE_RECENT_WINDOW_MS = 60_000;
const NIGHT_HOURS_START = 22;
const NIGHT_HOURS_END = 7;
const CONVERSATION_COOLDOWN_RESET_MS = 20 * 60_000;
const CONVERSATION_COOLDOWN_THRESHOLD = 5;
const CONVERSATION_COOLDOWN_MAX_FACTOR = 2.5;

const discordPresenceCache = new Map<string, CachedDiscordPresence>();
const userRateLimiter = new SlidingWindowRateLimiter(60_000);
const recentConversationMetrics: Array<{
  atMs: number;
  durationMs: number;
  ok: boolean;
  exhaustedHint: boolean;
}> = [];
let consecutiveConversationFailures = 0;
let presenceController: DiscordAutoPresenceController | null = null;
let startupConnectedAtMs = 0;
const conversationExchangeByKey = new Map<
  string,
  { count: number; lastAtMs: number }
>();

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

  const addUser = (
    userId: string,
    aliases: Array<string | null | undefined>,
  ): void => {
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
      if (mentionedMember?.displayName)
        aliases.push(mentionedMember.displayName);
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
  const snippet =
    content.length > 300 ? `${content.slice(0, 297)}...` : content;
  return `${authorLabel}: ${snippet}`;
}

function buildPendingHistoryContext(
  entries: PendingGuildHistoryEntry[],
): string {
  if (entries.length === 0) return '';
  const selected: string[] = [];
  let totalChars = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const line = summarizePendingHistoryEntry(entries[i]);
    if (!line) continue;
    if (
      totalChars + line.length > GUILD_INBOUND_HISTORY_MAX_CHARS &&
      selected.length > 0
    )
      break;
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
  if (!msg.guild || !('messages' in msg.channel))
    return { entries: [], context: '' };

  try {
    const recentMessages = await msg.channel.messages.fetch({
      limit: GUILD_INBOUND_HISTORY_LIMIT,
    });
    const entries: PendingGuildHistoryEntry[] = [];
    let hiddenTextCount = 0;
    let hiddenBotTextCount = 0;

    const summarizeHistoryMessageContent = (recent: DiscordMessage): string => {
      const plainText = cleanIncomingContent(recent.content || '').trim();
      if (plainText) return plainText;

      const embedChunks = recent.embeds
        .map((embed) =>
          [embed.title?.trim(), embed.description?.trim()]
            .filter(Boolean)
            .join(' — '),
        )
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

      const systemContent = recent.system
        ? (recent.cleanContent || '').trim()
        : '';
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
        timestampMs: Number.isFinite(recent.createdTimestamp)
          ? recent.createdTimestamp
          : 0,
        content,
      });
    }
    entries.sort(
      (a, b) =>
        a.timestampMs - b.timestampMs || a.messageId.localeCompare(b.messageId),
    );
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
    logger.debug(
      { error, guildId: msg.guild.id, channelId: msg.channelId },
      'Failed to build inbound channel history snapshot',
    );
    return { entries: [], context: '' };
  }
}

function addParticipantAlias(
  info: ParticipantInfo,
  alias: string | null | undefined,
): void {
  const normalized = normalizeMentionAlias(alias);
  if (!normalized) return;
  info.aliases.add(normalized);
}

function formatDiscordHandleFromAlias(
  alias: string | null | undefined,
): string | null {
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
      const preferredHandle =
        formatDiscordHandleFromAlias(aliases[0]) || `id:${entry.id}`;
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

const DISCORD_READY_WAIT_TIMEOUT_MS = 10_000;
const DISCORD_READY_WAIT_INTERVAL_MS = 100;

async function requireDiscordClientReady(): Promise<Client> {
  if (!client) {
    throw new Error('Discord client is not initialized.');
  }
  if (client.isReady()) {
    return client;
  }

  const deadline = Date.now() + DISCORD_READY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DISCORD_READY_WAIT_INTERVAL_MS);
    if (!client) {
      throw new Error('Discord client is not initialized.');
    }
    if (client.isReady()) {
      return client;
    }
  }

  throw new Error('Discord client is not ready yet.');
}

function resolveDiscordToolSessionWorkspaceRoot(
  sessionId: string | undefined,
): string | null {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return null;

  const session = getSessionById(normalizedSessionId);
  if (!session) return null;

  const { agentId } = resolveAgentForRequest({ session });
  return path.resolve(agentWorkspaceDir(agentId));
}

async function resolveDiscordToolSendAttachments(
  request: DiscordToolActionRequest,
): Promise<AttachmentBuilder[]> {
  const rawPath = String(request.filePath || '').trim();
  if (!rawPath) return [];

  const workspaceRoot = resolveDiscordToolSessionWorkspaceRoot(
    request.sessionId,
  );
  const resolvedPath = resolveDiscordLocalFileForSend({
    filePath: rawPath,
    sessionWorkspaceRoot: workspaceRoot,
    mediaCacheRoot: DISCORD_SEND_MEDIA_ROOT_HOST_DIR,
  });
  if (!resolvedPath) {
    if (!workspaceRoot) {
      throw new Error(
        'filePath could not be resolved. Use /discord-media-cache/... or include session context for workspace files.',
      );
    }
    throw new Error(
      'filePath must stay within the current session workspace or /discord-media-cache.',
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    throw new Error(`filePath does not exist: ${rawPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`filePath is not a file: ${rawPath}`);
  }

  const content = fs.readFileSync(resolvedPath);
  return [
    new AttachmentBuilder(content, { name: path.basename(resolvedPath) }),
  ];
}

const runDiscordToolActionInternal = createDiscordToolActionRunner({
  requireDiscordClientReady,
  getDiscordPresence,
  sendToChannel,
  resolveSendAttachments: resolveDiscordToolSendAttachments,
  resolveSendAllowed,
});

export async function runDiscordToolAction(
  request: DiscordToolActionRequest,
): Promise<Record<string, unknown>> {
  return await runDiscordToolActionInternal(request);
}

function getSessionId(msg: DiscordMessage): string {
  return buildSessionIdFromContext(
    msg.guild?.id ?? null,
    msg.channelId,
    msg.author.id,
  );
}

function hasPrefixInvocation(content: string): boolean {
  return hasPrefixInvocationInbound(content, botMentionRegex, DISCORD_PREFIX);
}

function hasSlashCommandInvocation(content: string): boolean {
  return hasSlashCommandInvocationInbound(content, botMentionRegex);
}

function isAuthorizedCommandUserId(userId: string): boolean {
  return isAuthorizedCommandUserInbound({
    mode: DISCORD_COMMAND_MODE,
    userId,
    allowedUserIds: DISCORD_COMMAND_ALLOWED_USER_IDS,
    legacyCommandUserId: DISCORD_COMMAND_USER_ID,
  });
}

function requiresCompactPermission(args: string[]): boolean {
  return (args[0] || '').trim().toLowerCase() === 'compact';
}

const COMPACT_PERMISSION_DENIED_MESSAGE =
  'You need Manage Messages, Manage Server, or Administrator permissions to run `/compact` in a server.';

function hasCompactPermission(
  permissions:
    | {
        has: (permission: bigint) => boolean;
      }
    | null
    | undefined,
): boolean {
  if (!permissions) return false;
  return (
    permissions.has(PermissionFlagsBits.Administrator) ||
    permissions.has(PermissionFlagsBits.ManageGuild) ||
    permissions.has(PermissionFlagsBits.ManageMessages)
  );
}

function shouldDenyCompactCommand(params: {
  args: string[];
  inGuild: boolean;
  permissions:
    | {
        has: (permission: bigint) => boolean;
      }
    | null
    | undefined;
}): boolean {
  return (
    params.inGuild &&
    requiresCompactPermission(params.args) &&
    !hasCompactPermission(params.permissions)
  );
}

function buildSessionIdFromContext(
  guildId: string | null,
  channelId: string,
  userId: string,
): string {
  const defaultSessionId = buildSessionIdFromContextInbound(
    DEFAULT_AGENT_ID,
    guildId,
    channelId,
    userId,
  );
  const legacySessionId = guildId ? `${guildId}:${channelId}` : `dm:${userId}`;
  const existingSession =
    getSessionById(defaultSessionId) || getSessionById(legacySessionId);
  if (existingSession) {
    return existingSession.id;
  }
  return defaultSessionId;
}

interface ResolvedChannelBehavior {
  guildMessageMode: DiscordGuildMessageMode;
  typingMode: 'instant' | 'thinking' | 'streaming' | 'never';
  debounceMs: number;
  ackReaction: string;
  ackReactionScope: 'all' | 'group-mentions' | 'direct' | 'off';
  removeAckAfterReply: boolean;
  humanDelay: HumanDelayConfig;
  rateLimitPerUser: number;
  suppressPatterns: string[];
  maxConcurrentPerChannel: number;
}

function resolveGuildMessageMode(msg: DiscordMessage): DiscordGuildMessageMode {
  if (!msg.guild) return 'free';
  if (DISCORD_GROUP_POLICY === 'disabled') return 'off';

  const guildConfig = DISCORD_GUILDS[msg.guild.id];
  const explicitMode = guildConfig?.channels[msg.channelId]?.mode;
  if (DISCORD_GROUP_POLICY === 'allowlist') {
    return explicitMode ?? 'off';
  }
  if (explicitMode) return explicitMode;
  if (DISCORD_FREE_RESPONSE_CHANNELS.includes(msg.channelId)) return 'free';
  if (guildConfig) return guildConfig.defaultMode;
  return 'mention';
}

function resolveChannelBehavior(msg: DiscordMessage): ResolvedChannelBehavior {
  const guildConfig = msg.guild ? DISCORD_GUILDS[msg.guild.id] : undefined;
  const channelConfig = guildConfig?.channels[msg.channelId];
  return {
    guildMessageMode: resolveGuildMessageMode(msg),
    typingMode: channelConfig?.typingMode ?? DISCORD_TYPING_MODE,
    debounceMs: resolveInboundDebounceMs(
      DISCORD_DEBOUNCE_MS,
      channelConfig?.debounceMs,
    ),
    ackReaction:
      (channelConfig?.ackReaction ?? DISCORD_ACK_REACTION).trim() ||
      DISCORD_ACK_REACTION,
    ackReactionScope:
      channelConfig?.ackReactionScope ?? DISCORD_ACK_REACTION_SCOPE,
    removeAckAfterReply:
      channelConfig?.removeAckAfterReply ?? DISCORD_REMOVE_ACK_AFTER_REPLY,
    humanDelay: channelConfig?.humanDelay ?? DISCORD_HUMAN_DELAY,
    rateLimitPerUser: Math.max(
      0,
      channelConfig?.rateLimitPerUser ?? DISCORD_RATE_LIMIT_PER_USER,
    ),
    suppressPatterns:
      channelConfig?.suppressPatterns ?? DISCORD_SUPPRESS_PATTERNS,
    maxConcurrentPerChannel: Math.max(
      1,
      channelConfig?.maxConcurrentPerChannel ??
        DISCORD_MAX_CONCURRENT_PER_CHANNEL,
    ),
  };
}

function isTrigger(
  msg: DiscordMessage,
  behavior: ResolvedChannelBehavior,
): boolean {
  return isTriggerInbound({
    content: msg.content,
    isDm: !msg.guild,
    commandsOnly: DISCORD_COMMANDS_ONLY,
    guildMessageMode: behavior.guildMessageMode,
    prefix: DISCORD_PREFIX,
    botMentionRegex,
    hasBotMention: Boolean(client.user && msg.mentions.has(client.user)),
    suppressPatterns: behavior.suppressPatterns,
  });
}

function shouldHandleFreeModeMessage(
  msg: DiscordMessage,
  behavior: ResolvedChannelBehavior,
  content: string,
): boolean {
  if (!msg.guild) return true;

  const hasPrefixedInvocation = hasPrefixInvocation(msg.content || '');
  const hasBotMention = Boolean(client.user && msg.mentions.has(client.user));
  const hasLooseBotMention =
    client.user != null
      ? hasLooseBotMentionInbound(content, [
          client.user.username,
          client.user.globalName || '',
          msg.guild?.members.me?.displayName || '',
        ])
      : false;
  const isReplyToBot = Boolean(
    client.user && msg.mentions.repliedUser?.id === client.user.id,
  );
  const mentionedUserIds = Array.from(msg.mentions.users.keys());
  const botUserId = client.user?.id ?? null;

  if (
    shouldSkipFreeReplyBecauseOtherUsersMentionedInbound({
      guildMessageMode: behavior.guildMessageMode,
      hasBotMention,
      hasPrefixInvocation: hasPrefixedInvocation,
      botUserId,
      mentionedUserIds,
    })
  ) {
    return false;
  }

  return shouldReplyInFreeModeInbound({
    guildMessageMode: behavior.guildMessageMode,
    content,
    hasBotMention,
    hasLooseBotMention,
    isAddressedToChannel: isAddressedToChannelInbound(content),
    hasPrefixInvocation: hasPrefixedInvocation,
    isReplyToBot,
    hasAttachments: msg.attachments.size > 0,
  });
}

function shouldApplyAckReaction(
  msg: DiscordMessage,
  behavior: ResolvedChannelBehavior,
): boolean {
  const scope = behavior.ackReactionScope;
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  if (scope === 'direct') return !msg.guild;
  if (!msg.guild || !client.user) return false;
  return msg.mentions.has(client.user);
}

function isRateLimitExempt(msg: DiscordMessage): boolean {
  if (msg.author.id === DISCORD_COMMAND_USER_ID.trim()) return true;
  if (!msg.guild) return false;
  if (!msg.member || DISCORD_RATE_LIMIT_EXEMPT_ROLES.length === 0) return false;

  const exemptByName = new Set(
    DISCORD_RATE_LIMIT_EXEMPT_ROLES.map((role) =>
      role.trim().toLowerCase(),
    ).filter(Boolean),
  );
  if (exemptByName.size === 0) return false;

  for (const role of msg.member.roles.cache.values()) {
    const normalized = role.name.trim().toLowerCase();
    if (exemptByName.has(normalized)) return true;
  }
  return false;
}

function parseCommand(content: string): ParsedCommand {
  return parseCommandInbound(content, botMentionRegex, DISCORD_PREFIX);
}

function isRetryableDiscordError(error: unknown): boolean {
  const maybe = error as DiscordErrorLike;
  const status = maybe.status ?? maybe.httpStatus;
  return (
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  );
}

function retryDelayMs(error: unknown, fallbackMs: number): number {
  const maybe = error as DiscordErrorLike;
  const retryAfterSeconds = maybe.retryAfter ?? maybe.data?.retry_after;
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    return Math.max(50, Math.ceil(retryAfterSeconds * 1_000));
  }
  return fallbackMs + Math.floor(Math.random() * 250);
}

async function withDiscordRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  let delayMs = DISCORD_RETRY_BASE_DELAY_MS;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (
        attempt >= DISCORD_RETRY_MAX_ATTEMPTS ||
        !isRetryableDiscordError(error)
      ) {
        throw error;
      }
      const waitMs = retryDelayMs(error, delayMs);
      logger.warn(
        { label, attempt, waitMs, error },
        'Discord API call failed; retrying',
      );
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
  const snippet =
    content.length > 500 ? `${content.slice(0, 497)}...` : content;
  return `${author}: ${snippet || '(no text)'}`;
}

function buildChannelInfoContext(msg: DiscordMessage): string {
  if (!msg.guild) return '';

  const lines: string[] = [
    '[Channel info]',
    `- guild_id: ${msg.guild.id}`,
    `- channel_id: ${msg.channelId}`,
  ];

  const namedChannel = msg.channel as unknown as {
    name?: string;
    topic?: string;
    parent?: { name?: string | null } | null;
  };
  const channelName =
    typeof namedChannel.name === 'string' ? namedChannel.name.trim() : '';
  if (channelName) {
    lines.push(`- channel_name: #${channelName}`);
  }
  const channelTopic =
    typeof namedChannel.topic === 'string' ? namedChannel.topic.trim() : '';
  if (channelTopic) {
    lines.push(`- channel_topic: ${channelTopic}`);
  }
  const parentName =
    typeof namedChannel.parent?.name === 'string'
      ? namedChannel.parent.name.trim()
      : '';
  if (parentName) {
    lines.push(`- parent_channel: ${parentName}`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function buildReplyContext(msg: DiscordMessage): Promise<string> {
  const blocks: string[] = [];

  if (
    'isThread' in msg.channel &&
    typeof msg.channel.isThread === 'function' &&
    msg.channel.isThread()
  ) {
    try {
      const starter = await msg.channel.fetchStarterMessage();
      if (starter) {
        blocks.push(`[Thread starter]\n${summarizeContextMessage(starter)}`);
      }
    } catch (error) {
      logger.debug(
        { error, channelId: msg.channelId },
        'Failed to fetch thread starter message',
      );
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

async function sendChunkedReply(
  msg: DiscordMessage,
  text: string,
  files?: AttachmentBuilder[],
  components?: DiscordMessageComponents,
  mentionLookup?: MentionLookup,
  humanDelay?: HumanDelayConfig,
): Promise<void> {
  await sendChunkedReplyFromDelivery({
    msg,
    text,
    withRetry: withDiscordRetry,
    ...(humanDelay ? { humanDelay } : {}),
    ...(files?.length ? { files } : {}),
    ...(components?.length ? { components } : {}),
    ...(mentionLookup ? { mentionLookup } : {}),
  });
}

async function sendChunkedDirectReply(
  msg: DiscordMessage,
  text: string,
  files?: AttachmentBuilder[],
  components?: DiscordMessageComponents,
  mentionLookup?: MentionLookup,
  humanDelay?: HumanDelayConfig,
): Promise<void> {
  await sendChunkedDirectReplyFromDelivery({
    msg,
    text,
    withRetry: withDiscordRetry,
    ...(humanDelay ? { humanDelay } : {}),
    ...(files?.length ? { files } : {}),
    ...(components?.length ? { components } : {}),
    ...(mentionLookup ? { mentionLookup } : {}),
  });
}

async function sendChunkedInteractionReply(
  interaction: Parameters<
    typeof sendChunkedInteractionReplyFromDelivery
  >[0]['interaction'],
  text: string,
  files?: AttachmentBuilder[],
  components?: DiscordMessageComponents,
): Promise<void> {
  await sendChunkedInteractionReplyFromDelivery({
    interaction,
    text,
    withRetry: withDiscordRetry,
    ...(files?.length ? { files } : {}),
    ...(components?.length ? { components } : {}),
  });
}

async function ensureSlashCommands(): Promise<void> {
  const modelChoices = await getAvailableModelChoices(25);
  const definitions = buildSlashCommandDefinitions(modelChoices);
  const definitionNames = new Set(
    definitions.map((definition) => definition.name),
  );

  if (!client.application) return;
  let globalRegisteredCount = 0;
  try {
    for (const definition of definitions) {
      // POST is an upsert by name for global commands. Keep command IDs stable
      // to avoid stale-client command references in DMs.
      await client.application.commands.create(
        definition as unknown as ApplicationCommandDataResolvable,
      );
      globalRegisteredCount += 1;
      logger.debug(
        { scope: 'global', command: definition.name },
        'Upserted slash command',
      );
    }
    logger.info(
      { scope: 'global', count: globalRegisteredCount },
      'Successfully registered slash commands',
    );
  } catch (error) {
    logger.warn({ error }, 'Failed to register global slash commands');
  }

  await Promise.allSettled(
    [...client.guilds.cache.values()].map(async (guild) => {
      try {
        const refreshed = await guild.commands.fetch();
        let removedCount = 0;
        for (const command of refreshed.values()) {
          if (!definitionNames.has(command.name)) {
            continue;
          }
          await guild.commands.delete(command.id);
          removedCount += 1;
          logger.debug(
            { guildId: guild.id, command: command.name },
            'Removed guild slash command',
          );
        }
        logger.info(
          { guildId: guild.id, count: removedCount },
          'Successfully cleaned up guild slash commands',
        );
      } catch (error) {
        logger.warn(
          { error, guildId: guild.id },
          'Failed to clean up Discord guild slash commands',
        );
      }
    }),
  );
}

function trimRecentConversationMetrics(nowMs = Date.now()): void {
  const cutoff = nowMs - PRESENCE_WINDOW_MS;
  while (
    recentConversationMetrics.length > 0 &&
    recentConversationMetrics[0].atMs < cutoff
  ) {
    recentConversationMetrics.shift();
  }
}

function recordConversationMetric(params: {
  durationMs: number;
  ok: boolean;
  error?: unknown;
}): void {
  const nowMs = Date.now();
  const errorText =
    params.error instanceof Error
      ? params.error.message
      : String(params.error || '');
  const exhaustedHint =
    !params.ok && PRESENCE_EXHAUSTED_ERROR_RE.test(errorText);
  if (params.ok) {
    consecutiveConversationFailures = 0;
  } else {
    consecutiveConversationFailures += 1;
  }
  recentConversationMetrics.push({
    atMs: nowMs,
    durationMs: Math.max(0, Math.floor(params.durationMs)),
    ok: params.ok,
    exhaustedHint,
  });
  trimRecentConversationMetrics(nowMs);
}

function resolvePresenceHealthState(): PresenceHealthState {
  trimRecentConversationMetrics();
  if (activeConversationRuns >= 4) return 'degraded';
  if (consecutiveConversationFailures >= 3) return 'exhausted';
  if (recentConversationMetrics.some((entry) => entry.exhaustedHint))
    return 'exhausted';

  if (recentConversationMetrics.length === 0) return 'healthy';
  const totalDuration = recentConversationMetrics.reduce(
    (sum, entry) => sum + entry.durationMs,
    0,
  );
  const avgDuration = totalDuration / recentConversationMetrics.length;
  const failureCount = recentConversationMetrics.filter(
    (entry) => !entry.ok,
  ).length;
  const errorRate = failureCount / recentConversationMetrics.length;
  if (errorRate >= 0.25 || avgDuration >= PRESENCE_DEGRADED_DURATION_MS)
    return 'degraded';
  return 'healthy';
}

function randomIntInRange(minMs: number, maxMs: number): number {
  const lo = Math.floor(Math.max(0, minMs));
  const hi = Math.floor(Math.max(lo, maxMs));
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function isNightOrWeekend(now: Date): boolean {
  const day = now.getDay();
  const hour = now.getHours();
  const weekend = day === 0 || day === 6;
  const night = hour >= NIGHT_HOURS_START || hour < NIGHT_HOURS_END;
  return weekend || night;
}

function buildConversationCooldownKey(
  channelId: string,
  userId: string,
): string {
  return `${channelId}:${userId}`;
}

function resolveHumanDelayWithBehavior(
  base: HumanDelayConfig,
  cooldownKey: string,
): HumanDelayConfig {
  if (base.mode === 'off') return base;
  const now = new Date();
  let factor = isNightOrWeekend(now) ? 1.5 : 1;
  const record = conversationExchangeByKey.get(cooldownKey);
  if (record) {
    const elapsedMs = Date.now() - record.lastAtMs;
    if (elapsedMs > CONVERSATION_COOLDOWN_RESET_MS) {
      conversationExchangeByKey.delete(cooldownKey);
    } else if (record.count > CONVERSATION_COOLDOWN_THRESHOLD) {
      const extra = Math.min(
        CONVERSATION_COOLDOWN_MAX_FACTOR - 1,
        (record.count - CONVERSATION_COOLDOWN_THRESHOLD) * 0.12,
      );
      factor += Math.max(0, extra);
    }
  }

  if (factor <= 1) return base;
  const minMs = Math.round((base.minMs ?? 800) * factor);
  const maxMs = Math.round((base.maxMs ?? 2_500) * factor);
  return {
    mode: 'custom',
    minMs,
    maxMs: Math.max(minMs, maxMs),
  };
}

function noteConversationExchange(cooldownKey: string): void {
  const nowMs = Date.now();
  const existing = conversationExchangeByKey.get(cooldownKey);
  if (!existing || nowMs - existing.lastAtMs > CONVERSATION_COOLDOWN_RESET_MS) {
    conversationExchangeByKey.set(cooldownKey, { count: 1, lastAtMs: nowMs });
    return;
  }
  conversationExchangeByKey.set(cooldownKey, {
    count: existing.count + 1,
    lastAtMs: nowMs,
  });
}

function pickReadWithoutReplyEmoji(): string {
  return Math.random() < 0.7 ? '👍' : '✅';
}

export function initDiscord(
  onMessage: MessageHandler,
  onCommand: CommandHandler,
): Client {
  messageHandler = onMessage;
  commandHandler = onCommand;
  registerChannel({
    kind: 'discord',
    id: 'discord',
    capabilities: DISCORD_CAPABILITIES,
  });

  interface QueuedConversationMessage {
    msg: DiscordMessage;
    content: string;
    behavior: ResolvedChannelBehavior;
    clearAckReaction: () => Promise<void>;
    wasExplicitlyAddressed: boolean;
    cooldownKey: string;
  }
  interface PendingConversationBatch {
    items: QueuedConversationMessage[];
    timer: ReturnType<typeof setTimeout>;
    typingController: ReturnType<typeof createTypingController>;
    lifecycleController: LifecycleReactionController | null;
  }
  interface InFlightConversation {
    abortController: AbortController;
    stream: DiscordStreamManager;
    messageIds: Set<string>;
    aborted: boolean;
    emitLifecyclePhase: (phase: LifecyclePhase) => void;
  }
  const pendingBatches = new Map<string, PendingConversationBatch>();
  const inFlightByMessageId = new Map<string, InFlightConversation>();
  const channelConcurrencyById = new Map<string, number>();
  const negativeFeedbackByChannel = new Map<string, string>();
  const participantMemoryByChannel = new Map<
    string,
    Map<string, Set<string>>
  >();

  const touchParticipantMemoryChannel = (
    channelId: string,
  ): Map<string, Set<string>> => {
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

  const rememberParticipantAliasForChannel = (
    channelId: string,
    userId: string,
    rawAlias: string | null | undefined,
  ): void => {
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
      const kept = new Set(
        Array.from(aliases).slice(-PARTICIPANT_MEMORY_MAX_ALIASES_PER_USER),
      );
      channelMemory.set(userId, kept);
    }
    // Refresh user recency.
    const refreshed = channelMemory.get(userId);
    if (refreshed) {
      channelMemory.delete(userId);
      channelMemory.set(userId, refreshed);
    }
  };

  const rememberParticipantForChannel = (
    channelId: string,
    userId: string,
    aliases: Array<string | null | undefined>,
  ): void => {
    if (!userId || userId === client.user?.id) return;
    for (const alias of aliases) {
      rememberParticipantAliasForChannel(channelId, userId, alias);
    }
  };

  const observeMessageParticipants = (
    msg: DiscordMessage,
    content: string,
  ): void => {
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
      rememberParticipantAliasForChannel(
        msg.channelId,
        hint.userId,
        hint.alias,
      );
    }
  };

  const waitForChannelConcurrencySlot = async (
    channelId: string,
    maxConcurrent: number,
    abortSignal?: AbortSignal,
  ): Promise<() => void> => {
    const boundedMax = Math.max(1, Math.floor(maxConcurrent));
    let waitStartedAt: number | null = null;
    while ((channelConcurrencyById.get(channelId) ?? 0) >= boundedMax) {
      if (waitStartedAt == null) {
        waitStartedAt = Date.now();
        logger.debug(
          {
            channelId,
            active: channelConcurrencyById.get(channelId) ?? 0,
            maxConcurrent: boundedMax,
          },
          'Waiting for Discord channel concurrency slot',
        );
      }
      if (abortSignal?.aborted) {
        throw new Error(
          'Conversation aborted while waiting for channel concurrency slot.',
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CONCURRENCY_RETRY_DELAY_MS),
      );
    }
    if (abortSignal?.aborted) {
      throw new Error(
        'Conversation aborted before acquiring channel concurrency slot.',
      );
    }
    channelConcurrencyById.set(
      channelId,
      (channelConcurrencyById.get(channelId) ?? 0) + 1,
    );
    if (waitStartedAt != null) {
      logger.debug(
        {
          channelId,
          waitMs: Date.now() - waitStartedAt,
          active: channelConcurrencyById.get(channelId) ?? 0,
          maxConcurrent: boundedMax,
        },
        'Acquired Discord channel concurrency slot after waiting',
      );
    }
    return () => {
      const current = channelConcurrencyById.get(channelId) ?? 0;
      const next = Math.max(0, current - 1);
      if (next === 0) {
        channelConcurrencyById.delete(channelId);
      } else {
        channelConcurrencyById.set(channelId, next);
      }
    };
  };

  const enforcePerUserRateLimit = async (
    msg: DiscordMessage,
    behavior: ResolvedChannelBehavior,
  ): Promise<boolean> => {
    const limit = Math.max(0, Math.floor(behavior.rateLimitPerUser));
    if (limit === 0) return true;
    if (isRateLimitExempt(msg)) return true;

    const key = `${msg.channelId}:${msg.author.id}`;
    const decision = userRateLimiter.check(key, limit);
    if (decision.allowed) return true;

    if (userRateLimiter.shouldNotify(key, RATE_LIMIT_NOTIFY_COOLDOWN_MS)) {
      try {
        await withDiscordRetry('rate-limit-reply', () =>
          msg.reply({ content: FRIENDLY_RATE_LIMIT_MESSAGE }),
        );
      } catch (error) {
        logger.debug(
          { error, channelId: msg.channelId, userId: msg.author.id },
          'Failed to send rate-limit warning',
        );
      }
    }
    return false;
  };

  const maybeHandleReadWithoutReply = async (
    msg: DiscordMessage,
    content: string,
  ): Promise<boolean> => {
    if (!content.trim()) return false;
    if (!msg.guild) return false;
    if (msg.attachments.size > 0) return false;
    if (hasPrefixInvocation(msg.content || '')) return false;
    if (hasSlashCommandInvocation(msg.content || '')) return false;
    if (client.user && msg.mentions.has(client.user)) return false;
    if (content.trim().length > 80) return false;
    if (!READ_WITHOUT_REPLY_RE.test(content.trim())) return false;
    if (Math.random() > READ_WITHOUT_REPLY_PROBABILITY) return false;

    try {
      await withDiscordRetry('reaction-read-without-reply', () =>
        msg.react(pickReadWithoutReplyEmoji()),
      );
      return true;
    } catch (error) {
      logger.debug(
        { error, channelId: msg.channelId, messageId: msg.id },
        'Failed read-without-reply reaction',
      );
      return false;
    }
  };

  const shouldSelectivelySilence = (params: {
    sourceItem: QueuedConversationMessage;
    inboundHistory: PendingGuildHistoryEntry[];
    behavior: ResolvedChannelBehavior;
  }): boolean => {
    if (!params.sourceItem.msg.guild) return false;
    if (params.behavior.guildMessageMode !== 'free') return false;
    if (params.sourceItem.wasExplicitlyAddressed) return false;

    const nowMs = Date.now();
    const peerMessages = params.inboundHistory
      .filter(
        (entry) =>
          !entry.isBot &&
          entry.userId !== params.sourceItem.msg.author.id &&
          nowMs - entry.timestampMs <= SELECTIVE_SILENCE_RECENT_WINDOW_MS,
      )
      .sort((a, b) => a.timestampMs - b.timestampMs);
    if (peerMessages.length === 0) return false;

    const sourceText = params.sourceItem.content.trim();
    const asksQuestion = sourceText.includes('?');
    const latestPeer =
      peerMessages[peerMessages.length - 1]?.content?.trim().toLowerCase() ||
      '';
    const peerLooksLikeAnswer =
      latestPeer.length >= 24 ||
      /\\b(you can|try|use|it is|it's|because|should|here|answer|fix)\\b/.test(
        latestPeer,
      );
    const probability =
      asksQuestion && peerLooksLikeAnswer
        ? SELECTIVE_SILENCE_ACTIVE_CHAT_PROBABILITY
        : SELECTIVE_SILENCE_BASE_PROBABILITY;
    return Math.random() < probability;
  };

  const intents: GatewayIntentBits[] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ];
  if (DISCORD_GUILD_MEMBERS_INTENT)
    intents.push(GatewayIntentBits.GuildMembers);
  if (DISCORD_PRESENCE_INTENT) intents.push(GatewayIntentBits.GuildPresences);

  client = new Client({
    intents,
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
    ],
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
    startupConnectedAtMs = Date.now();
    if (client.user) {
      botMentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    }
    presenceController?.stop();
    presenceController = new DiscordAutoPresenceController({
      client,
      getConfig: () => DISCORD_SELF_PRESENCE,
      resolveState: resolvePresenceHealthState,
    });
    presenceController.start();
    void ensureSlashCommands();
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('reset:')) {
      const interactionVisibility = interaction.guildId
        ? { flags: 'Ephemeral' as const }
        : {};
      const parsed = parseResetConfirmationCustomId(interaction.customId);
      if (!parsed) {
        await interaction.reply({
          content: 'Invalid button.',
          ...interactionVisibility,
        });
        return;
      }
      if (interaction.user.id !== parsed.userId) {
        await interaction.reply({
          content: 'Only the requesting user can respond.',
          ...interactionVisibility,
        });
        return;
      }
      const guildId = interaction.guildId ?? null;
      const channelId = interaction.channelId;
      await interaction.deferReply(interactionVisibility);
      try {
        await commandHandler(
          parsed.sessionId,
          guildId,
          channelId,
          interaction.user.id,
          interaction.user.username,
          ['reset', parsed.action],
          async (text, files, components) => {
            await interaction.followUp({
              content: text,
              ...(files?.length ? { files } : {}),
              ...(components?.length ? { components } : {}),
              ...interactionVisibility,
            });
          },
        );
        await disableApprovalButtons(
          interaction.message as DiscordMessage,
        ).catch(() => {});
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, guildId, channelId, userId: interaction.user.id },
          'Discord reset button failed',
        );
        await interaction.followUp({
          content: formatError('Gateway Error', detail),
          ...interactionVisibility,
        });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('approve:')) {
      const interactionVisibility = interaction.guildId
        ? { flags: 'Ephemeral' as const }
        : {};
      const parsed = parseApprovalCustomId(interaction.customId);
      if (!parsed) {
        await interaction.reply({
          content: 'Invalid button.',
          ...interactionVisibility,
        });
        return;
      }
      const pending = claimPendingApprovalByApprovalId({
        approvalId: parsed.approvalId,
        userId: interaction.user.id,
      });
      if (pending.status === 'not_found') {
        await interaction.reply({
          content: 'This approval has expired or was already handled.',
          ...interactionVisibility,
        });
        return;
      }
      if (pending.status === 'unauthorized') {
        await interaction.reply({
          content: 'Only the requesting user can respond.',
          ...interactionVisibility,
        });
        return;
      }
      if (pending.status === 'already_handled') {
        await interaction.reply({
          content: 'This approval has already been handled.',
          ...interactionVisibility,
        });
        return;
      }
      const guildId = interaction.guildId ?? null;
      const channelId = interaction.channelId;
      await interaction.deferReply(interactionVisibility);
      await disableApprovalButtons(interaction.message as DiscordMessage).catch(
        () => {},
      );
      try {
        await commandHandler(
          pending.sessionId,
          guildId,
          channelId,
          interaction.user.id,
          interaction.user.username,
          ['approve', parsed.action, parsed.approvalId],
          async (text, files, components) => {
            await interaction.followUp({
              content: text,
              ...(files?.length ? { files } : {}),
              ...(components?.length ? { components } : {}),
              ...interactionVisibility,
            });
          },
        );
        await pending.entry.disableButtons?.().catch(() => {});
      } catch (error) {
        pending.entry.resolvedAt = null;
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, guildId, channelId, userId: interaction.user.id },
          'Discord approval button failed',
        );
        await interaction.followUp({
          content: formatError('Gateway Error', detail),
          ...interactionVisibility,
        });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (
      interaction.guildId &&
      !isAuthorizedCommandUserId(interaction.user.id)
    ) {
      await sendChunkedInteractionReply(
        interaction,
        'You are not authorized to run commands for this bot.',
      );
      return;
    }

    const guildId = interaction.guildId ?? null;
    const channelId = interaction.channelId;
    const sessionId = buildSessionIdFromContext(
      guildId,
      channelId,
      interaction.user.id,
    );
    const args = parseSlashInteractionArgs(interaction);
    if (!args) {
      await sendChunkedInteractionReply(
        interaction,
        'This command can only be used in a server channel with valid options.',
      );
      return;
    }
    if (
      shouldDenyCompactCommand({
        args,
        inGuild: Boolean(interaction.guildId),
        permissions: interaction.memberPermissions,
      })
    ) {
      await sendChunkedInteractionReply(
        interaction,
        COMPACT_PERMISSION_DENIED_MESSAGE,
      );
      return;
    }
    try {
      await commandHandler(
        sessionId,
        guildId,
        channelId,
        interaction.user.id,
        interaction.user.username,
        args,
        async (text, files, components) =>
          sendChunkedInteractionReply(interaction, text, files, components),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(
        { error, guildId, channelId, userId: interaction.user.id },
        'Discord slash command failed',
      );
      await sendChunkedInteractionReply(
        interaction,
        formatError('Gateway Error', detail),
      );
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
    const behavior = sourceItem.behavior;
    const startedAt = Date.now();
    let releaseChannelSlot: (() => void) | null = null;

    const batchedContent =
      items.length > 1
        ? items
            .map((item, index) => `Message ${index + 1}:\n${item.content}`)
            .join('\n\n')
        : sourceItem.content;
    const channelInfoContext = buildChannelInfoContext(msg);
    const replyContext = await buildReplyContext(msg);
    const feedbackNote = negativeFeedbackByChannel.get(channelId) || '';
    if (feedbackNote) {
      negativeFeedbackByChannel.delete(channelId);
    }
    const currentBatchMessageIds = new Set(items.map((item) => item.msg.id));
    const inboundHistory = await buildInboundHistorySnapshot(
      msg,
      currentBatchMessageIds,
    );
    const attachmentContext = await buildAttachmentContext(
      items.map((item) => item.msg),
    );
    const rememberedParticipants = participantMemoryByChannel.get(
      msg.channelId,
    );
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
    const selectiveSilence = shouldSelectivelySilence({
      sourceItem,
      inboundHistory: inboundHistory.entries,
      behavior,
    });
    logger.debug(
      {
        batchKey,
        sessionId,
        channelId,
        userId,
        messageCount: items.length,
        contentLength: combinedContent.length,
        mediaCount: attachmentContext.media.length,
        selectiveSilence,
      },
      'Dispatching Discord conversation batch',
    );

    const abortController = new AbortController();
    const typingController = pending.typingController;
    const lifecycleController = pending.lifecycleController;
    const emitLifecyclePhase = (phase: LifecyclePhase): void => {
      if (phase === 'queued') {
        typingController.setPhase('received');
      } else if (phase === 'thinking') {
        typingController.setPhase('thinking');
      } else if (phase === 'toolUse') {
        typingController.setPhase('toolUse');
      } else if (phase === 'streaming') {
        typingController.setPhase('streaming');
      } else {
        typingController.setPhase('done');
      }
      lifecycleController?.setPhase(phase);
    };

    const stream = new DiscordStreamManager(msg, {
      onFirstMessage: () => emitLifecyclePhase('streaming'),
      humanDelay: behavior.humanDelay,
    });
    const inFlight: InFlightConversation = {
      abortController,
      stream,
      messageIds: new Set(items.map((item) => item.msg.id)),
      aborted: false,
      emitLifecyclePhase,
    };
    for (const messageId of inFlight.messageIds) {
      inFlightByMessageId.set(messageId, inFlight);
    }

    try {
      if (selectiveSilence) {
        emitLifecyclePhase('done');
        if (Math.random() < 0.5) {
          await withDiscordRetry('reaction-selective-silence', () =>
            msg.react(pickReadWithoutReplyEmoji()),
          ).catch(() => {});
        }
        recordConversationMetric({
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        logger.debug(
          {
            batchKey,
            sessionId,
            channelId,
            durationMs: Date.now() - startedAt,
          },
          'Discord conversation batch selectively silenced',
        );
        return;
      }

      releaseChannelSlot = await waitForChannelConcurrencySlot(
        channelId,
        behavior.maxConcurrentPerChannel,
        abortController.signal,
      );
      if (abortController.signal.aborted) {
        return;
      }
      activeConversationRuns += 1;
      const showMode = normalizeSessionShowMode(
        getSessionById(sessionId)?.show_mode,
      );
      if (sessionShowModeShowsThinking(showMode)) {
        emitLifecyclePhase('thinking');
      }
      void publishWorkflowEvent({
        kind: 'message',
        sourceChannel: 'discord',
        channelId,
        senderId: userId,
        content: combinedContent,
        timestamp: Number.isFinite(msg.createdTimestamp)
          ? msg.createdTimestamp
          : Date.now(),
      }).catch((error) => {
        logger.debug(
          { error, channelId, sessionId },
          'Failed to publish Discord workflow event',
        );
      });
      await messageHandler(
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        combinedContent,
        attachmentContext.media,
        async (text, files, components) => {
          emitLifecyclePhase('streaming');
          await sendChunkedReply(
            msg,
            text,
            files,
            components,
            mentionLookup,
            behavior.humanDelay,
          );
        },
        {
          sourceMessage: msg,
          batchedMessages: items.map((item) => item.msg),
          abortSignal: abortController.signal,
          stream,
          mentionLookup,
          emitLifecyclePhase,
          sendApprovalNotification: async ({ text, approvalId, userId }) => {
            const row = buildApprovalActionRow(approvalId);
            const sent = await withDiscordRetry('approval-notification', () =>
              msg.reply({
                content: `<@${userId}> ${text}`,
                components: [row],
              }),
            );
            return {
              disableButtons: () => disableApprovalButtons(sent),
            };
          },
        },
      );
      emitLifecyclePhase('done');
      recordConversationMetric({
        durationMs: Date.now() - startedAt,
        ok: true,
      });
      noteConversationExchange(sourceItem.cooldownKey);
      logger.debug(
        {
          batchKey,
          sessionId,
          channelId,
          durationMs: Date.now() - startedAt,
        },
        'Discord conversation batch completed',
      );
    } catch (error) {
      if (abortController.signal.aborted || inFlight.aborted) {
        logger.debug(
          { channelId, sessionId },
          'Conversation batch aborted before completion',
        );
        return;
      }
      emitLifecyclePhase('error');
      recordConversationMetric({
        durationMs: Date.now() - startedAt,
        ok: false,
        error,
      });
      logger.error(
        { error, channelId, sessionId },
        'Conversation batch handling failed',
      );
      const detail = error instanceof Error ? error.message : String(error);
      if (stream.hasSentMessages()) {
        await stream.fail(formatError('Gateway Error', detail));
      } else {
        await sendChunkedReply(
          msg,
          formatError('Gateway Error', detail),
          undefined,
          undefined,
          mentionLookup,
          behavior.humanDelay,
        );
      }
    } finally {
      activeConversationRuns = Math.max(0, activeConversationRuns - 1);
      if (releaseChannelSlot) {
        releaseChannelSlot();
      }
      for (const messageId of inFlight.messageIds) {
        if (inFlightByMessageId.get(messageId) === inFlight) {
          inFlightByMessageId.delete(messageId);
        }
      }
      typingController.stop();
      await Promise.all(
        items.map(async (item) => {
          await item.clearAckReaction();
        }),
      );
    }
  };

  const queueConversationMessage = async (
    msg: DiscordMessage,
    content: string,
    behavior: ResolvedChannelBehavior,
  ): Promise<void> => {
    const key = `${msg.channelId}:${msg.author.id}`;
    const cooldownKey = buildConversationCooldownKey(
      msg.channelId,
      msg.author.id,
    );
    const adjustedHumanDelay = resolveHumanDelayWithBehavior(
      behavior.humanDelay,
      cooldownKey,
    );
    const queuedBehavior: ResolvedChannelBehavior = {
      ...behavior,
      humanDelay: adjustedHumanDelay,
    };
    const wasExplicitlyAddressed =
      !msg.guild ||
      hasPrefixInvocation(msg.content || '') ||
      Boolean(client.user && msg.mentions.has(client.user)) ||
      Boolean(client.user && msg.mentions.repliedUser?.id === client.user.id);

    let clearAckReaction: () => Promise<void> = async () => {};
    if (client.user && shouldApplyAckReaction(msg, behavior)) {
      const clearReaction = await addAckReaction({
        message: msg,
        emoji: behavior.ackReaction,
        withRetry: withDiscordRetry,
        botUserId: client.user.id,
      });
      clearAckReaction = behavior.removeAckAfterReply
        ? clearReaction
        : async () => {};
    }
    const queued: QueuedConversationMessage = {
      msg,
      content,
      behavior: queuedBehavior,
      clearAckReaction,
      wasExplicitlyAddressed,
      cooldownKey,
    };
    const existing = pendingBatches.get(key);
    const shouldDebounceMessage = shouldDebounceInbound({
      content: msg.content || '',
      hasAttachments: msg.attachments.size > 0,
      isPrefixedCommand: hasPrefixInvocation(msg.content || ''),
    });

    if (!existing) {
      const typingController = createTypingController(msg, behavior.typingMode);
      typingController.setPhase('received');
      const lifecycleController =
        client.user && DISCORD_LIFECYCLE_REACTIONS.enabled
          ? new LifecycleReactionController({
              message: msg,
              withRetry: withDiscordRetry,
              botUserId: client.user.id,
              config: {
                enabled: DISCORD_LIFECYCLE_REACTIONS.enabled,
                removeOnComplete: DISCORD_LIFECYCLE_REACTIONS.removeOnComplete,
                phases: DISCORD_LIFECYCLE_REACTIONS.phases,
              },
            })
          : null;
      lifecycleController?.setPhase('queued');
      const baseDelayMs = shouldDebounceMessage ? behavior.debounceMs : 0;
      const startupStaggerMs =
        startupConnectedAtMs > 0 &&
        Date.now() - startupConnectedAtMs < STARTUP_STAGGER_WINDOW_MS &&
        !wasExplicitlyAddressed
          ? randomIntInRange(
              STARTUP_STAGGER_MIN_DELAY_MS,
              STARTUP_STAGGER_MAX_DELAY_MS,
            )
          : 0;
      const delayMs = baseDelayMs + startupStaggerMs;
      logger.debug(
        {
          batchKey: key,
          channelId: msg.channelId,
          userId: msg.author.id,
          messageId: msg.id,
          debounceMs: delayMs,
          contentLength: content.length,
          shouldDebounceMessage,
          queuedMessages: 1,
        },
        'Queued Discord conversation batch',
      );
      const timer = setTimeout(() => {
        void dispatchConversationBatch(key);
      }, delayMs);
      pendingBatches.set(key, {
        items: [queued],
        timer,
        typingController,
        lifecycleController,
      });
      return;
    }

    existing.typingController.setPhase('received');
    existing.lifecycleController?.setPhase('queued');
    clearTimeout(existing.timer);
    existing.items.push(queued);
    const shouldFlushImmediately =
      !shouldDebounceMessage ||
      existing.items.length >= DEFAULT_DEBOUNCE_MAX_BUFFER;
    const baseDelayMs = shouldFlushImmediately ? 0 : behavior.debounceMs;
    const startupStaggerMs =
      startupConnectedAtMs > 0 &&
      Date.now() - startupConnectedAtMs < STARTUP_STAGGER_WINDOW_MS &&
      !wasExplicitlyAddressed
        ? randomIntInRange(
            STARTUP_STAGGER_MIN_DELAY_MS,
            STARTUP_STAGGER_MAX_DELAY_MS,
          )
        : 0;
    const delayMs = baseDelayMs + startupStaggerMs;
    logger.debug(
      {
        batchKey: key,
        channelId: msg.channelId,
        userId: msg.author.id,
        messageId: msg.id,
        debounceMs: delayMs,
        contentLength: content.length,
        shouldDebounceMessage,
        queuedMessages: existing.items.length + 1,
      },
      'Updated queued Discord conversation batch',
    );
    existing.timer = setTimeout(() => {
      void dispatchConversationBatch(key);
    }, delayMs);
  };

  const dropPendingMessage = async (messageId: string): Promise<void> => {
    for (const [key, pending] of pendingBatches) {
      const index = pending.items.findIndex(
        (item) => item.msg.id === messageId,
      );
      if (index === -1) continue;
      const [removed] = pending.items.splice(index, 1);
      await removed.clearAckReaction();
      if (pending.items.length === 0) {
        clearTimeout(pending.timer);
        pending.typingController.stop();
        await pending.lifecycleController?.clear();
        pendingBatches.delete(key);
      }
      return;
    }
  };

  const updatePendingMessage = async (
    messageId: string,
    nextMsg: DiscordMessage,
    nextContent: string,
    nextBehavior: ResolvedChannelBehavior,
  ): Promise<boolean> => {
    for (const [key, pending] of pendingBatches) {
      const index = pending.items.findIndex(
        (item) => item.msg.id === messageId,
      );
      if (index === -1) continue;

      if (!nextContent) {
        const [removed] = pending.items.splice(index, 1);
        await removed.clearAckReaction();
      } else {
        pending.items[index].msg = nextMsg;
        pending.items[index].content = nextContent;
        pending.items[index].behavior = nextBehavior;
        pending.items[index].wasExplicitlyAddressed =
          !nextMsg.guild ||
          hasPrefixInvocation(nextMsg.content || '') ||
          Boolean(client.user && nextMsg.mentions.has(client.user));
        pending.items[index].cooldownKey = buildConversationCooldownKey(
          nextMsg.channelId,
          nextMsg.author.id,
        );
      }

      if (pending.items.length === 0) {
        clearTimeout(pending.timer);
        pending.typingController.stop();
        await pending.lifecycleController?.clear();
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
    const behavior = resolveChannelBehavior(msg);
    const content = cleanIncomingContent(msg.content);
    observeMessageParticipants(msg, content);
    const immediateMentionLookup = buildMentionLookup(
      [msg],
      [],
      msg.guild ? participantMemoryByChannel.get(msg.channelId) : undefined,
    );

    const reply: ReplyFn = async (text, files, components) => {
      await sendChunkedReply(
        msg,
        text,
        files,
        components,
        immediateMentionLookup,
        behavior.humanDelay,
      );
    };
    const commandReply: ReplyFn = async (text, files, components) => {
      try {
        await sendChunkedDirectReply(
          msg,
          text,
          files,
          components,
          immediateMentionLookup,
          behavior.humanDelay,
        );
      } catch (error) {
        logger.warn(
          { error, userId: msg.author.id, channelId: msg.channelId },
          'Failed to send command reply via DM; command response dropped',
        );
      }
    };

    const parsed = parseCommand(msg.content);
    const hasPrefixedInvocation = hasPrefixInvocation(msg.content);
    const hasSlashInvocation = hasSlashCommandInvocation(msg.content);
    const hasCommandInvocation = hasPrefixedInvocation || hasSlashInvocation;
    logger.debug(
      {
        sessionId,
        guildId,
        channelId,
        messageId: msg.id,
        userId: msg.author.id,
        contentLength: content.length,
        hasCommandInvocation,
        guildMessageMode: behavior.guildMessageMode,
        typingMode: behavior.typingMode,
      },
      'Received Discord message',
    );
    if (DISCORD_COMMANDS_ONLY) {
      if (!hasCommandInvocation) return;
      if (msg.guild && !isAuthorizedCommandUserId(msg.author.id)) {
        logger.debug(
          { userId: msg.author.id, channelId: msg.channelId },
          'Ignoring unauthorized Discord command in commands-only mode',
        );
        return;
      }
      if (!parsed.isCommand) {
        if (!content) {
          await commandReply(`How can I help? Try \`${DISCORD_PREFIX} help\`.`);
        } else {
          await commandReply(
            `Unknown command. Try \`${DISCORD_PREFIX} help\`.`,
          );
        }
        return;
      }
      if (
        shouldDenyCompactCommand({
          args: [parsed.command, ...parsed.args],
          inGuild: Boolean(msg.guild),
          permissions: msg.member?.permissions,
        })
      ) {
        await commandReply(COMPACT_PERMISSION_DENIED_MESSAGE);
        return;
      }
      await commandHandler(
        sessionId,
        guildId,
        channelId,
        msg.author.id,
        msg.author.username,
        [parsed.command, ...parsed.args],
        commandReply,
      );
      return;
    }

    if (
      msg.guild &&
      hasCommandInvocation &&
      !isAuthorizedCommandUserId(msg.author.id)
    ) {
      logger.debug(
        { userId: msg.author.id, channelId: msg.channelId },
        'Ignoring unauthorized Discord prefixed command',
      );
      return;
    }

    if (!isTrigger(msg, behavior)) {
      logger.debug(
        {
          sessionId,
          guildId,
          channelId,
          messageId: msg.id,
          userId: msg.author.id,
          guildMessageMode: behavior.guildMessageMode,
        },
        'Ignoring Discord message because channel trigger conditions were not met',
      );
      return;
    }

    if (parsed.isCommand && hasCommandInvocation) {
      if (
        shouldDenyCompactCommand({
          args: [parsed.command, ...parsed.args],
          inGuild: Boolean(msg.guild),
          permissions: msg.member?.permissions,
        })
      ) {
        await commandReply(COMPACT_PERMISSION_DENIED_MESSAGE);
        return;
      }
      await commandHandler(
        sessionId,
        guildId,
        channelId,
        msg.author.id,
        msg.author.username,
        [parsed.command, ...parsed.args],
        commandReply,
      );
      return;
    }

    if (!shouldHandleFreeModeMessage(msg, behavior, content)) {
      logger.debug(
        { channelId: msg.channelId, messageId: msg.id, userId: msg.author.id },
        'Skipping Discord free-mode message by relevance/mention gate',
      );
      return;
    }

    if (!content) {
      await reply('How can I help? Send me a message or try `!claw help`.');
      return;
    }

    const readWithoutReplyHandled = await maybeHandleReadWithoutReply(
      msg,
      content,
    );
    if (readWithoutReplyHandled) {
      return;
    }

    const rateLimitAllowed = await enforcePerUserRateLimit(msg, behavior);
    if (!rateLimitAllowed) return;

    await queueConversationMessage(msg, content, behavior);
  });

  client.on('messageUpdate', async (_oldMsg, nextMsg) => {
    if (DISCORD_COMMANDS_ONLY) return;
    const fetched = nextMsg.partial
      ? await nextMsg.fetch().catch(() => null)
      : nextMsg;
    if (!fetched) return;
    if (fetched.author?.bot) return;

    const updatedContent = cleanIncomingContent(fetched.content || '');
    const behavior = resolveChannelBehavior(fetched);
    observeMessageParticipants(fetched, updatedContent);
    if (!isTrigger(fetched, behavior)) {
      await updatePendingMessage(fetched.id, fetched, '', behavior);
      return;
    }
    if (
      hasPrefixInvocation(fetched.content || '') &&
      !isAuthorizedCommandUserId(fetched.author.id)
    ) {
      await updatePendingMessage(fetched.id, fetched, '', behavior);
      return;
    }
    if (!shouldHandleFreeModeMessage(fetched, behavior, updatedContent)) {
      await updatePendingMessage(fetched.id, fetched, '', behavior);
      return;
    }
    await updatePendingMessage(fetched.id, fetched, updatedContent, behavior);

    const inFlight = inFlightByMessageId.get(fetched.id);
    if (!inFlight || inFlight.aborted) return;
    inFlight.aborted = true;
    inFlight.abortController.abort();
    inFlight.emitLifecyclePhase('error');
    for (const messageId of inFlight.messageIds) {
      if (inFlightByMessageId.get(messageId) === inFlight) {
        inFlightByMessageId.delete(messageId);
      }
    }
    await inFlight.stream.discard();
    if (updatedContent) {
      const rateLimitAllowed = await enforcePerUserRateLimit(fetched, behavior);
      if (!rateLimitAllowed) return;
      await queueConversationMessage(fetched, updatedContent, behavior);
    }
  });

  client.on('messageDelete', async (msg) => {
    await dropPendingMessage(msg.id);
    const inFlight = inFlightByMessageId.get(msg.id);
    if (!inFlight || inFlight.aborted) return;
    inFlight.aborted = true;
    inFlight.abortController.abort();
    inFlight.emitLifecyclePhase('error');
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

    const message = fullReaction.message.partial
      ? await fullReaction.message.fetch().catch(() => null)
      : fullReaction.message;
    if (!message) return;

    void publishDiscordReactionWorkflowEvent({
      channelId: message.channelId,
      senderId: user.id,
      reactionEmoji: fullReaction.emoji.name || fullReaction.emoji.toString(),
      content: cleanIncomingContent(message.content || ''),
    }).catch((error) => {
      logger.debug(
        { error, channelId: message.channelId, userId: user.id },
        'Failed to publish Discord workflow reaction event',
      );
    });

    const sentiment = classifyDiscordSkillFeedbackSentiment(
      fullReaction.emoji.name,
    );
    if (!sentiment) return;
    if (!client.user || message.author?.id !== client.user.id) return;

    const feedback = formatDiscordSkillFeedbackMessage({
      emojiName: fullReaction.emoji.name || '',
      username: user.username || 'unknown-user',
      messageId: message.id,
    });
    if (sentiment === 'negative') {
      negativeFeedbackByChannel.set(message.channelId, feedback);
    }
    recordSkillFeedback({
      sessionId: resolveSessionIdCompat(
        resolveDiscordSkillFeedbackSessionId({
          guildId: message.guild?.id ?? null,
          channelId: message.channelId,
          userId: user.id,
        }),
      ),
      feedback,
      sentiment,
    });
  });

  if (!DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN is required to start the Discord bot');
  }
  client.login(DISCORD_TOKEN);
  return client;
}

export async function setDiscordMaintenancePresence(): Promise<void> {
  if (!presenceController) return;
  await presenceController.setMaintenance();
}

export function getDiscordChannelDisplayName(
  guildId: string | null | undefined,
  channelId: string | null | undefined,
): string | null {
  const normalizedChannelId =
    typeof channelId === 'string' ? channelId.trim() : '';
  if (!normalizedChannelId) return null;

  const activeClient = client as Client | undefined;
  if (!activeClient?.isReady()) return null;

  const cachedGuild =
    guildId && activeClient.guilds.cache.has(guildId)
      ? activeClient.guilds.cache.get(guildId)
      : null;
  const cachedChannel =
    cachedGuild?.channels.cache.get(normalizedChannelId) ??
    activeClient.channels.cache.get(normalizedChannelId);
  if (!cachedChannel || typeof cachedChannel !== 'object') return null;

  const rawName =
    'name' in cachedChannel && typeof cachedChannel.name === 'string'
      ? cachedChannel.name.trim()
      : '';
  if (!rawName) return null;

  return rawName.startsWith('#') ? rawName : `#${rawName}`;
}

/**
 * Send a message to a channel by ID (used by scheduler).
 */
export async function sendToChannel(
  channelId: string,
  text: string,
  files?: AttachmentBuilder[],
): Promise<void> {
  const activeClient = await requireDiscordClientReady();
  const channel = await activeClient.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    throw new Error(`Channel ${channelId} does not support sending messages.`);
  }

  if (
    'permissionsFor' in channel &&
    typeof channel.permissionsFor === 'function' &&
    'guild' in channel
  ) {
    const me =
      channel.guild?.members?.me ||
      (typeof channel.guild?.members?.fetchMe === 'function'
        ? await channel.guild.members.fetchMe().catch(() => null)
        : null);
    const permissions = me ? channel.permissionsFor(me) : null;
    if (!permissions) {
      throw new Error(
        `Unable to resolve bot permissions for channel ${channelId}.`,
      );
    }
    const requiredPermissions = [
      { label: 'ViewChannel', flag: PermissionFlagsBits.ViewChannel },
      { label: 'SendMessages', flag: PermissionFlagsBits.SendMessages },
    ];
    if (typeof channel.isThread === 'function' && channel.isThread()) {
      requiredPermissions.push({
        label: 'SendMessagesInThreads',
        flag: PermissionFlagsBits.SendMessagesInThreads,
      });
    }
    const missingPermissions = requiredPermissions
      .filter(({ flag }) => !permissions.has(flag))
      .map(({ label }) => label);
    if (missingPermissions.length > 0) {
      throw new Error(
        `Missing Discord permissions for channel ${channelId}: ${missingPermissions.join(', ')}`,
      );
    }
  }

  const payloads = prepareChunkedPayloads(text, files);
  const sendableChannel = channel as unknown as {
    send: (payload: {
      content: string;
      files?: AttachmentBuilder[];
    }) => Promise<void>;
  };
  for (const payload of payloads) {
    await withDiscordRetry('send-channel', () => sendableChannel.send(payload));
  }
}
