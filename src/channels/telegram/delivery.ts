import path from 'node:path';

import { getConfigSnapshot } from '../../config/config.js';
import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import { withTransportRetry } from '../../utils/transport-retry.js';
import {
  callTelegramApi,
  callTelegramMultipartApi,
  createTelegramUploadForm,
  TelegramApiError,
  type TelegramMessage,
} from './api.js';
import {
  buildTelegramChannelId,
  normalizeTelegramChatId,
  parseTelegramTarget,
} from './target.js';

const OUTBOUND_DELAY_MS = 350;
const TELEGRAM_CAPTION_LIMIT = 1_024;
const TELEGRAM_RETRY_MAX_ATTEMPTS = 8;
const TELEGRAM_RETRY_BASE_DELAY_MS = 500;
const TELEGRAM_RETRY_MAX_DELAY_MS = 15_000;
const telegramOutboundQueues = new Map<string, Promise<void>>();

export interface TelegramOutboundMessageRef {
  chatId: string;
  messageId: number;
  topicId?: number;
}

function resolveTextChunkLimit(): number {
  return Math.max(
    200,
    Math.min(
      4_000,
      Math.floor(getConfigSnapshot().telegram?.textChunkLimit ?? 4_000),
    ),
  );
}

function toTelegramChatId(value: string): number | string {
  const normalized = normalizeTelegramChatId(value);
  if (!normalized) {
    throw new Error(`Invalid Telegram chat id: ${value}`);
  }
  return Number.isInteger(Number(normalized)) ? Number(normalized) : normalized;
}

function getTelegramErrorStatus(error: unknown): number | null {
  if (error instanceof TelegramApiError) {
    return error.statusCode;
  }
  if (typeof error !== 'object' || error == null) {
    return null;
  }
  const maybe = error as {
    status?: unknown;
    statusCode?: unknown;
    httpStatus?: unknown;
  };
  const status = maybe.status ?? maybe.statusCode ?? maybe.httpStatus;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function isRetryableTelegramError(error: unknown): boolean {
  const status = getTelegramErrorStatus(error);
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return true;
  }
  if (error instanceof TelegramApiError && error.errorCode === 429) {
    return true;
  }
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return classifyGatewayError(text) === 'transient';
}

async function withTelegramTransportRetry<T>(
  label: string,
  run: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    options?.maxAttempts ?? TELEGRAM_RETRY_MAX_ATTEMPTS,
  );
  const maxDelayMs = Math.max(
    50,
    options?.maxDelayMs ?? TELEGRAM_RETRY_MAX_DELAY_MS,
  );
  const delayMs = Math.max(
    50,
    Math.min(options?.baseDelayMs ?? TELEGRAM_RETRY_BASE_DELAY_MS, maxDelayMs),
  );
  return withTransportRetry(label, run, {
    maxAttempts,
    baseDelayMs: delayMs,
    maxDelayMs,
    isRetryable: isRetryableTelegramError,
    logMessage: 'Telegram transport failed; retrying',
  });
}

function queueTelegramOutboundDelivery<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = telegramOutboundQueues.get(target) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(run);
  const sentinel = task.then(
    () => undefined,
    () => undefined,
  );
  telegramOutboundQueues.set(target, sentinel);
  void sentinel.finally(() => {
    if (telegramOutboundQueues.get(target) === sentinel) {
      telegramOutboundQueues.delete(target);
    }
  });
  return task;
}

function isMissingTopicError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /message thread not found|thread.*not found|topic.*not found/i.test(
    message,
  );
}

async function withTopicFallback<T>(
  params: {
    topicId?: number;
  },
  action: (topicId?: number) => Promise<T>,
): Promise<{
  result: T;
  topicIdUsed?: number;
}> {
  try {
    return {
      result: await action(params.topicId),
      ...(params.topicId ? { topicIdUsed: params.topicId } : {}),
    };
  } catch (error) {
    if (!params.topicId || !isMissingTopicError(error)) {
      throw error;
    }
    return {
      result: await action(undefined),
    };
  }
}

function toOutboundRef(
  chatId: string,
  message: Pick<TelegramMessage, 'message_id'>,
  topicId?: number,
): TelegramOutboundMessageRef {
  return {
    chatId,
    messageId: message.message_id,
    ...(topicId ? { topicId } : {}),
  };
}

export function prepareTelegramTextChunks(text: string): string[] {
  const formatted = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const chunks = chunkMessage(formatted, {
    maxChars: resolveTextChunkLimit(),
    maxLines: 200,
  }).filter((chunk) => chunk.trim().length > 0);
  return chunks.length > 0 ? chunks : ['(no content)'];
}

