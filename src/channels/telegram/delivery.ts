import path from 'node:path';

import { getConfigSnapshot } from '../../config/config.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import {
  callTelegramApi,
  callTelegramMultipartApi,
  createTelegramUploadForm,
  type TelegramMessage,
} from './api.js';
import { parseTelegramTarget } from './target.js';

const OUTBOUND_DELAY_MS = 350;
const TELEGRAM_CAPTION_LIMIT = 1_024;

export interface TelegramOutboundMessageRef {
  chatId: string;
  messageId: number;
  topicId?: number;
}

export interface TelegramTextSendOptions {
  replyToMessageId?: number;
  disableNotification?: boolean;
}

export interface TelegramMediaSendOptions extends TelegramTextSendOptions {
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
}

function clampTextChunkLimit(limit: number): number {
  return Math.max(200, Math.min(4_000, Math.floor(limit)));
}

function resolveTextChunkLimit(): number {
  return clampTextChunkLimit(
    getConfigSnapshot().telegram?.textChunkLimit ?? 4_000,
  );
}

function toTelegramChatId(value: string): number | string {
  return /^-?\d+$/.test(value) ? Number(value) : value;
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
): Promise<T> {
  try {
    return await action(params.topicId);
  } catch (error) {
    if (!params.topicId || !isMissingTopicError(error)) {
      throw error;
    }
    return await action(undefined);
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

  await withTopicFallback(target, async (topicId) => {
    await callTelegramApi(params.botToken, 'sendChatAction', {
      chat_id: toTelegramChatId(target.chatId),
      action: 'typing',
      ...(topicId ? { message_thread_id: topicId } : {}),
    });
  });

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

  const chunks = prepareTelegramTextChunks(params.text);
  const refs: TelegramOutboundMessageRef[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const message = await withTopicFallback(target, async (topicId) => {
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
          ...(params.disableNotification ? { disable_notification: true } : {}),
          ...(topicId ? { message_thread_id: topicId } : {}),
        },
      );
    });
    refs.push(toOutboundRef(target.chatId, message, target.topicId));
    if (index < chunks.length - 1) {
      await sleep(OUTBOUND_DELAY_MS);
    }
  }

  return refs;
}

function resolveTelegramUploadMethod(
  mimeType: string,
): 'sendAudio' | 'sendDocument' | 'sendPhoto' | 'sendVideo' {
  if (mimeType.startsWith('image/')) return 'sendPhoto';
  if (mimeType.startsWith('video/')) return 'sendVideo';
  if (mimeType.startsWith('audio/')) return 'sendAudio';
  return 'sendDocument';
}

function resolveTelegramUploadField(
  method: ReturnType<typeof resolveTelegramUploadMethod>,
): 'audio' | 'document' | 'photo' | 'video' {
  if (method === 'sendPhoto') return 'photo';
  if (method === 'sendVideo') return 'video';
  if (method === 'sendAudio') return 'audio';
  return 'document';
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
  const method = resolveTelegramUploadMethod(mimeType);
  const field = resolveTelegramUploadField(method);
  const caption = String(params.caption || '')
    .trim()
    .slice(0, TELEGRAM_CAPTION_LIMIT);

  const message = await withTopicFallback(target, async (topicId) => {
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

  return toOutboundRef(target.chatId, message, target.topicId);
}
