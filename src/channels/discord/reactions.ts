import type { Message as DiscordMessage } from 'discord.js';

import { logger } from '../../logger.js';

export type LifecyclePhase =
  | 'queued'
  | 'thinking'
  | 'toolUse'
  | 'streaming'
  | 'done'
  | 'error';
export type DiscordRetryFn = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T>;

const MIN_REACTION_GAP_MS = 350;
const DONE_REACTION_VISIBILITY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

interface LifecycleReactionConfig {
  enabled: boolean;
  removeOnComplete: boolean;
  phases: Record<LifecyclePhase, string>;
}

export class LifecycleReactionController {
  private readonly message: DiscordMessage;
  private readonly withRetry: DiscordRetryFn;
  private readonly botUserId: string;
  private readonly config: LifecycleReactionConfig;
  private currentEmoji: string | null = null;
  private currentPhase: LifecyclePhase | null = null;
  private queue = Promise.resolve();
  private lastReactionAt = 0;

  constructor(params: {
    message: DiscordMessage;
    withRetry: DiscordRetryFn;
    botUserId: string;
    config: LifecycleReactionConfig;
  }) {
    this.message = params.message;
    this.withRetry = params.withRetry;
    this.botUserId = params.botUserId;
    this.config = params.config;
  }

  setPhase(phase: LifecyclePhase): void {
    if (!this.config.enabled) return;
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    this.queue = this.queue
      .then(async () => {
        await this.transitionToPhase(phase);
      })
      .catch((error) => {
        logger.debug(
          {
            error,
            channelId: this.message.channelId,
            messageId: this.message.id,
            phase,
          },
          'Lifecycle reaction transition failed',
        );
      });
  }

  async clear(): Promise<void> {
    if (!this.config.enabled) return;
    await this.queue;
    if (!this.currentEmoji) return;
    await this.removeReaction(this.currentEmoji);
    this.currentEmoji = null;
    this.currentPhase = null;
  }

  private async transitionToPhase(phase: LifecyclePhase): Promise<void> {
    const nextEmoji = (this.config.phases[phase] || '').trim();
    if (!nextEmoji) return;
    if (this.currentEmoji && this.currentEmoji !== nextEmoji) {
      await this.removeReaction(this.currentEmoji);
      this.currentEmoji = null;
    }

    await this.addReaction(nextEmoji);
    this.currentEmoji = nextEmoji;

    if (phase === 'done' && this.config.removeOnComplete) {
      await sleep(DONE_REACTION_VISIBILITY_MS);
      await this.removeReaction(nextEmoji);
      this.currentEmoji = null;
    }
  }

  private async waitForReactionWindow(): Promise<void> {
    const elapsed = Date.now() - this.lastReactionAt;
    if (elapsed >= MIN_REACTION_GAP_MS) return;
    await sleep(MIN_REACTION_GAP_MS - elapsed);
  }

  private async addReaction(emoji: string): Promise<void> {
    await this.waitForReactionWindow();
    try {
      await this.withRetry('reaction-lifecycle-add', () =>
        this.message.react(emoji),
      );
      this.lastReactionAt = Date.now();
    } catch (error) {
      logger.debug(
        {
          error,
          channelId: this.message.channelId,
          messageId: this.message.id,
          emoji,
        },
        'Failed to add lifecycle reaction',
      );
    }
  }

  private async removeReaction(emoji: string): Promise<void> {
    await this.waitForReactionWindow();
    try {
      const reaction = findReactionByEmoji(this.message, emoji);
      if (!reaction) return;
      await this.withRetry('reaction-lifecycle-remove', () =>
        reaction.users.remove(this.botUserId),
      );
      this.lastReactionAt = Date.now();
    } catch (error) {
      logger.debug(
        {
          error,
          channelId: this.message.channelId,
          messageId: this.message.id,
          emoji,
        },
        'Failed to remove lifecycle reaction',
      );
    }
  }
}
