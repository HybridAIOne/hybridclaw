export interface ParsedCommand {
  isCommand: boolean;
  command: string;
  args: string[];
}

export type DiscordGuildMessageMode = 'off' | 'mention' | 'free';

const GREETING_ONLY_RE =
  /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|got it|roger|cool)[!. ]*$/i;

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
  }

  const parts = text.split(/\s+/);
  const subcommands = [
    'bot',
    'rag',
    'model',
    'sessions',
    'audit',
    'schedule',
    'channel',
    'clear',
    'help',
  ];
  if (parts.length > 0 && subcommands.includes(parts[0].toLowerCase())) {
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

  if (params.commandsOnly) {
    return hasPrefixInvocation(
      params.content,
      params.botMentionRegex,
      params.prefix,
    );
  }
  if (
    hasPrefixInvocation(params.content, params.botMentionRegex, params.prefix)
  )
    return true;
  if (shouldSuppressAutoReply(stripped, params.suppressPatterns)) return false;
  if (params.isDm) return true;
  if (params.guildMessageMode === 'off') return false;
  if (params.guildMessageMode === 'free') return true;
  // Keep `respondToAllMessages` consumed for compatibility; mode resolution decides guild behavior.
  void params.respondToAllMessages;
  if (params.hasBotMention) return true;
  return false;
}
