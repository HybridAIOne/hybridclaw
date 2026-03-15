import type { TurnContext } from 'botbuilder-core';
import {
  type Activity,
  ActivityTypes,
  type Attachment,
} from 'botframework-schema';
import type { MSTeamsReplyStyle } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import { prepareChunkedActivities } from './delivery.js';

const DEFAULT_EDIT_INTERVAL_MS = 1_200;

interface SentActivityRef {
  id: string;
  text: string;
}

export interface MSTeamsStreamOptions {
  replyStyle: MSTeamsReplyStyle;
  replyToId?: string | null;
  editIntervalMs?: number;
}

export class MSTeamsStreamManager {
  private readonly turnContext: TurnContext;
  private readonly replyStyle: MSTeamsReplyStyle;
  private readonly replyToId?: string | null;
  private readonly editIntervalMs: number;

  private readonly sent: SentActivityRef[] = [];
  private content = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private opQueue = Promise.resolve();
  private closed = false;

  constructor(turnContext: TurnContext, options: MSTeamsStreamOptions) {
    this.turnContext = turnContext;
    this.replyStyle = options.replyStyle;
    this.replyToId = options.replyToId;
    this.editIntervalMs = Math.max(
      250,
      options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS,
    );
  }

  append(delta: string): Promise<void> {
    if (this.closed || !delta) return Promise.resolve();
    this.content += delta;
    return this.enqueue(async () => {
      await this.sync(false);
    });
  }

  finalize(text: string, attachments?: Attachment[]): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.content = text;
    this.clearFlushTimer();
    return this.enqueue(async () => {
      await this.sync(true, attachments);
      this.closed = true;
    });
  }

  fail(errorText: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.content = this.content ? `${this.content}\n\n${errorText}` : errorText;
    this.clearFlushTimer();
    return this.enqueue(async () => {
      await this.sync(true);
      this.closed = true;
    });
  }

  discard(): Promise<void> {
    this.clearFlushTimer();
    this.closed = true;
    return this.enqueue(async () => {
      for (const entry of this.sent) {
        try {
          await this.turnContext.deleteActivity(entry.id);
        } catch (error) {
          logger.debug(
            { error, activityId: entry.id },
            'Failed to delete streamed Teams activity',
          );
        }
      }
      this.sent.length = 0;
      this.content = '';
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.opQueue = this.opQueue.then(task).catch((error) => {
      logger.warn({ error }, 'Teams stream operation failed');
    });
    return this.opQueue;
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    const waitMs = Math.max(
      0,
      this.editIntervalMs - (Date.now() - this.lastFlushAt),
    );
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueue(async () => {
        await this.sync(false);
      });
    }, waitMs);
  }

  private buildOutgoingActivity(params: {
    id?: string;
    text: string;
    attachments?: Attachment[];
  }): Partial<Activity> {
    return {
      type: ActivityTypes.Message,
      ...(params.id ? { id: params.id } : {}),
      ...(params.text ? { text: params.text } : {}),
      ...(params.attachments?.length
        ? { attachments: params.attachments }
        : {}),
      ...(this.replyStyle === 'thread' && this.replyToId
        ? { replyToId: this.replyToId }
        : {}),
    };
  }

  private async sync(
    force: boolean,
    attachments?: Attachment[],
  ): Promise<void> {
    const chunks = prepareChunkedActivities({
      text: this.content,
      attachments,
    });
    if (chunks.length === 0) return;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const isLast = index === chunks.length - 1;
      const existing = this.sent[index];
      const outgoing = this.buildOutgoingActivity({
        ...(existing ? { id: existing.id } : {}),
        text: chunk.text,
        ...(isLast && chunk.attachments?.length
          ? { attachments: chunk.attachments }
          : {}),
      });

      if (!existing) {
        const response = await this.turnContext.sendActivity(outgoing);
        const activityId = String(response?.id || '').trim();
        if (!activityId) {
          throw new Error('Teams sendActivity did not return an activity id.');
        }
        this.sent.push({ id: activityId, text: chunk.text });
        continue;
      }

      if (!force && existing.text === chunk.text) continue;
      await this.turnContext.updateActivity(outgoing);
      this.sent[index] = { id: existing.id, text: chunk.text };
    }

    while (this.sent.length > chunks.length) {
      const stale = this.sent.pop();
      if (!stale) break;
      try {
        await this.turnContext.deleteActivity(stale.id);
      } catch (error) {
        logger.debug(
          { error, activityId: stale.id },
          'Failed to delete stale Teams chunk',
        );
      }
    }

    this.lastFlushAt = Date.now();
    if (!force) this.scheduleFlush();
  }
}
