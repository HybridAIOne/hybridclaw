import type { AttachmentBuilder, Message as DiscordMessage } from 'discord.js';
import {
  DISCORD_MAX_LINES_PER_MESSAGE,
  DISCORD_TEXT_CHUNK_LIMIT,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import { chunkMessage } from '../../memory/chunk.js';
import {
  getHumanDelayMs,
  type HumanDelayConfig,
  sleep,
} from './human-delay.js';

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

interface DiscordErrorLike {
  status?: number;
  httpStatus?: number;
  retryAfter?: number;
  data?: {
    retry_after?: number;
  };
}

export interface DiscordStreamOptions {
  maxChars?: number;
  maxLines?: number;
  editIntervalMs?: number;
  onFirstMessage?: () => void;
  humanDelay?: HumanDelayConfig;
}

const DEFAULT_EDIT_INTERVAL_MS = 1_200;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function isRenderableChunk(chunk: string): boolean {
  return chunk.trim().length > 0;
}

function isRetryableDiscordError(error: unknown): boolean {
  const maybe = error as DiscordErrorLike;
  const status = maybe.status ?? maybe.httpStatus;
  return (
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  );
}

function extractRetryDelayMs(error: unknown, fallbackMs: number): number {
  const maybe = error as DiscordErrorLike;
  const retryAfterSeconds = maybe.retryAfter ?? maybe.data?.retry_after;
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    return Math.max(50, Math.ceil(retryAfterSeconds * 1_000));
  }
  const jitter = Math.floor(Math.random() * 250);
  return fallbackMs + jitter;
}

async function withDiscordRetry<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;
  while (true) {
    attempt += 1;
    try {
      return await run();
    } catch (error) {
      if (attempt >= RETRY_MAX_ATTEMPTS || !isRetryableDiscordError(error)) {
        throw error;
      }
      const waitMs = extractRetryDelayMs(error, delayMs);
      logger.warn(
        { label, attempt, waitMs, error },
        'Discord request failed; retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      delayMs = Math.min(delayMs * 2, 4_000);
    }
  }
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
          await withDiscordRetry('delete', () => message.delete());
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
      logger.warn({ error }, 'Discord stream operation failed');
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
        const sent = await withDiscordRetry('reply', () =>
          this.sourceMessage.reply({ content: fallback, files }),
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
            ? await withDiscordRetry('reply', () =>
                this.sourceMessage.reply({ content: chunk }),
              )
            : await withDiscordRetry('send', () =>
                this.channel.send({ content: chunk }),
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

      await withDiscordRetry('edit', () =>
        this.messages[i].edit({ content: chunk }),
      );
      this.sentChunks[i] = chunk;
      this.lastEditAt = Date.now();
    }

    if (this.messages.length > chunks.length) {
      for (let i = this.messages.length - 1; i >= chunks.length; i -= 1) {
        await withDiscordRetry('delete', () => this.messages[i].delete());
      }
      this.messages.splice(chunks.length);
      this.sentChunks = this.sentChunks.slice(0, chunks.length);
    }

    if (files && files.length > 0) {
      const lastIndex = chunks.length - 1;
      await withDiscordRetry('edit', () =>
        this.messages[lastIndex].edit({ content: chunks[lastIndex], files }),
      );
      this.sentChunks[lastIndex] = chunks[lastIndex];
      this.lastEditAt = Date.now();
    }
  }
}
