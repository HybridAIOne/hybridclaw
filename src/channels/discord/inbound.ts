export interface ParsedCommand {
  isCommand: boolean;
  command: string;
  args: string[];
}

export function stripBotMentions(text: string, botMentionRegex: RegExp | null): string {
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

export function buildSessionIdFromContext(guildId: string | null, channelId: string, userId: string): string {
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
  const subcommands = ['bot', 'rag', 'model', 'sessions', 'audit', 'schedule', 'clear', 'help'];
  if (parts.length > 0 && subcommands.includes(parts[0].toLowerCase())) {
    return { isCommand: true, command: parts[0].toLowerCase(), args: parts.slice(1) };
  }

  return { isCommand: false, command: '', args: [] };
}

export function isTrigger(params: {
  content: string;
  isDm: boolean;
  commandsOnly: boolean;
  respondToAllMessages: boolean;
  prefix: string;
  botMentionRegex: RegExp | null;
  hasBotMention: boolean;
}): boolean {
  if (params.commandsOnly) {
    return hasPrefixInvocation(params.content, params.botMentionRegex, params.prefix);
  }
  if (params.isDm) return true;
  if (params.respondToAllMessages) return true;
  if (params.hasBotMention) return true;
  return params.content.startsWith(params.prefix);
}
