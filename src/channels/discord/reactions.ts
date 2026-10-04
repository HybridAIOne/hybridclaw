import type { Message as DiscordMessage } from 'discord.js';

import { logger } from '../../logger.js';

export type DiscordRetryFn = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T>;

function findReactionByEmoji(
  message: DiscordMessage,
  emoji: string,
): { users: { remove: (userId: string) => Promise<unknown> } } | null {
  const direct = message.reactions.resolve(emoji);
  if (direct) return direct;
  const trimmed = emoji.trim();
  if (!trimmed) return null;
  const fallback = message.reactions.cache.find(
    (reaction) =>
      reaction.emoji.toString() === trimmed || reaction.emoji.name === trimmed,
  );
  return fallback ?? null;
}

export async function addAckReaction(params: {
  message: DiscordMessage;
  emoji: string;
  withRetry: DiscordRetryFn;
  botUserId: string;
}): Promise<() => Promise<void>> {
  const reactionEmoji = params.emoji.trim();
  if (!reactionEmoji) {
    return async () => {};
  }

  try {
    await params.withRetry('reaction-ack-add', () =>
      params.message.react(reactionEmoji),
    );
  } catch (error) {
    logger.debug(
      {
        error,
        channelId: params.message.channelId,
        messageId: params.message.id,
        reactionEmoji,
      },
      'Failed to add ack reaction',
    );
    return async () => {};
  }

  return async () => {
    try {
      const reaction = findReactionByEmoji(params.message, reactionEmoji);
      if (!reaction) return;
      await params.withRetry('reaction-ack-remove', () =>
        reaction.users.remove(params.botUserId),
      );
    } catch (error) {
      logger.debug(
        {
          error,
          channelId: params.message.channelId,
          messageId: params.message.id,
          reactionEmoji,
        },
        'Failed to remove ack reaction',
      );
    }
  };
}
