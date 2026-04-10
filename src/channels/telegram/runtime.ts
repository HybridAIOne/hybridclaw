import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import {
  DATA_DIR,
  getConfigSnapshot,
  TELEGRAM_BOT_TOKEN,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types/container.js';
import { TELEGRAM_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import {
  callTelegramApi,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './api.js';
import {
  sendChunkedTelegramText,
  sendTelegramMedia,
  sendTelegramTyping,
} from './delivery.js';
import {
  cleanupTelegramInboundMedia,
  processInboundTelegramMessage,
} from './inbound.js';
import { createTelegramTypingController } from './typing.js';

export type TelegramReplyFn = (content: string) => Promise<void>;

export interface TelegramMessageContext {
  abortSignal: AbortSignal;
  message: TelegramMessage;
  update: TelegramUpdate;
  botUser: TelegramUser;
  chatId: string;
  topicId?: number;
}

export type TelegramMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: TelegramReplyFn,
  context: TelegramMessageContext,
) => Promise<void>;

export interface TelegramMediaSendParams {
  target: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
  replyToMessageId?: number;
}

export interface TelegramRuntime {
  initTelegram: (messageHandler: TelegramMessageHandler) => Promise<void>;
  sendToTelegramChat: (target: string, text: string) => Promise<void>;
  sendTelegramMediaToChat: (params: TelegramMediaSendParams) => Promise<void>;
  shutdownTelegram: () => Promise<void>;
}

const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_MAX_UPDATES_PER_POLL = 50;
const TELEGRAM_RETRY_BASE_MS = 1_500;
const TELEGRAM_RETRY_MAX_MS = 15_000;

function resolveTelegramConfig() {
  return (
    getConfigSnapshot().telegram || {
      enabled: false,
      botToken: '',
      pollIntervalMs: 1_500,
      dmPolicy: 'disabled',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      requireMention: true,
      textChunkLimit: 4_000,
      mediaMaxMb: 20,
    }
  );
}

function resolveBotToken(): string {
  const token = String(
    TELEGRAM_BOT_TOKEN || resolveTelegramConfig().botToken || '',
  ).trim();
  if (!token) {
    throw new Error('Telegram bot token is not configured.');
  }
  return token;
}

function buildOffsetFilePath(botToken: string): string {
  const tokenHash = createHash('sha256')
    .update(botToken)
    .digest('hex')
    .slice(0, 16);
  return path.join(DATA_DIR, 'telegram', `offset-${tokenHash}.txt`);
}

async function readStoredUpdateOffset(botToken: string): Promise<number> {
  const filePath = buildOffsetFilePath(botToken);
  const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function writeStoredUpdateOffset(
  botToken: string,
  offset: number,
): Promise<void> {
  const filePath = buildOffsetFilePath(botToken);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${offset}\n`, 'utf8');
}

async function getTelegramUpdates(params: {
  botToken: string;
  offset: number;
  abortSignal: AbortSignal;
}): Promise<TelegramUpdate[]> {
  return await callTelegramApi<TelegramUpdate[]>(
    params.botToken,
    'getUpdates',
    {
      offset: params.offset,
      timeout: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
      limit: TELEGRAM_MAX_UPDATES_PER_POLL,
      allowed_updates: ['message'],
    },
    params.abortSignal,
  );
}

export function createTelegramRuntime(): TelegramRuntime {
  let runtimeInitialized = false;
  let shutdownController: AbortController | null = null;
  let pollTask: Promise<void> | null = null;
  let botUser: TelegramUser | null = null;

  const sendToTelegramChat = async (
    target: string,
    text: string,
  ): Promise<void> => {
    await sendChunkedTelegramText({
      botToken: resolveBotToken(),
      target,
      text,
    });
  };

  const sendTelegramMediaToChat = async (
    params: TelegramMediaSendParams,
  ): Promise<void> => {
    await sendTelegramMedia({
      botToken: resolveBotToken(),
      target: params.target,
      filePath: params.filePath,
      mimeType: params.mimeType,
      filename: params.filename,
      caption: params.caption,
      replyToMessageId: params.replyToMessageId,
    });
  };

  const dispatchUpdate = async (
    update: TelegramUpdate,
    messageHandler: TelegramMessageHandler,
  ): Promise<void> => {
    const message = update.message;
    if (!message || !botUser) return;

    const inbound = await processInboundTelegramMessage({
      botToken: resolveBotToken(),
      config: resolveTelegramConfig(),
      message,
      botUser,
      agentId: DEFAULT_AGENT_ID,
    });
    if (!inbound) return;

    const controller = new AbortController();
    const reply: TelegramReplyFn = async (content) => {
      await sendChunkedTelegramText({
        botToken: resolveBotToken(),
        target: inbound.channelId,
        text: content,
        replyToMessageId: message.message_id,
      });
    };

    const typingController = createTelegramTypingController(() =>
      sendTelegramTyping({
        botToken: resolveBotToken(),
        target: inbound.channelId,
      }),
    );
    typingController.start();

    try {
      await messageHandler(
        inbound.sessionId,
        inbound.guildId,
        inbound.channelId,
        inbound.userId,
        inbound.username,
        inbound.content,
        inbound.media,
        reply,
        {
          abortSignal: controller.signal,
          message,
          update,
          botUser,
          chatId: String(message.chat.id),
          ...(inbound.topicId ? { topicId: inbound.topicId } : {}),
        },
      );
    } finally {
      typingController.stop();
      await cleanupTelegramInboundMedia(inbound.media).catch((error) => {
        logger.debug(
          { error, sessionId: inbound.sessionId, channelId: inbound.channelId },
          'Failed to clean up Telegram inbound media',
        );
      });
    }
  };

  const runPollingLoop = async (
    messageHandler: TelegramMessageHandler,
  ): Promise<void> => {
    const botToken = resolveBotToken();
    let offset = await readStoredUpdateOffset(botToken);
    let retryDelayMs = TELEGRAM_RETRY_BASE_MS;

    while (!shutdownController?.signal.aborted) {
      try {
        const updates = await getTelegramUpdates({
          botToken,
          offset,
          abortSignal: shutdownController?.signal as AbortSignal,
        });

        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await dispatchUpdate(update, messageHandler);
        }

        if (updates.length > 0) {
          await writeStoredUpdateOffset(botToken, offset);
        }

        const pollIntervalMs = Math.max(
          0,
          Math.min(resolveTelegramConfig().pollIntervalMs, 60_000),
        );
        retryDelayMs = TELEGRAM_RETRY_BASE_MS;
        if (pollIntervalMs > 0 && updates.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      } catch (error) {
        if (shutdownController?.signal.aborted) return;
        logger.warn({ error }, 'Telegram polling request failed');
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        retryDelayMs = Math.min(retryDelayMs * 2, TELEGRAM_RETRY_MAX_MS);
      }
    }
  };

  return {
    async initTelegram(messageHandler: TelegramMessageHandler): Promise<void> {
      if (runtimeInitialized) return;

      const botToken = resolveBotToken();
      botUser = await callTelegramApi<TelegramUser>(botToken, 'getMe');
      registerChannel({
        kind: 'telegram',
        id: 'telegram',
        capabilities: TELEGRAM_CAPABILITIES,
      });

      shutdownController = new AbortController();
      runtimeInitialized = true;
      pollTask = runPollingLoop(messageHandler).catch((error) => {
        if (!shutdownController?.signal.aborted) {
          logger.warn({ error }, 'Telegram runtime stopped unexpectedly');
        }
      });
    },
    sendToTelegramChat,
    sendTelegramMediaToChat,
    async shutdownTelegram(): Promise<void> {
      shutdownController?.abort();
      await pollTask;
      pollTask = null;
      botUser = null;
      shutdownController = null;
      runtimeInitialized = false;
    },
  };
}

const runtime = createTelegramRuntime();

export const initTelegram = runtime.initTelegram;
export const sendToTelegramChat = runtime.sendToTelegramChat;
export const sendTelegramMediaToChat = runtime.sendTelegramMediaToChat;
export const shutdownTelegram = runtime.shutdownTelegram;
