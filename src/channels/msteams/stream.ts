import type { TurnContext } from 'botbuilder-core';
import {
  type Activity,
  ActivityTypes,
  type Attachment,
} from 'botframework-schema';
import type { MSTeamsReplyStyle } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import {
  buildMSTeamsMessageActivity,
  prepareChunkedActivities,
} from './delivery.js';
import {
  sendMSTeamsActivityWithRetry,
  updateMSTeamsActivityWithRetry,
} from './retry.js';

const DEFAULT_EDIT_INTERVAL_MS = 1_200;
const DEFAULT_NATIVE_STREAM_INTERVAL_MS = 1_500;
const STREAM_FAILURE_TEXT =
  'Teams streaming was interrupted while sending the reply. Please retry.';
const INITIAL_INFORMATIVE_TEXT = 'Thinking…';

interface SentActivityRef {
  id: string;
  text: string;
}

type MSTeamsNativeStreamType = 'informative' | 'streaming' | 'final';

export interface MSTeamsStreamOptions {
  replyStyle: MSTeamsReplyStyle;
  replyToId?: string | null;
  editIntervalMs?: number;
  nativeStreaming?: boolean;
  onNativeCancellation?: () => void;
}

export class MSTeamsStreamManager {
  private readonly turnContext: TurnContext;
  private readonly replyStyle: MSTeamsReplyStyle;
  private readonly replyToId?: string | null;
  private readonly editIntervalMs: number;
  private readonly nativeStreaming: boolean;
  private readonly onNativeCancellation?: () => void;

  private readonly sent: SentActivityRef[] = [];
  private content = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private opQueue = Promise.resolve();
  private closed = false;
  private nativeCancelled = false;
  private nativeFailed = false;
  private nativeStreamId: string | null = null;
  private nativeSequence = 0;
  private nativeLastText = '';
  private nativeLastInformativeText = '';

  constructor(turnContext: TurnContext, options: MSTeamsStreamOptions) {
    this.turnContext = turnContext;
    this.replyStyle = options.replyStyle;
    this.replyToId = options.replyToId;
    this.nativeStreaming = options.nativeStreaming === true;
    this.onNativeCancellation = options.onNativeCancellation;
    this.editIntervalMs = Math.max(
      250,
      options.editIntervalMs ??
        (this.nativeStreaming
          ? DEFAULT_NATIVE_STREAM_INTERVAL_MS
          : DEFAULT_EDIT_INTERVAL_MS),
    );
  }

  isNativeStreamingActive(): boolean {
    return this.nativeStreaming && !this.nativeCancelled && !this.nativeFailed;
  }

