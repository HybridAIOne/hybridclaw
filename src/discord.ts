import {
  Client,
  GatewayIntentBits,
  type Message as DiscordMessage,
  Partials,
} from 'discord.js';

import { DISCORD_PREFIX, DISCORD_TOKEN } from './config.js';
import { logger } from './logger.js';

export type ReplyFn = (content: string) => Promise<void>;

export type MessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  reply: ReplyFn,
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

/**
 * Format an agent response as plain text.
 * Appends a subtle tools line if any tools were used.
 */
export function buildResponseText(text: string, toolsUsed?: string[]): string {
  let body = text.slice(0, 2000);
  if (toolsUsed && toolsUsed.length > 0) {
    const toolsLine = `\n*Tools: ${toolsUsed.join(', ')}*`;
    body = text.slice(0, 2000 - toolsLine.length) + toolsLine;
  }
  return body;
}

export function formatInfo(title: string, body: string): string {
  return `**${title}**\n${body}`.slice(0, 2000);
}

export function formatError(title: string, detail: string): string {
  return `**${title}:** ${detail}`.slice(0, 2000);
}

function getSessionId(msg: DiscordMessage): string {
  return msg.guild ? `${msg.guild.id}:${msg.channelId}` : `dm:${msg.author.id}`;
}

function isTrigger(msg: DiscordMessage): boolean {
  if (client.user && msg.mentions.has(client.user)) return true;
  if (msg.content.startsWith(DISCORD_PREFIX)) return true;
  if (!msg.guild) return true;
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
  const subcommands = ['bot', 'rag', 'model', 'status', 'sessions', 'audit', 'schedule', 'help'];

  if (parts.length > 0 && subcommands.includes(parts[0].toLowerCase())) {
    return { isCommand: true, command: parts[0].toLowerCase(), args: parts.slice(1) };
  }

  return { isCommand: false, command: '', args: [] };
}

export function initDiscord(onMessage: MessageHandler, onCommand: CommandHandler): Client {
  messageHandler = onMessage;
  commandHandler = onCommand;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.on('ready', () => {
    logger.info({ user: client.user?.tag }, 'Discord bot connected');
  });

  client.on('messageCreate', async (msg: DiscordMessage) => {
    if (msg.author.bot) return;
    if (!isTrigger(msg)) return;

    const sessionId = getSessionId(msg);
    const guildId = msg.guild?.id || null;
    const channelId = msg.channelId;

    const reply: ReplyFn = async (text) => {
      await msg.reply(text);
    };

    // Clean content (remove mention/prefix)
    let content = msg.content;
    if (client.user) {
      content = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    }
    if (content.startsWith(DISCORD_PREFIX)) {
      content = content.slice(DISCORD_PREFIX.length).trim();
    }

    const parsed = parseCommand(msg.content);

    if (parsed.isCommand) {
      await commandHandler(sessionId, guildId, channelId, [parsed.command, ...parsed.args], reply);
    } else {
      if (!content) {
        await reply('How can I help? Send me a message or try `!claw help`.');
        return;
      }
      if ('sendTyping' in msg.channel) await msg.channel.sendTyping();
      await messageHandler(sessionId, guildId, channelId, msg.author.id, msg.author.username, content, reply);
    }
  });

  if (!DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN is required to start the Discord bot');
  }
  client.login(DISCORD_TOKEN);
  return client;
}

export function getClient(): Client {
  return client;
}

/**
 * Send a message to a channel by ID (used by scheduler).
 */
export async function sendToChannel(channelId: string, text: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (channel && 'send' in channel) {
    await (channel as unknown as { send: (text: string) => Promise<void> }).send(text);
  }
}
