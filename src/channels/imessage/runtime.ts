import type { IncomingMessage, ServerResponse } from 'node:http';
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { IMESSAGE_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import type { IMessageMediaSendParams } from './backend.js';
import { createBlueBubblesIMessageBackend } from './backend-bluebubbles.js';
import { createLocalIMessageBackend } from './backend-local.js';
import {
  createIMessageDebouncer,
  type IMessageInboundBatch,
  shouldDebounceIMessageInbound,
} from './debounce.js';
import { createIMessageSelfEchoCache } from './self-echo-cache.js';
import type { IMessageMessageHandler, IMessageReplyFn } from './types.js';

export interface IMessageRuntime {
  initIMessage: (messageHandler: IMessageMessageHandler) => Promise<void>;
  sendToIMessageChat: (target: string, text: string) => Promise<void>;
  sendIMessageMediaToChat: (params: IMessageMediaSendParams) => Promise<void>;
  handleIMessageWebhook: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<boolean>;
  shutdownIMessage: () => Promise<void>;
}

export function createIMessageRuntime(): IMessageRuntime {
  let backend:
    | ReturnType<typeof createLocalIMessageBackend>
    | ReturnType<typeof createBlueBubblesIMessageBackend>
    | null = null;
  let inboundDebouncer: ReturnType<typeof createIMessageDebouncer> | null =
    null;
  let selfEchoCache: ReturnType<typeof createIMessageSelfEchoCache> | null =
    null;
  let runtimeInitialized = false;

  const ensureBackend = (
    messageHandler?: IMessageMessageHandler,
  ): NonNullable<typeof backend> => {
    if (backend) return backend;
    if (!messageHandler) {
      throw new Error('iMessage runtime is not initialized.');
    }
    const onInbound = async (
      message:
        | IMessageInboundBatch
        | Parameters<
            Parameters<typeof createLocalIMessageBackend>[0]['onInbound']
          >[0],
    ) => {
      const inbound = {
        ...message,
        rawEvents: [message.rawEvent],
      } satisfies IMessageInboundBatch;
      if (
        selfEchoCache?.has({
          channelId: inbound.channelId,
          messageId: inbound.messageId,
          text: inbound.content,
        })
      ) {
        logger.debug(
          { channelId: inbound.channelId, messageId: inbound.messageId },
          'Ignoring reflected iMessage outbound message',
        );
        return;
      }
      if (
        shouldDebounceIMessageInbound({
          content: inbound.content,
          hasMedia: inbound.media.length > 0,
        })
      ) {
        inboundDebouncer?.enqueue(
          inbound,
          getConfigSnapshot().imessage.debounceMs,
        );
        return;
      }
      await dispatchInboundBatch(inbound, messageHandler);
    };

    backend =
      getConfigSnapshot().imessage.backend === 'bluebubbles'
        ? createBlueBubblesIMessageBackend({ onInbound })
        : createLocalIMessageBackend({ onInbound });
    return backend;
  };

  const dispatchInboundBatch = async (
    batch: IMessageInboundBatch,
    messageHandler: IMessageMessageHandler,
  ): Promise<void> => {
    const controller = new AbortController();
    const reply: IMessageReplyFn = async (content) => {
      await runtime.sendToIMessageChat(batch.channelId, content);
    };
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
        inbound: batch,
        rawEvent: batch.rawEvent,
        backend: batch.backend,
        conversationId: batch.conversationId,
        handle: batch.handle,
        isGroup: batch.isGroup,
      },
    );
  };

  const runtime: IMessageRuntime = {
    async initIMessage(messageHandler: IMessageMessageHandler): Promise<void> {
      if (runtimeInitialized) return;
      runtimeInitialized = true;
      selfEchoCache = createIMessageSelfEchoCache();
      inboundDebouncer = createIMessageDebouncer(async (batch) => {
        await dispatchInboundBatch(batch, messageHandler);
      });
      registerChannel({
        kind: 'imessage',
        id: 'imessage',
        capabilities: IMESSAGE_CAPABILITIES,
      });
      await ensureBackend(messageHandler).start();
    },
    async sendToIMessageChat(target: string, text: string): Promise<void> {
      const refs = await ensureBackend().sendText(target, text);
      selfEchoCache?.remember(refs);
    },
    async sendIMessageMediaToChat(
      params: IMessageMediaSendParams,
    ): Promise<void> {
      const ref = await ensureBackend().sendMedia(params);
      if (ref) {
        selfEchoCache?.remember(ref);
      }
    },
    async handleIMessageWebhook(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<boolean> {
      const activeBackend = backend;
      if (!activeBackend?.handleWebhook) {
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end();
        }
        return false;
      }
      return await activeBackend.handleWebhook(req, res);
    },
    async shutdownIMessage(): Promise<void> {
      await inboundDebouncer?.flushAll();
      await backend?.shutdown();
      inboundDebouncer = null;
      selfEchoCache?.clear();
      selfEchoCache = null;
      backend = null;
      runtimeInitialized = false;
    },
  };

  return runtime;
}

const runtime = createIMessageRuntime();

export const initIMessage = runtime.initIMessage;
export const sendToIMessageChat = runtime.sendToIMessageChat;
export const sendIMessageMediaToChat = runtime.sendIMessageMediaToChat;
export const handleIMessageWebhook = runtime.handleIMessageWebhook;
export const shutdownIMessage = runtime.shutdownIMessage;
