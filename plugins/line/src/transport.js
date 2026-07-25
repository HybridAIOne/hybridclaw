import { createLineConnectionManager } from './connection.js';
import { sendChunkedLineText } from './delivery.js';
import { processInboundLineSelfMessage } from './inbound.js';

/**
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').LineTransportHost} LineTransportHost
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').ChannelTransportInstance} ChannelTransportInstance
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').ChannelTransportMessageHandler} ChannelTransportMessageHandler
 */

const LINE_REPLY_PREFIX = '[HybridClaw]';

/**
 * @param {string} content
 * @returns {string}
 */
function formatLineSelfReply(content) {
  const trimmed = content.trim();
  if (/^\[HybridClaw\](?:\s|$)/i.test(trimmed)) return trimmed;
  return trimmed ? `${LINE_REPLY_PREFIX} ${trimmed}` : LINE_REPLY_PREFIX;
}

/**
 * @param {LineTransportHost} host
 * @returns {ChannelTransportInstance}
 */
export function createLineTransport(host) {
  let connectionManager = null;
  let messageHandler = null;
  let shuttingDown = false;
  const inFlightControllers = new Set();

  const sendTextToSelf = async (target, text) => {
    const manager = connectionManager;
    if (!manager) throw new Error('LINE runtime is not initialized.');
    const client = await manager.waitForClient();
    const selfMid = manager.getSelfMid();
    if (!selfMid) throw new Error('LINE account identity is unavailable.');
    const targetMid = host.target.normalizeUserMid(target);
    if (!targetMid || targetMid !== selfMid) {
      throw new Error('LINE channel only permits sends to the linked account.');
    }
    await sendChunkedLineText({
      client,
      to: selfMid,
      text: formatLineSelfReply(text),
      limit: host.getConfig().textChunkLimit,
    });
  };

  const handleMessage = async (rawMessage) => {
    const handler = messageHandler;
    const manager = connectionManager;
    const selfMid = manager?.getSelfMid();
    if (!handler || !manager || !selfMid || shuttingDown) return;
    const client = manager.getClient();
    const inbound = processInboundLineSelfMessage(host, {
      message: rawMessage,
      selfMid,
      displayName: client?.base.profile?.displayName,
    });
    if (!inbound) return;

    const controller = new AbortController();
    inFlightControllers.add(controller);
    const reply = async (content) => {
      if (controller.signal.aborted) {
        throw new Error('LINE message handling was cancelled.');
      }
      await sendTextToSelf(inbound.channelId, content);
    };
    try {
      await handler(
        inbound.sessionId,
        inbound.guildId,
        inbound.channelId,
        inbound.userId,
        inbound.username,
        inbound.content,
        [],
        reply,
        {
          abortSignal: controller.signal,
          batchedMessages: [rawMessage],
          rawMessage,
          chatJid: inbound.channelId,
          senderJid: inbound.userId,
          isGroup: false,
        },
      );
    } finally {
      inFlightControllers.delete(controller);
    }
  };

  return {
    /**
     * @param {ChannelTransportMessageHandler} handler
     */
    async init(handler) {
      shuttingDown = false;
      messageHandler = handler;
      connectionManager = createLineConnectionManager(host, {
        onMessage: (message) => {
          void handleMessage(message).catch((error) => {
            host.logger.warn({ error }, 'LINE message handling failed');
          });
        },
      });
      await connectionManager.start();
    },
    async shutdown() {
      shuttingDown = true;
      for (const controller of inFlightControllers) {
        controller.abort(new Error('LINE runtime shutting down.'));
      }
      inFlightControllers.clear();
      await connectionManager?.stop();
      connectionManager = null;
      messageHandler = null;
    },
    async sendText(channelId, text) {
      const normalized = host.target.normalizeChannelId(channelId);
      if (!normalized) throw new Error(`Invalid LINE channel id: ${channelId}`);
      await sendTextToSelf(normalized, text);
    },
    async sendMedia() {
      throw new Error('LINE self-chat does not support media delivery.');
    },
    async createPairingSession() {
      const manager = createLineConnectionManager(host);
      return {
        start: () => manager.start(),
        async waitForConnection() {
          await manager.waitForClient();
          return { id: manager.getSelfMid() };
        },
        stop: () => manager.stop(),
      };
    },
  };
}
