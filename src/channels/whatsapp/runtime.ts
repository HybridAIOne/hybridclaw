import type { WAMessage } from '@whiskeysockets/baileys';
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types.js';
import {
  createWhatsAppConnectionManager,
  type WhatsAppConnectionManager,
} from './connection.js';
import {
  createWhatsAppDebouncer,
  shouldDebounceWhatsAppInbound,
  type WhatsAppInboundBatch,
} from './debounce.js';
import {
  sendChunkedWhatsAppText,
  sendWhatsAppMedia,
  sendWhatsAppReaction,
  sendWhatsAppReadReceipt,
} from './delivery.js';
import { processInboundWhatsAppMessage } from './inbound.js';
import { createWhatsAppSelfEchoCache } from './self-echo-cache.js';
import { createWhatsAppTypingController } from './typing.js';

export type WhatsAppReplyFn = (content: string) => Promise<void>;

export interface WhatsAppMessageContext {
  abortSignal: AbortSignal;
  batchedMessages: WAMessage[];
  rawMessage: WAMessage;
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
}

export type WhatsAppMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: WhatsAppReplyFn,
  context: WhatsAppMessageContext,
) => Promise<void>;

let connectionManager: WhatsAppConnectionManager | null = null;
let inboundDebouncer: ReturnType<typeof createWhatsAppDebouncer> | null = null;
let selfEchoCache: ReturnType<typeof createWhatsAppSelfEchoCache> | null = null;
let runtimeInitialized = false;
const SELF_CHAT_REPLY_PREFIX = '[hybridclaw]';

function formatSelfChatReply(content: string): string {
  if (/^\[hybridclaw\](?:\s|$)/i.test(content)) {
    return content;
  }
  const trimmed = content.trim();
  return trimmed
    ? `${SELF_CHAT_REPLY_PREFIX} ${trimmed}`
    : SELF_CHAT_REPLY_PREFIX;
}

function ensureConnectionManager(
  messageHandler?: WhatsAppMessageHandler,
): WhatsAppConnectionManager {
  if (connectionManager) return connectionManager;

  connectionManager = createWhatsAppConnectionManager({
    onSocketCreated: (socket) => {
      if (!messageHandler) return;
      socket.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const message of messages) {
          void handleUpsertedMessage(message, messages, messageHandler);
        }
      });
    },
  });
  return connectionManager;
}

async function dispatchInboundBatch(
  batch: WhatsAppInboundBatch,
  messageHandler: WhatsAppMessageHandler,
): Promise<void> {
  const controller = new AbortController();
  const typingController = createWhatsAppTypingController(
    () => ensureConnectionManager().getSocket(),
    batch.chatJid,
  );
  const reply: WhatsAppReplyFn = async (content) => {
    await sendToWhatsAppChat(
      batch.chatJid,
      batch.isSelfChat ? formatSelfChatReply(content) : content,
    );
  };
  typingController.start();
  try {
    await messageHandler(
      batch.sessionId,
      batch.guildId,
      batch.channelId,
      batch.userId,
      batch.username,
      batch.content,
      batch.media,
      reply,
      {
        abortSignal: controller.signal,
        batchedMessages: batch.batchedMessages,
        rawMessage: batch.rawMessage,
        chatJid: batch.chatJid,
        senderJid: batch.senderJid,
        isGroup: batch.isGroup,
      },
    );
  } finally {
    typingController.stop();
  }
}

async function handleUpsertedMessage(
  message: WAMessage,
  batchedMessages: WAMessage[],
  messageHandler: WhatsAppMessageHandler,
): Promise<void> {
  const remoteJid = message.key.remoteJid?.trim();
  const messageId = message.key.id?.trim();
  if (
    message.key.fromMe &&
    selfEchoCache?.has({
      chatJid: remoteJid,
      messageId,
    })
  ) {
    logger.debug(
      { jid: remoteJid || null, messageId: messageId || null },
      'Ignoring reflected WhatsApp outbound message',
    );
    return;
  }

  const manager = ensureConnectionManager();
  const socket = manager.getSocket();
  if (!socket) return;

  const config = getConfigSnapshot().whatsapp;
  const inbound = await processInboundWhatsAppMessage({
    message,
    sock: socket,
    config,
    selfJid: socket.user?.id ?? null,
  });
  if (!inbound) return;

  if (config.ackReaction.trim()) {
    void sendWhatsAppReaction({
      sock: socket,
      jid: inbound.chatJid,
      key: message.key,
      emoji: config.ackReaction,
    }).catch((error) => {
      logger.debug(
        { error, jid: inbound.chatJid },
        'WhatsApp ack reaction failed',
      );
    });
  }
  if (config.sendReadReceipts && !inbound.isSelfChat) {
    void sendWhatsAppReadReceipt(socket, message).catch((error) => {
      logger.debug(
        { error, jid: inbound.chatJid },
        'WhatsApp read receipt failed',
      );
    });
  }

  const batch: WhatsAppInboundBatch = {
    ...inbound,
    batchedMessages,
  };
  if (
    shouldDebounceWhatsAppInbound({
      content: inbound.content,
      hasMedia: inbound.media.length > 0,
    })
  ) {
    inboundDebouncer?.enqueue(batch, config.debounceMs);
    return;
  }

  await dispatchInboundBatch(batch, messageHandler);
}

export async function initWhatsApp(
  messageHandler: WhatsAppMessageHandler,
): Promise<void> {
  if (runtimeInitialized) return;
  runtimeInitialized = true;
  selfEchoCache = createWhatsAppSelfEchoCache();
  inboundDebouncer = createWhatsAppDebouncer(async (batch) => {
    await dispatchInboundBatch(batch, messageHandler);
  });
  await ensureConnectionManager(messageHandler).start();
}

export async function sendToWhatsAppChat(
  jid: string,
  text: string,
): Promise<void> {
  const socket = await ensureConnectionManager().waitForSocket();
  const refs = await sendChunkedWhatsAppText(socket, jid, text);
  selfEchoCache?.remember(refs);
}

export async function sendWhatsAppMediaToChat(params: {
  jid: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
}): Promise<void> {
  const socket = await ensureConnectionManager().waitForSocket();
  const ref = await sendWhatsAppMedia({
    sock: socket,
    jid: params.jid,
    filePath: params.filePath,
    mimeType: params.mimeType,
    filename: params.filename,
    caption: params.caption,
  });
  if (ref) {
    selfEchoCache?.remember(ref);
  }
}

export async function shutdownWhatsApp(): Promise<void> {
  await inboundDebouncer?.flushAll();
  await connectionManager?.stop();
  selfEchoCache?.clear();
  inboundDebouncer = null;
  connectionManager = null;
  selfEchoCache = null;
  runtimeInitialized = false;
}
