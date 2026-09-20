/**
 * Discord thread-reply routing — resolves the channel for one inbound reply.
 *
 * This is not the general Discord thread tool: it only reuses or creates the
 * public thread attached to the triggering message and safely falls back.
 */

import {
  type Message as DiscordMessage,
  PermissionFlagsBits,
} from 'discord.js';
import type { DiscordReplyStyle } from '../../config/runtime-config.js';
import type { DiscordSendChannel } from './stream.js';

export interface DiscordReplyChannelResolution {
  channel: DiscordSendChannel | null;
  warning?: string;
}

export function resolveDiscordParentChannelId(
  msg: DiscordMessage,
): string | null {
  if (
    typeof msg.channel.isThread === 'function' &&
    msg.channel.isThread() &&
    msg.channel.parentId
  ) {
    return msg.channel.parentId;
  }
  return null;
}

export function deriveDiscordThreadName(msg: DiscordMessage): string {
  const content = (msg.cleanContent || msg.content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (content) return content.slice(0, 100);
  return `Reply to ${msg.author.username}`.slice(0, 100);
}

export async function resolveDiscordReplyChannel(params: {
  message: DiscordMessage;
  replyStyle: DiscordReplyStyle;
}): Promise<DiscordReplyChannelResolution> {
  const { message, replyStyle } = params;
  if (replyStyle !== 'thread' || !message.guild) {
    return { channel: null };
  }
  if (
    typeof message.channel.isThread === 'function' &&
    message.channel.isThread()
  ) {
    return { channel: null };
  }

  if (message.hasThread) {
    const existingThread =
      message.thread ??
      (await message.guild.channels.fetch(message.id).catch(() => null));
    if (existingThread && 'send' in existingThread) {
      return { channel: existingThread as DiscordSendChannel };
    }
  }

  if (typeof message.startThread !== 'function') {
    return {
      channel: null,
      warning: 'The triggering Discord message does not support threads.',
    };
  }

  const me =
    message.guild.members.me ??
    (await message.guild.members.fetchMe().catch(() => null));
  const permissions =
    me &&
    'permissionsFor' in message.channel &&
    typeof message.channel.permissionsFor === 'function'
      ? message.channel.permissionsFor(me)
      : null;
  if (permissions) {
    const missing = [
      {
        label: 'CreatePublicThreads',
        flag: PermissionFlagsBits.CreatePublicThreads,
      },
      {
        label: 'SendMessagesInThreads',
        flag: PermissionFlagsBits.SendMessagesInThreads,
      },
    ]
      .filter(({ flag }) => !permissions.has(flag))
      .map(({ label }) => label);
    if (missing.length > 0) {
      return {
        channel: null,
        warning: `Missing Discord permissions for thread replies: ${missing.join(', ')}`,
      };
    }
  }

  try {
    const thread = await message.startThread({
      name: deriveDiscordThreadName(message),
      reason: 'HybridClaw thread reply',
    });
    return { channel: thread as DiscordSendChannel };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      channel: null,
      warning: `Failed to create Discord reply thread: ${detail}`,
    };
  }
}
