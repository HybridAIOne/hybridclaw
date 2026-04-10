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
import { processInboundTelegramMessage } from './inbound.js';
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

const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_MAX_UPDATES_PER_POLL = 50;
const TELEGRAM_RETRY_BASE_MS = 1_500;
const TELEGRAM_RETRY_MAX_MS = 15_000;
let runtimeInitialized = false;
let shutdownController: AbortController | null = null;
let pollTask: Promise<void> | null = null;
let botUser: TelegramUser | null = null;
let activeBotToken: string | null = null;
let activeTelegramConfig:
  | ReturnType<typeof getConfigSnapshot>['telegram']
  | null = null;
const inFlightControllers = new Set<AbortController>();

function createTelegramShutdownAbortError(): Error {
  return new Error('Telegram runtime shutting down.');
}

function abortInFlightHandlers(): void {
  for (const controller of inFlightControllers) {
    if (controller.signal.aborted) continue;
    controller.abort(createTelegramShutdownAbortError());
  }
}

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

export function hasTelegramBotToken(): boolean {
  return Boolean(
    String(TELEGRAM_BOT_TOKEN || resolveTelegramConfig().botToken || '').trim(),
  );
}

function resolveBotToken(
  config: ReturnType<
    typeof getConfigSnapshot
  >['telegram'] = resolveTelegramConfig(),
): string {
  const token = String(TELEGRAM_BOT_TOKEN || config.botToken || '').trim();
  if (!token) {
    throw new Error('Telegram bot token is not configured.');
  }
  return token;
}

function resolveActiveTelegramConfig(): ReturnType<
  typeof getConfigSnapshot
>['telegram'] {
  return runtimeInitialized && activeTelegramConfig
    ? activeTelegramConfig
    : resolveTelegramConfig();
}

function resolveActiveBotToken(): string {
  return runtimeInitialized && activeBotToken
    ? activeBotToken
    : resolveBotToken();
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

async function dispatchUpdate(
  update: TelegramUpdate,
  messageHandler: TelegramMessageHandler,
): Promise<void> {
  const message = update.message;
  if (!message || !botUser) return;
  const botToken = resolveActiveBotToken();
  const telegramConfig = resolveActiveTelegramConfig();

  const inbound = await processInboundTelegramMessage({
    botToken,
    config: telegramConfig,
    message,
    botUser,
    agentId: DEFAULT_AGENT_ID,
  });
  if (!inbound) return;

  const controller = new AbortController();
  inFlightControllers.add(controller);
  if (shutdownController?.signal.aborted && !controller.signal.aborted) {
    controller.abort(createTelegramShutdownAbortError());
  }
  const reply: TelegramReplyFn = async (content) => {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error
        ? reason
        : createTelegramShutdownAbortError();
    }
    await sendChunkedTelegramText({
      botToken,
      target: inbound.channelId,
      text: content,
      replyToMessageId: message.message_id,
    });
  };

  const typingController = createTelegramTypingController(() =>
    sendTelegramTyping({
      botToken,
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
    inFlightControllers.delete(controller);
    typingController.stop();
  }
}

async function runPollingLoop(
  messageHandler: TelegramMessageHandler,
): Promise<void> {
  const botToken = resolveActiveBotToken();
  const telegramConfig = resolveActiveTelegramConfig();
  let offset = await readStoredUpdateOffset(botToken);
  let retryDelayMs = TELEGRAM_RETRY_BASE_MS;

  while (!shutdownController?.signal.aborted) {
    try {
      const updates = await getTelegramUpdates({
        botToken,
        offset,
        abortSignal: shutdownController?.signal as AbortSignal,
      });

      // Process each poll batch sequentially to preserve inbound ordering and
      // avoid concurrent writes against the same Telegram-backed session.
      // Throughput across unrelated chats is intentionally traded off here
      // until the runtime grows per-session dispatch isolation.
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await dispatchUpdate(update, messageHandler);
      }

      if (updates.length > 0) {
        await writeStoredUpdateOffset(botToken, offset);
      }

      const pollIntervalMs = Math.max(
        0,
        Math.min(telegramConfig.pollIntervalMs, 60_000),
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
}

export async function initTelegram(
  messageHandler: TelegramMessageHandler,
): Promise<void> {
  if (runtimeInitialized) return;

  const telegramConfig = resolveTelegramConfig();
  const botToken = resolveBotToken(telegramConfig);
  const resolvedBotUser = await callTelegramApi<TelegramUser>(
    botToken,
    'getMe',
  );
  registerChannel({
    kind: 'telegram',
    id: 'telegram',
    capabilities: TELEGRAM_CAPABILITIES,
  });

  activeTelegramConfig = telegramConfig;
  activeBotToken = botToken;
  botUser = resolvedBotUser;
  shutdownController = new AbortController();
  runtimeInitialized = true;
  pollTask = runPollingLoop(messageHandler).catch((error) => {
    if (!shutdownController?.signal.aborted) {
      logger.warn({ error }, 'Telegram runtime stopped unexpectedly');
    }
  });
}

export async function sendToTelegramChat(
  target: string,
  text: string,
): Promise<void> {
  await sendChunkedTelegramText({
    botToken: resolveActiveBotToken(),
    target,
    text,
  });
}

export async function sendTelegramMediaToChat(
  params: TelegramMediaSendParams,
): Promise<void> {
  await sendTelegramMedia({
    botToken: resolveActiveBotToken(),
    target: params.target,
    filePath: params.filePath,
    mimeType: params.mimeType,
    filename: params.filename,
    caption: params.caption,
    replyToMessageId: params.replyToMessageId,
  });
}

export async function shutdownTelegram(): Promise<void> {
  shutdownController?.abort();
  abortInFlightHandlers();
  await pollTask;
  pollTask = null;
  botUser = null;
  activeBotToken = null;
  activeTelegramConfig = null;
  shutdownController = null;
  runtimeInitialized = false;
}
