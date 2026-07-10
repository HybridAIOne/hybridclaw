import type { TalkMessage } from '@jsr/evex__linejs';
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { LINE_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import { createChannelRuntime } from '../channel-runtime-factory.js';
import {
  createLineConnectionManager,
  type LineConnectionManager,
} from './connection.js';
import { sendChunkedLineText } from './delivery.js';
import { processInboundLineSelfMessage } from './inbound.js';
import { normalizeLineChannelId, normalizeLineUserMid } from './target.js';

export type LineReplyFn = (content: string) => Promise<void>;

export interface LineMessageContext {
  abortSignal: AbortSignal;
  rawMessage: TalkMessage;
  selfMid: string;
}

export type LineMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  reply: LineReplyFn,
  context: LineMessageContext,
) => Promise<void>;

const LINE_REPLY_PREFIX = '[HybridClaw]';

function formatLineSelfReply(content: string): string {
  const trimmed = content.trim();
  if (/^\[HybridClaw\](?:\s|$)/i.test(trimmed)) return trimmed;
  return trimmed ? `${LINE_REPLY_PREFIX} ${trimmed}` : LINE_REPLY_PREFIX;
}

export function createLineRuntime() {
  let connectionManager: LineConnectionManager | null = null;
  let messageHandler: LineMessageHandler | null = null;
  let shuttingDown = false;
  const inFlightControllers = new Set<AbortController>();

  const sendTextToSelf = async (
    target: string,
    text: string,
  ): Promise<void> => {
    const manager = connectionManager;
    if (!manager) throw new Error('LINE runtime is not initialized.');
    const client = await manager.waitForClient();
    const selfMid = manager.getSelfMid();
    if (!selfMid) throw new Error('LINE account identity is unavailable.');
    const targetMid = normalizeLineUserMid(target);
    if (!targetMid || targetMid !== selfMid) {
      throw new Error('LINE channel only permits sends to the linked account.');
    }
    await sendChunkedLineText({
      client,
      to: selfMid,
      text: formatLineSelfReply(text),
      limit: getConfigSnapshot().line.textChunkLimit,
    });
  };

  const handleMessage = async (rawMessage: TalkMessage): Promise<void> => {
    const handler = messageHandler;
    const manager = connectionManager;
    const selfMid = manager?.getSelfMid();
    if (!handler || !manager || !selfMid || shuttingDown) return;
    const client = manager.getClient();
    const inbound = processInboundLineSelfMessage({
      message: rawMessage,
      selfMid,
      displayName: client?.base.profile?.displayName,
    });
    if (!inbound) return;

    registerChannel({
      kind: 'line',
      id: inbound.channelId,
      capabilities: LINE_CAPABILITIES,
    });
    const controller = new AbortController();
    inFlightControllers.add(controller);
    const reply: LineReplyFn = async (content) => {
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
        reply,
        {
          abortSignal: controller.signal,
          rawMessage,
          selfMid,
        },
      );
    } finally {
      inFlightControllers.delete(controller);
    }
  };

  const lifecycle = createChannelRuntime<LineMessageHandler>()({
    kind: 'line',
    capabilities: LINE_CAPABILITIES,
    start: async ({ handler }) => {
      shuttingDown = false;
      messageHandler = handler;
      connectionManager = createLineConnectionManager({
        onMessage: (message) => {
          void handleMessage(message).catch((error) => {
            logger.warn({ error }, 'LINE message handling failed');
          });
        },
      });
      await connectionManager.start();
    },
    cleanup: async () => {
      shuttingDown = true;
      for (const controller of inFlightControllers) {
        controller.abort(new Error('LINE runtime shutting down.'));
      }
      inFlightControllers.clear();
      await connectionManager?.stop();
      connectionManager = null;
      messageHandler = null;
    },
  });

  return {
    initLine: lifecycle.init,
    async sendToLineSelfChat(channelId: string, text: string): Promise<void> {
      const normalized = normalizeLineChannelId(channelId);
      if (!normalized) throw new Error(`Invalid LINE channel id: ${channelId}`);
      await sendTextToSelf(normalized, text);
    },
    shutdownLine: lifecycle.shutdown,
  };
}

let defaultRuntime: ReturnType<typeof createLineRuntime> | null = null;

function ensureDefaultRuntime(): ReturnType<typeof createLineRuntime> {
  defaultRuntime ??= createLineRuntime();
  return defaultRuntime;
}

export const initLine = (handler: LineMessageHandler): Promise<void> =>
  ensureDefaultRuntime().initLine(handler);

export const sendToLineSelfChat = (
  channelId: string,
  text: string,
): Promise<void> => ensureDefaultRuntime().sendToLineSelfChat(channelId, text);

export async function shutdownLine(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = null;
  await runtime?.shutdownLine();
}