export async function sendTelegramTyping(params: {
  botToken: string;
  target: string;
}): Promise<boolean> {
  const target = parseTelegramTarget(params.target);
  if (!target) return false;

  await withTelegramTransportRetry(
    'telegram.sendTyping',
    async () =>
      await withTopicFallback(target, async (topicId) => {
        await callTelegramApi(params.botToken, 'sendChatAction', {
          chat_id: toTelegramChatId(target.chatId),
          action: 'typing',
          ...(topicId ? { message_thread_id: topicId } : {}),
        });
      }),
    {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4_000,
    },
  );

  return true;
}

export async function sendChunkedTelegramText(params: {
  botToken: string;
  target: string;
  text: string;
  replyToMessageId?: number;
  disableNotification?: boolean;
}): Promise<TelegramOutboundMessageRef[]> {
  const target = parseTelegramTarget(params.target);
  if (!target) {
    throw new Error(`Invalid Telegram target: ${params.target}`);
  }

  return await queueTelegramOutboundDelivery(
    buildTelegramChannelId(target.chatId, target.topicId),
    async () => {
      const chunks = prepareTelegramTextChunks(params.text);
      const refs: TelegramOutboundMessageRef[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const { result: message, topicIdUsed } =
          await withTelegramTransportRetry(
            'telegram.sendChunkedText',
            async () =>
              await withTopicFallback(target, async (topicId) => {
                return await callTelegramApi<TelegramMessage>(
                  params.botToken,
                  'sendMessage',
                  {
                    chat_id: toTelegramChatId(target.chatId),
                    text: chunks[index],
                    disable_web_page_preview: true,
                    ...(params.replyToMessageId
                      ? { reply_to_message_id: params.replyToMessageId }
                      : {}),
                    ...(params.disableNotification
                      ? { disable_notification: true }
                      : {}),
                    ...(topicId ? { message_thread_id: topicId } : {}),
                  },
                );
              }),
          );
        refs.push(toOutboundRef(target.chatId, message, topicIdUsed));
        if (index < chunks.length - 1) {
          await sleep(OUTBOUND_DELAY_MS);
        }
      }
      return refs;
    },
  );
}

function resolveTelegramUploadTarget(mimeType: string): {
  method: 'sendAudio' | 'sendDocument' | 'sendPhoto' | 'sendVideo';
  field: 'audio' | 'document' | 'photo' | 'video';
} {
  if (mimeType.startsWith('image/')) {
    return { method: 'sendPhoto', field: 'photo' };
  }
  if (mimeType.startsWith('video/')) {
    return { method: 'sendVideo', field: 'video' };
  }
  if (mimeType.startsWith('audio/')) {
    return { method: 'sendAudio', field: 'audio' };
  }
  return { method: 'sendDocument', field: 'document' };
}

export async function sendTelegramMedia(params: {
  botToken: string;
  target: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
  replyToMessageId?: number;
  disableNotification?: boolean;
}): Promise<TelegramOutboundMessageRef | null> {
  const target = parseTelegramTarget(params.target);
  if (!target) {
    throw new Error(`Invalid Telegram target: ${params.target}`);
  }

  const mimeType =
    String(params.mimeType || '')
      .trim()
      .toLowerCase() || 'application/octet-stream';
  const filename =
    String(params.filename || '').trim() || path.basename(params.filePath);
  const { method, field } = resolveTelegramUploadTarget(mimeType);
  const caption = String(params.caption || '')
    .trim()
    .slice(0, TELEGRAM_CAPTION_LIMIT);

  const { result: message, topicIdUsed } = await queueTelegramOutboundDelivery(
    buildTelegramChannelId(target.chatId, target.topicId),
    async () =>
      await withTelegramTransportRetry('telegram.sendMedia', async () => {
        return await withTopicFallback(target, async (topicId) => {
          const formData = await createTelegramUploadForm({
            chatId: String(toTelegramChatId(target.chatId)),
            fileField: field,
            filePath: params.filePath,
            filename,
            mimeType,
            topicId,
            replyToMessageId: params.replyToMessageId,
            caption: caption || undefined,
            disableNotification: params.disableNotification,
          });
          return await callTelegramMultipartApi<TelegramMessage>(
            params.botToken,
            method,
            formData,
          );
        });
      }),
  );

  return toOutboundRef(target.chatId, message, topicIdUsed);
}
