import type { WAMessage } from '@whiskeysockets/baileys';
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types.js';
import { publishWorkflowEvent } from '../../workflow/event-bus.js';
import { WHATSAPP_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
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
import {
  cleanupWhatsAppInboundMedia,
  processInboundWhatsAppMessage,
} from './inbound.js';
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

export interface WhatsAppMediaSendParams {
  jid: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
}

export interface WhatsAppRuntime {
  initWhatsApp: (messageHandler: WhatsAppMessageHandler) => Promise<void>;
  sendToWhatsAppChat: (jid: string, text: string) => Promise<void>;
  sendWhatsAppMediaToChat: (params: WhatsAppMediaSendParams) => Promise<void>;
  shutdownWhatsApp: () => Promise<void>;
}

const SELF_CHAT_REPLY_PREFIX = '[hybridclaw]';
const SELF_CHAT_REPLY_PREFIX_RE = new RegExp(
  `^${SELF_CHAT_REPLY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`,
  'i',
);

function formatSelfChatReply(content: string): string {
  if (SELF_CHAT_REPLY_PREFIX_RE.test(content)) {
    return content;
  }
  const trimmed = content.trim();
  return trimmed
    ? `${SELF_CHAT_REPLY_PREFIX} ${trimmed}`
    : SELF_CHAT_REPLY_PREFIX;
}

export function createWhatsAppRuntime(): WhatsAppRuntime {
  let connectionManager: WhatsAppConnectionManager | null = null;
  let inboundDebouncer: ReturnType<typeof createWhatsAppDebouncer> | null =
    null;
  let selfEchoCache: ReturnType<typeof createWhatsAppSelfEchoCache> | null =
    null;
  let runtimeInitialized = false;

  const sendTextToChat = async (jid: string, text: string): Promise<void> => {
    const manager = ensureConnectionManager();
    const socket = await manager.waitForSocket();
    const refs = await sendChunkedWhatsAppText(
      socket,
      jid,
      text,
      manager.rememberSentMessage,
    );
    selfEchoCache?.remember(refs);
  };

  const sendMediaToChat = async (
    params: WhatsAppMediaSendParams,
  ): Promise<void> => {
    const manager = ensureConnectionManager();
    const socket = await manager.waitForSocket();
    const ref = await sendWhatsAppMedia({
      sock: socket,
      jid: params.jid,
      filePath: params.filePath,
      mimeType: params.mimeType,
      filename: params.filename,
      caption: params.caption,
      onSentMessage: manager.rememberSentMessage,
    });
    if (ref) {
      selfEchoCache?.remember(ref);
    }
  };

  const ensureConnectionManager = (
    messageHandler?: WhatsAppMessageHandler,
  ): WhatsAppConnectionManager => {
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
  };

  const resolveSelfJids = (socket: {
    user?: { id?: string; jid?: string; lid?: string };
  }): string[] => [
    ...new Set(
      [socket.user?.jid, socket.user?.id, socket.user?.lid].filter(
        (jid): jid is string => Boolean(jid),
      ),
    ),
  ];

  const dispatchInboundBatch = async (
    batch: WhatsAppInboundBatch,
    messageHandler: WhatsAppMessageHandler,
  ): Promise<void> => {
    const controller = new AbortController();
    const typingController = createWhatsAppTypingController(
      () => ensureConnectionManager().getSocket(),
      batch.chatJid,
    );
    const reply: WhatsAppReplyFn = async (content) => {
      await sendTextToChat(
        batch.chatJid,
        batch.isSelfChat ? formatSelfChatReply(content) : content,
      );
    };
    typingController.start();
    try {
      void publishWorkflowEvent({
        kind: 'message',
        sourceChannel: 'whatsapp',
        channelId: batch.channelId,
        senderId: batch.senderJid,
        senderAddress: batch.senderJid,
        content: batch.content,
        timestamp: Date.now(),
      }).catch((error) => {
        logger.debug(
          { error, sessionId: batch.sessionId, channelId: batch.channelId },
          'Failed to publish WhatsApp workflow event',
        );
      });
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
      await cleanupWhatsAppInboundMedia(batch.media).catch((error) => {
        logger.debug(
          {
            error,
            sessionId: batch.sessionId,
            channelId: batch.channelId,
          },
          'Failed to clean up WhatsApp inbound media',
        );
      });
    }
  };

  const handleUpsertedMessage = async (
    message: WAMessage,
    batchedMessages: WAMessage[],
    messageHandler: WhatsAppMessageHandler,
  ): Promise<void> => {
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
      selfJids: resolveSelfJids(socket),
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
  };

  return {
    async initWhatsApp(messageHandler: WhatsAppMessageHandler): Promise<void> {
      if (runtimeInitialized) return;
      runtimeInitialized = true;
      selfEchoCache = createWhatsAppSelfEchoCache();
      inboundDebouncer = createWhatsAppDebouncer(async (batch) => {
        await dispatchInboundBatch(batch, messageHandler);
      });
      await ensureConnectionManager(messageHandler).start();
    },
    async sendToWhatsAppChat(jid: string, text: string): Promise<void> {
      await sendTextToChat(jid, text);
    },
    async sendWhatsAppMediaToChat(
      params: WhatsAppMediaSendParams,
    ): Promise<void> {
      await sendMediaToChat(params);
    },
    async shutdownWhatsApp(): Promise<void> {
      await inboundDebouncer?.flushAll();
      await connectionManager?.stop();
      selfEchoCache?.clear();
      inboundDebouncer = null;
      connectionManager = null;
      selfEchoCache = null;
      runtimeInitialized = false;
    },
  };
}

let defaultRuntime: WhatsAppRuntime | null = null;

function ensureDefaultRuntime(): WhatsAppRuntime {
  defaultRuntime ??= createWhatsAppRuntime();
  return defaultRuntime;
}

export async function initWhatsApp(
  messageHandler: WhatsAppMessageHandler,
): Promise<void> {
  registerChannel({
    kind: 'whatsapp',
    id: 'whatsapp',
    capabilities: WHATSAPP_CAPABILITIES,
  });
  await ensureDefaultRuntime().initWhatsApp(messageHandler);
}

export async function sendToWhatsAppChat(
  jid: string,
  text: string,
): Promise<void> {
  await ensureDefaultRuntime().sendToWhatsAppChat(jid, text);
}

export async function sendWhatsAppMediaToChat(
  params: WhatsAppMediaSendParams,
): Promise<void> {
  await ensureDefaultRuntime().sendWhatsAppMediaToChat(params);
}

export async function shutdownWhatsApp(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = null;
  await runtime?.shutdownWhatsApp();
}