  updateInformative(text = INITIAL_INFORMATIVE_TEXT): Promise<void> {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (
      !this.isNativeStreamingActive() ||
      this.closed ||
      this.content ||
      !normalized ||
      normalized === this.nativeLastInformativeText
    ) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      if (
        !this.isNativeStreamingActive() ||
        this.closed ||
        this.content ||
        normalized === this.nativeLastInformativeText
      ) {
        return;
      }
      try {
        await this.sendNativeUpdate(normalized, 'informative');
        this.nativeLastInformativeText = normalized;
      } catch (error) {
        await this.disableNativeStreaming(error);
      }
    });
  }

  append(delta: string): Promise<void> {
    if (this.closed || !delta) return Promise.resolve();
    this.content += delta;
    this.scheduleFlush();
    return Promise.resolve();
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
    return this.enqueue(async () => {
      await this.closeWithError(errorText);
    });
  }

  discard(): Promise<void> {
    this.clearFlushTimer();
    this.closed = true;
    return this.enqueue(async () => {
      if (this.nativeStreamId) {
        try {
          await this.turnContext.deleteActivity(this.nativeStreamId);
        } catch (error) {
          logger.debug(
            { error, streamId: this.nativeStreamId },
            'Failed to delete streamed Teams preview',
          );
        }
        this.nativeStreamId = null;
      }
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
    this.opQueue = this.opQueue.then(task).catch(async (error) => {
      logger.warn({ error }, 'Teams stream operation failed');
      await this.handleOperationFailure();
    });
    return this.opQueue;
  }

  private async handleOperationFailure(): Promise<void> {
    if (this.closed) return;
    try {
      await this.closeWithError(STREAM_FAILURE_TEXT);
    } catch (error) {
      this.clearFlushTimer();
      this.closed = true;
      logger.warn(
        { error },
        'Failed to send Teams stream failure notice after operation error',
      );
    }
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

  private async closeWithError(errorText: string): Promise<void> {
    if (this.closed) return;
    this.content = this.content ? `${this.content}\n\n${errorText}` : errorText;
    this.clearFlushTimer();
    try {
      await this.sync(true);
    } finally {
      this.closed = true;
    }
  }

  private async sync(
    force: boolean,
    attachments?: Attachment[],
  ): Promise<void> {
    if (this.isNativeStreamingActive()) {
      try {
        await this.syncNative(force, attachments);
        return;
      } catch (error) {
        await this.disableNativeStreaming(error);
      }
    }
    if (this.nativeCancelled) return;
    await this.syncLegacy(force, attachments);
  }

  private async syncLegacy(
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
      const existing = this.sent[index];
      const outgoing = buildMSTeamsMessageActivity({
        ...(existing ? { id: existing.id } : {}),
        text: chunk.text,
        attachments: chunk.attachments,
        replyStyle: this.replyStyle,
        replyToId: this.replyToId,
      });

      if (!existing) {
        const response = await sendMSTeamsActivityWithRetry(
          this.turnContext,
          outgoing,
          'msteams.stream.send',
        );
        const activityId = String(response?.id || '').trim();
        if (!activityId) {
          throw new Error('Teams sendActivity did not return an activity id.');
        }
        this.sent.push({ id: activityId, text: chunk.text });
        continue;
      }

      if (!force && existing.text === chunk.text) continue;
      await updateMSTeamsActivityWithRetry(
        this.turnContext,
        outgoing,
        'msteams.stream.update',
      );
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
  }

  private async syncNative(
    force: boolean,
    attachments?: Attachment[],
  ): Promise<void> {
    const chunks = prepareChunkedActivities({
      text: this.content,
      attachments,
    });
    const first = chunks[0];
    if (!first) return;

    if (!force) {
      if (!first.text || first.text === this.nativeLastText) return;
      if (this.nativeLastText && !first.text.startsWith(this.nativeLastText)) {
        return;
      }
      await this.sendNativeUpdate(first.text, 'streaming');
      this.nativeLastText = first.text;
      this.lastFlushAt = Date.now();
      return;
    }

    if (!first.text) {
      await this.disableNativeStreaming(
        new Error('Teams native streaming requires final text.'),
      );
      await this.syncLegacy(true, attachments);
      return;
    }

    let finalText = first.text;
    let remaining = chunks.slice(1);
    if (this.nativeLastText && !finalText.startsWith(this.nativeLastText)) {
      finalText = this.nativeLastText;
      const fallbackText = this.content.startsWith(this.nativeLastText)
        ? this.content.slice(this.nativeLastText.length)
        : this.content;
      remaining = prepareChunkedActivities({
        text: fallbackText,
        attachments,
      });
    }

    await this.sendNativeFinal(
      finalText,
      remaining.length === 0 ? first.attachments : undefined,
    );
    for (const chunk of remaining) {
      await sendMSTeamsActivityWithRetry(
        this.turnContext,
        buildMSTeamsMessageActivity({
          text: chunk.text,
          attachments: chunk.attachments,
          replyStyle: 'top-level',
        }),
        'msteams.stream.native.remainder',
      );
    }
    this.lastFlushAt = Date.now();
  }

  private async sendNativeUpdate(
    text: string,
    streamType: Exclude<MSTeamsNativeStreamType, 'final'>,
  ): Promise<void> {
    const streamSequence = this.nativeSequence + 1;
    const response = await sendMSTeamsActivityWithRetry(
      this.turnContext,
      {
        type: ActivityTypes.Typing,
        text,
        entities: [
          buildNativeStreamEntity({
            streamId: this.nativeStreamId,
            streamSequence,
            streamType,
          }),
        ],
      },
      `msteams.stream.native.${streamType}`,
    );
    if (!this.nativeStreamId) {
      const streamId = String(response?.id || '').trim();
      if (!streamId) {
        throw new Error(
          'Teams native streaming did not return a stream identifier.',
        );
      }
      this.nativeStreamId = streamId;
    }
    this.nativeSequence = streamSequence;
  }

  private async sendNativeFinal(
    text: string,
    attachments?: Attachment[],
  ): Promise<void> {
    if (!this.nativeStreamId) {
      throw new Error('Teams native streaming was not initialized.');
    }
    await sendMSTeamsActivityWithRetry(
      this.turnContext,
      {
        type: ActivityTypes.Message,
        text,
        ...(attachments?.length ? { attachments } : {}),
        entities: [
          buildNativeStreamEntity({
            streamId: this.nativeStreamId,
            streamType: 'final',
          }),
        ],
      },
      'msteams.stream.native.final',
    );
  }

  private async disableNativeStreaming(error: unknown): Promise<void> {
    if (this.nativeStreamId && isMSTeamsNativeStreamCancellation(error)) {
      this.nativeCancelled = true;
      this.closed = true;
      this.clearFlushTimer();
      try {
        this.onNativeCancellation?.();
      } catch (callbackError) {
        logger.debug(
          { error: callbackError },
          'Teams native stream cancellation callback failed',
        );
      }
      return;
    }
    if (this.nativeFailed) return;
    this.nativeFailed = true;
    logger.debug(
      { error, streamId: this.nativeStreamId },
      'Teams native streaming unavailable; falling back to message updates',
    );
    if (!this.nativeStreamId) return;
    try {
      await this.turnContext.deleteActivity(this.nativeStreamId);
    } catch (deleteError) {
      logger.debug(
        { error: deleteError, streamId: this.nativeStreamId },
        'Failed to remove Teams native streaming preview during fallback',
      );
    }
    this.nativeStreamId = null;
  }
}

function buildNativeStreamEntity(params: {
  streamId: string | null;
  streamType: MSTeamsNativeStreamType;
  streamSequence?: number;
}): NonNullable<Activity['entities']>[number] {
  return {
    type: 'streaminfo',
    ...(params.streamId ? { streamId: params.streamId } : {}),
    streamType: params.streamType,
    ...(typeof params.streamSequence === 'number'
      ? { streamSequence: params.streamSequence }
      : {}),
  };
}

function isMSTeamsNativeStreamCancellation(error: unknown): boolean {
  const details: string[] = [];
  if (typeof error === 'string') details.push(error);
  if (error instanceof Error) details.push(error.message);
  try {
    details.push(JSON.stringify(error));
  } catch {
    // The explicit string or Error message can still identify cancellation.
  }
  const normalized = details.join(' ').toLowerCase();
  return (
    normalized.includes('contentstreamnotallowed') &&
    (normalized.includes('canceled by user') ||
      normalized.includes('cancelled by user'))
  );
}
