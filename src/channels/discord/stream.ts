import type { AttachmentBuilder, Message as DiscordMessage } from 'discord.js';
import {
  DISCORD_MAX_LINES_PER_MESSAGE,
  DISCORD_TEXT_CHUNK_LIMIT,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import { getHumanDelayMs, type HumanDelayConfig } from './human-delay.js';
import { withDiscordRetry } from './retry.js';
import { logDiscordApiError } from './transport-errors.js';

interface DiscordSendChannel {
  send: (payload: {
    content: string;
    files?: AttachmentBuilder[];
  }) => Promise<DiscordMessage>;
}

interface DiscordEditMessage {
  edit: (payload: {
    content: string;
    files?: AttachmentBuilder[];
  }) => Promise<DiscordMessage>;
  delete: () => Promise<unknown>;
}

export interface DiscordStreamOptions {
  maxChars?: number;
  maxLines?: number;
  editIntervalMs?: number;
  onFirstMessage?: () => void;
  humanDelay?: HumanDelayConfig;
}

const DEFAULT_EDIT_INTERVAL_MS = 1_200;
const DISCORD_STREAM_RETRY_LOG_MESSAGE = 'Discord request failed; retrying';

function isRenderableChunk(chunk: string): boolean {
  return chunk.trim().length > 0;
}

export class DiscordStreamManager {
  private readonly sourceMessage: DiscordMessage;
  private readonly channel: DiscordSendChannel;
  private readonly maxChars: number;
  private readonly maxLines: number;
  private readonly editIntervalMs: number;
  private readonly onFirstMessage?: () => void;
  private readonly humanDelay?: HumanDelayConfig;

  private readonly messages: DiscordEditMessage[] = [];
  private sentChunks: string[] = [];
  private content = '';
  private lastEditAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private opQueue = Promise.resolve();
  private closed = false;

  constructor(sourceMessage: DiscordMessage, options?: DiscordStreamOptions) {
    this.sourceMessage = sourceMessage;
    this.channel = sourceMessage.channel as unknown as DiscordSendChannel;
    this.maxChars = Math.max(
      200,
      Math.min(2_000, options?.maxChars ?? DISCORD_TEXT_CHUNK_LIMIT),
    );
    this.maxLines = Math.max(
      4,
      Math.min(200, options?.maxLines ?? DISCORD_MAX_LINES_PER_MESSAGE),
    );
    this.editIntervalMs = Math.max(
      250,
      options?.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS,
    );
    this.onFirstMessage = options?.onFirstMessage;
    this.humanDelay = options?.humanDelay;
  }

  hasSentMessages(): boolean {
    return this.messages.length > 0;
  }

  append(delta: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!delta) return Promise.resolve();
    this.content += delta;
    return this.enqueue(async () => {
      await this.sync(false);
    });
  }

  finalize(finalText: string, files?: AttachmentBuilder[]): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.content = finalText;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.enqueue(async () => {
      await this.sync(true, files);
      this.closed = true;
    });
  }

  fail(errorText: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.content = this.content ? `${this.content}\n\n${errorText}` : errorText;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.enqueue(async () => {
      await this.sync(true);
      this.closed = true;
    });
  }

  discard(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.closed = true;
    return this.enqueue(async () => {
      for (const message of this.messages) {
        try {
          await withDiscordRetry('delete', () => message.delete(), {
            logMessage: DISCORD_STREAM_RETRY_LOG_MESSAGE,
          });
        } catch (error) {
          logger.debug({ error }, 'Failed to delete partial streamed message');
        }
      }
      this.messages.length = 0;
      this.sentChunks = [];
      this.content = '';
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.opQueue = this.opQueue.then(task).catch((error) => {
      logDiscordApiError({
        error,
        expectedAction: 'Response message was not delivered.',
        unexpectedMessage: 'Discord stream operation failed',
      });
    });
    return this.opQueue;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    const waitMs = Math.max(
      0,
      this.editIntervalMs - (Date.now() - this.lastEditAt),
    );
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueue(async () => {
        await this.sync(false);
      });
    }, waitMs);
  }

  private async sync(
    forceLastEdit: boolean,
    files?: AttachmentBuilder[],
  ): Promise<void> {
    const chunks = chunkMessage(this.content, {
      maxChars: this.maxChars,
      maxLines: this.maxLines,
    }).filter(isRenderableChunk);

    if (chunks.length === 0) {
      if (files && files.length > 0) {
        const fallback = 'Attached files:';
        const sent = await withDiscordRetry(
          'reply',
          () => this.sourceMessage.reply({ content: fallback, files }),
          { logMessage: DISCORD_STREAM_RETRY_LOG_MESSAGE },
        );
        this.messages.push(sent as unknown as DiscordEditMessage);
        this.sentChunks.push(fallback);
        this.onFirstMessage?.();
      }
      return;
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;

      if (i >= this.messages.length) {
        if (i > 0) {
          const delayMs = getHumanDelayMs(this.humanDelay);
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
        const sent =
          i === 0
            ? await withDiscordRetry(
                'reply',
                () => this.sourceMessage.reply({ content: chunk }),
                { logMessage: DISCORD_STREAM_RETRY_LOG_MESSAGE },
              )
            : await withDiscordRetry(
                'send',
                () => this.channel.send({ content: chunk }),
                { logMessage: DISCORD_STREAM_RETRY_LOG_MESSAGE },
              );
        this.messages.push(sent as unknown as DiscordEditMessage);
        this.sentChunks.push(chunk);
        this.onFirstMessage?.();
        continue;
      }

      if (this.sentChunks[i] === chunk) continue;

      const elapsed = Date.now() - this.lastEditAt;
      if (isLast && !forceLastEdit && elapsed < this.editIntervalMs) {
        this.scheduleFlush();
        continue;
      }

      await withDiscordRetry(
        'edit',
        () => this.messages[i].edit({ content: chunk }),
        { logMessage: DISCORD_STREAM_RETRY_LOG_MESSAGE },
      );
      this.sentChunks[i] = chunk;
      this.lastEditAt = Date.now();
    }

    if (this.messages.length > chunks.length) {
      for (let i = this.messages.length - 1; i >= chunks.length; i -= 1) {
        await withDiscordRetry('delete', () => this.messages[i].delete(), {
          logMessage: DISCORD_STREAM_RETRY_LOG_MESSAGE,
        });
      }
      this.messages.splice(chunks.length);
      this.sentChunks = this.sentChunks.slice(0, chunks.length);
    }

    if (files && files.length > 0) {
      const lastIndex = chunks.length - 1;
      await withDiscordRetry(
        'edit',
        () =>
          this.messages[lastIndex].edit({ content: chunks[lastIndex], files }),
        { logMessage: DISCORD_STREAM_RETRY_LOG_MESSAGE },
      );
      this.sentChunks[lastIndex] = chunks[lastIndex];
      this.lastEditAt = Date.now();
    }
  }
}
