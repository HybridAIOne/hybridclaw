export interface ParsedCommand {
  isCommand: boolean;
  command: string;
  args: string[];
}

export type DiscordGuildMessageMode = 'off' | 'mention' | 'free';
export type DiscordCommandAccessMode = 'public' | 'restricted';
const KNOWN_SUBCOMMANDS = new Set([
  'bot',
  'rag',
  'model',
  'status',
  'approve',
  'usage',
  'export',
  'sessions',
  'audit',
  'schedule',
  'channel',
  'ralph',
  'clear',
  'help',
]);

const GREETING_ONLY_RE =
  /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|got it|roger|cool)[!. ]*$/i;
const FREE_MODE_ACK_ONLY_RE =
  /^(ok|okay|thanks|thank you|thx|ty|cool|nice|got it|roger|sounds good|sgtm|lol|lmao)[!. ]*$/i;
const FREE_MODE_QUESTION_START_RE =
  /^(?:hey|hi|hello|yo|hmm|hm|well)?[\s,:-]*(?:can|could|would|will|should|do|does|did|is|are|am|how|what|why|when|where|who|which)\b/i;
const FREE_MODE_REQUEST_VERB_RE =
  /\b(?:please|pls|help|explain|review|check|debug|fix|summari[sz]e|create|write|show|tell|give|generate|compare|analy[sz]e)\b/i;
const FREE_MODE_PROBLEM_SIGNAL_RE =
  /\b(?:error|failed|failure|exception|stack trace|broken|issue|not working|doesn't work|cannot|can't|wont|won't)\b/i;
const URL_ONLY_RE = /^https?:\/\/\S+$/i;
const FREE_MODE_CHANNEL_ADDRESS_RE =
  /\b(?:all|everyone|anyone|team|folks|guys|channel|chat|alle|zusammen|jemand)\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAlias(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function hasLooseBotMention(
  content: string,
  botAliases: string[],
): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;

  for (const rawAlias of botAliases) {
    const alias = normalizeAlias(rawAlias);
    if (!alias || alias.length < 2) continue;
    if (!/^[\p{L}\p{N}._-]+$/u.test(alias)) continue;

    const escapedAlias = escapeRegex(alias);
    const mentionRe = new RegExp(
      `(?:^|[^\\p{L}\\p{N}_-])${escapedAlias}(?=$|[^\\p{L}\\p{N}_-])`,
      'iu',
    );
    if (mentionRe.test(normalized)) return true;
  }

  return false;
}

export function isAddressedToChannel(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return FREE_MODE_CHANNEL_ADDRESS_RE.test(normalized);
}

export function stripBotMentions(
  text: string,
  botMentionRegex: RegExp | null,
): string {
  if (!botMentionRegex) return text;
  return text.replace(botMentionRegex, '').trim();
}

export function cleanIncomingContent(
  content: string,
  botMentionRegex: RegExp | null,
  prefix: string,
): string {
  let text = stripBotMentions(content, botMentionRegex);
  if (text.startsWith(prefix)) {
    text = text.slice(prefix.length).trim();
  }
  return text;
}

export function hasPrefixInvocation(
  content: string,
  botMentionRegex: RegExp | null,
  prefix: string,
): boolean {
  const text = stripBotMentions(content, botMentionRegex);
  return text.startsWith(prefix);
}

export function hasSlashCommandInvocation(
  content: string,
  botMentionRegex: RegExp | null,
): boolean {
  const text = stripBotMentions(content, botMentionRegex).trim();
  if (!text.startsWith('/')) return false;
  const token = text.slice(1).split(/\s+/)[0]?.toLowerCase() || '';
  if (!token) return false;
  return KNOWN_SUBCOMMANDS.has(token);
}

export function buildSessionIdFromContext(
  guildId: string | null,
  channelId: string,
  userId: string,
): string {
  return guildId ? `${guildId}:${channelId}` : `dm:${userId}`;
}

export function parseCommand(
  content: string,
  botMentionRegex: RegExp | null,
  prefix: string,
): ParsedCommand {
  let text = stripBotMentions(content, botMentionRegex);
  if (text.startsWith(prefix)) {
    text = text.slice(prefix.length).trim();
  } else if (text.startsWith('/')) {
    text = text.slice(1).trim();
  }

  const parts = text.split(/\s+/);
  if (parts.length > 0 && KNOWN_SUBCOMMANDS.has(parts[0].toLowerCase())) {
    return {
      isCommand: true,
      command: parts[0].toLowerCase(),
      args: parts.slice(1),
    };
  }

  return { isCommand: false, command: '', args: [] };
}

export function shouldSuppressAutoReply(
  content: string,
  suppressPatterns?: string[],
): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;
  if (GREETING_ONLY_RE.test(normalized)) return true;
  if (!suppressPatterns || suppressPatterns.length === 0) return false;
  return suppressPatterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    if (!needle) return false;
    return normalized.includes(needle);
  });
}

