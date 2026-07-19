import type {
  ChannelTransportInstance,
  ChannelTransportMediaSendParams,
  ChannelTransportMessageHandler,
  ChannelTransportReplyFn,
  WhatsAppTransportHost,
} from '@hybridaione/hybridclaw/plugin-sdk';
import type { WAMessage } from '@whiskeysockets/baileys';
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
  clearWhatsAppReaction,
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

const SELF_CHAT_REPLY_PREFIX = '[hybridclaw]';
const APPEND_RECENT_GRACE_MS = 60_000;
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

function parseMessageTimestampMs(message: WAMessage): number | null {
  const raw = message.messageTimestamp;
  if (raw == null) return null;
  const parsed =
    typeof raw === 'number'
      ? raw
      : Number(typeof raw === 'object' ? raw.toString() : raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed * 1000;
}

function buildReactionCleanupTargets(
  messages: WAMessage[],
): Array<{ jid: string; key: WAMessage['key'] }> {
  const seen = new Set<string>();
  const targets: Array<{ jid: string; key: WAMessage['key'] }> = [];
  for (const message of messages) {
    const jid = message.key.remoteJid?.trim();
    const id = message.key.id?.trim();
    if (!jid || !id) continue;
    const dedupeKey = `${jid}:${id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    targets.push({ jid, key: message.key });
  }
  return targets;
}

export function createWhatsAppTransport(
  host: WhatsAppTransportHost,
): ChannelTransportInstance {
  let connectionManager: WhatsAppConnectionManager | null = null;
  let inboundDebouncer: ReturnType<typeof createWhatsAppDebouncer> | null =
    null;
  let selfEchoCache: ReturnType<typeof createWhatsAppSelfEchoCache> | null =
    null;
  let shuttingDown = false;
  const inFlightControllers = new Set<AbortController>();

  const createShutdownAbortError = (): Error =>
    new Error('WhatsApp runtime shutting down.');

  const throwIfAborted = (signal: AbortSignal): void => {
    if (!signal.aborted) return;
    const reason = signal.reason;
    throw reason instanceof Error ? reason : createShutdownAbortError();
  };

  const abortInFlightHandlers = (): void => {
    for (const controller of inFlightControllers) {
      if (controller.signal.aborted) continue;
      controller.abort(createShutdownAbortError());
    }
  };

  const sendTextToChat = async (jid: string, text: string): Promise<void> => {
    const manager = ensureConnectionManager();
    const socket = await manager.waitForSocket();
    await sendChunkedWhatsAppText(host, socket, jid, text, async (sent) => {
      selfEchoCache?.remember({
        chatJid: sent?.key.remoteJid?.trim() || jid,
        messageId: sent?.key.id?.trim() || null,
      });
      await manager.rememberSentMessage(sent);
    });
  };

  const sendMediaToChat = async (
    params: ChannelTransportMediaSendParams,
  ): Promise<void> => {
    const manager = ensureConnectionManager();
    const socket = await manager.waitForSocket();
    const ref = await sendWhatsAppMedia({
      host,
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
    messageHandler?: ChannelTransportMessageHandler,
  ): WhatsAppConnectionManager => {
    if (connectionManager) return connectionManager;

    connectionManager = createWhatsAppConnectionManager(host, {
      onSocketCreated: (socket) => {
        if (!messageHandler) return;
        socket.ev.on('messages.upsert', ({ messages, type }) => {
          if (type !== 'notify' && type !== 'append') return;
          for (const message of messages) {
            void handleUpsertedMessage(
              message,
              messages,
              type,
              messageHandler,
            ).catch((error) => {
              host.logger.debug(
                {
                  error,
                  jid: message.key.remoteJid ?? null,
                  messageId: message.key.id ?? null,
                },
                shuttingDown
                  ? 'WhatsApp inbound message cancelled during shutdown'
                  : 'WhatsApp inbound message handling failed',
              );
            });
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
    messageHandler: ChannelTransportMessageHandler,
  ): Promise<void> => {
    const controller = new AbortController();
    inFlightControllers.add(controller);
    if (shuttingDown) {
      controller.abort(createShutdownAbortError());
    }
    const typingController = createWhatsAppTypingController(
      host,
      () => connectionManager?.getSocket() ?? null,
      batch.chatJid,
    );
    const stopTypingOnAbort = (): void => {
      typingController.stop();
    };
    controller.signal.addEventListener('abort', stopTypingOnAbort, {
      once: true,
    });
    const reply: ChannelTransportReplyFn = async (content) => {
      throwIfAborted(controller.signal);
      await sendTextToChat(
        batch.chatJid,
        batch.isSelfChat ? formatSelfChatReply(content) : content,
      );
    };
    const reactionCleanupTargets = batch.ackReaction
      ? buildReactionCleanupTargets(batch.batchedMessages)
      : [];
    try {
      throwIfAborted(controller.signal);
      typingController.start();
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
      controller.signal.removeEventListener('abort', stopTypingOnAbort);
      inFlightControllers.delete(controller);
      typingController.stop();
      const socket = connectionManager?.getSocket() ?? null;
      if (socket && reactionCleanupTargets.length > 0) {
        await Promise.all(
          reactionCleanupTargets.map(({ jid, key }) =>
            clearWhatsAppReaction({
              sock: socket,
              jid,
              key,
            }).catch((error) => {
              host.logger.debug(
                { error, jid, messageId: key.id ?? null },
                'WhatsApp ack reaction cleanup failed',
              );
            }),
          ),
        );
      }
      await cleanupWhatsAppInboundMedia(host, batch.media).catch((error) => {
        host.logger.debug(
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
    upsertType: 'notify' | 'append',
    messageHandler: ChannelTransportMessageHandler,
  ): Promise<void> => {
    if (upsertType === 'append') {
      const messageTimestampMs = parseMessageTimestampMs(message);
      if (
        messageTimestampMs == null ||
        messageTimestampMs < Date.now() - APPEND_RECENT_GRACE_MS
      ) {
        return;
      }
    }

    const remoteJid = message.key.remoteJid?.trim();
    const messageId = message.key.id?.trim();
    if (
      message.key.fromMe &&
      selfEchoCache?.has({
        chatJid: remoteJid,
        messageId,
      })
    ) {
      host.logger.debug(
        { jid: remoteJid || null, messageId: messageId || null },
        'Ignoring reflected WhatsApp outbound message',
      );
      return;
    }

    const manager = ensureConnectionManager();
    const socket = manager.getSocket();
    if (!socket) return;

    const config = host.getConfig();
    const inbound = await processInboundWhatsAppMessage(host, {
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
        host.logger.debug(
          { error, jid: inbound.chatJid },
          'WhatsApp ack reaction failed',
        );
      });
    }
    if (config.sendReadReceipts && !inbound.isSelfChat) {
      void sendWhatsAppReadReceipt(socket, message).catch((error) => {
        host.logger.debug(
          { error, jid: inbound.chatJid },
          'WhatsApp read receipt failed',
        );
      });
    }

    const batch: WhatsAppInboundBatch = {
      ...inbound,
      ackReaction: config.ackReaction.trim(),
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
  let initialized = false;
  let initializing: Promise<void> | null = null;

  const init = async (
    handler: ChannelTransportMessageHandler,
  ): Promise<void> => {
    if (initialized) return;
    initializing ??= (async () => {
      shuttingDown = false;
      inFlightControllers.clear();
      selfEchoCache = createWhatsAppSelfEchoCache();
      inboundDebouncer = createWhatsAppDebouncer(async (batch) => {
        await dispatchInboundBatch(batch, handler).catch((error) => {
          host.logger.debug(
            {
              error,
              sessionId: batch.sessionId,
              channelId: batch.channelId,
            },
            shuttingDown
              ? 'WhatsApp debounced batch cancelled during shutdown'
              : 'WhatsApp debounced batch handling failed',
          );
        });
      });
      await ensureConnectionManager(handler).start();
      initialized = true;
    })().finally(() => {
      initializing = null;
    });
    await initializing;
  };

  const shutdown = async (): Promise<void> => {
    shuttingDown = true;
    abortInFlightHandlers();
    inFlightControllers.clear();
    inboundDebouncer?.cancelAll();
    await connectionManager?.stop();
    selfEchoCache?.clear();
    inboundDebouncer = null;
    connectionManager = null;
    selfEchoCache = null;
    initialized = false;
    initializing = null;
  };

  return {
    init,
    async sendText(jid: string, text: string): Promise<void> {
      await sendTextToChat(jid, text);
    },
    async sendMedia(params: ChannelTransportMediaSendParams): Promise<void> {
      await sendMediaToChat(params);
    },
    shutdown,
    async createPairingSession() {
      const manager = createWhatsAppConnectionManager(host);
      return {
        start: () => manager.start(),
        async waitForConnection() {
          const socket = await manager.waitForSocket();
          return { id: socket.user?.id?.trim() || null };
        },
        stop: () => manager.stop(),
      };
    },
  };
}