export function shouldSkipFreeReplyBecauseOtherUsersMentioned(params: {
  guildMessageMode: DiscordGuildMessageMode;
  hasBotMention: boolean;
  hasPrefixInvocation: boolean;
  botUserId: string | null;
  mentionedUserIds: string[];
}): boolean {
  if (params.guildMessageMode !== 'free') return false;
  if (params.hasBotMention) return false;
  if (params.hasPrefixInvocation) return false;
  if (params.mentionedUserIds.length === 0) return false;

  const botId = params.botUserId?.trim() || '';
  return params.mentionedUserIds.some((userId) => userId !== botId);
}

export function shouldReplyInFreeMode(params: {
  guildMessageMode: DiscordGuildMessageMode;
  content: string;
  hasBotMention: boolean;
  hasLooseBotMention?: boolean;
  isAddressedToChannel?: boolean;
  hasPrefixInvocation: boolean;
  isReplyToBot: boolean;
  hasAttachments: boolean;
}): boolean {
  if (params.guildMessageMode !== 'free') return true;
  if (params.hasPrefixInvocation) return true;
  if (params.hasBotMention) return true;
  if (params.hasLooseBotMention) return true;
  if (params.isReplyToBot) return true;
  if (params.hasAttachments) return true;

  const normalized = params.content.trim();
  if (!normalized) return false;
  if (FREE_MODE_ACK_ONLY_RE.test(normalized)) return false;
  if (URL_ONLY_RE.test(normalized)) return false;
  if (params.isAddressedToChannel) return true;
  if (normalized.includes('?')) return true;
  if (FREE_MODE_QUESTION_START_RE.test(normalized)) return true;
  if (FREE_MODE_REQUEST_VERB_RE.test(normalized)) return true;
  if (FREE_MODE_PROBLEM_SIGNAL_RE.test(normalized)) return true;
  if (normalized.includes('```') || /`[^`]+`/.test(normalized)) return true;
  return false;
}

export function isAuthorizedCommandUser(params: {
  mode: DiscordCommandAccessMode;
  userId: string;
  allowedUserIds: string[];
  legacyCommandUserId?: string;
}): boolean {
  if (params.mode === 'public') return true;
  const allowed = new Set(
    params.allowedUserIds.map((entry) => entry.trim()).filter(Boolean),
  );
  const legacy = (params.legacyCommandUserId || '').trim();
  if (legacy) allowed.add(legacy);
  if (allowed.size === 0) return false;
  return allowed.has(params.userId);
}

export function isTrigger(params: {
  content: string;
  isDm: boolean;
  commandsOnly: boolean;
  respondToAllMessages: boolean;
  guildMessageMode: DiscordGuildMessageMode;
  prefix: string;
  botMentionRegex: RegExp | null;
  hasBotMention: boolean;
  suppressPatterns?: string[];
}): boolean {
  const stripped = stripBotMentions(params.content, params.botMentionRegex);
  const hasPrefixed = hasPrefixInvocation(
    params.content,
    params.botMentionRegex,
    params.prefix,
  );
  const hasSlash = hasSlashCommandInvocation(
    params.content,
    params.botMentionRegex,
  );

  if (params.commandsOnly) {
    return hasPrefixed || hasSlash;
  }
  if (hasPrefixed || hasSlash) return true;
  if (shouldSuppressAutoReply(stripped, params.suppressPatterns)) return false;
  if (params.isDm) return true;
  if (params.guildMessageMode === 'off') return false;
  if (params.guildMessageMode === 'free') return true;
  // Keep `respondToAllMessages` consumed for compatibility; mode resolution decides guild behavior.
  void params.respondToAllMessages;
  if (params.hasBotMention) return true;
  return false;
}
