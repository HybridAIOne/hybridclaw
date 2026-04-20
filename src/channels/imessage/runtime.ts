import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { memoryService } from '../../memory/memory-service.js';
import { parseSessionKey } from '../../session/session-key.js';
import { IMESSAGE_CAPABILITIES } from '../channel.js';
import { createChannelRuntime } from '../channel-runtime-factory.js';
import type { IMessageMediaSendParams } from './backend.js';
import { createBlueBubblesIMessageBackend } from './backend-bluebubbles.js';
import { createLocalIMessageBackend } from './backend-local.js';
import {
  createIMessageDebouncer,
  type IMessageInboundBatch,
  shouldDebounceIMessageInbound,
} from './debounce.js';
import { normalizeIMessageHandle } from './handle.js';
import {
  createIMessageSelfChatGuard,
  type IMessageLocalSelfChatMetadata,
} from './self-chat-guard.js';
import type { IMessageMessageHandler, IMessageReplyFn } from './types.js';

const SELF_CHAT_REPLY_PREFIX_RE = /^\[[^\]]+\](?:\s|$)/i;
const IMESSAGE_NOOP_ABORT_SIGNAL = new AbortController().signal;

function resolveSelfChatReplyPrefix(sessionId: string): string {
  const sessionAgentId =
    memoryService.getSessionById(sessionId)?.agent_id?.trim() || '';
  const agentId =
    sessionAgentId || parseSessionKey(sessionId)?.agentId || DEFAULT_AGENT_ID;
  if (agentId === DEFAULT_AGENT_ID) {
    return '[hybridclaw]';
  }

  const config = getConfigSnapshot();
  const agent = (config.agents.list || []).find(
    (entry) => entry.id === agentId,
  );
  const label =
    String(agent?.displayName || '').trim() ||
    String(agent?.name || '').trim() ||
    agentId;
  return `[${label}]`;
}

function formatSelfChatReply(content: string, sessionId: string): string {
  if (SELF_CHAT_REPLY_PREFIX_RE.test(content)) {
    return content;
  }
  const prefix = resolveSelfChatReplyPrefix(sessionId);
  const trimmed = content.trim();
  return trimmed ? `${prefix} ${trimmed}` : prefix;
}

export function createIMessageRuntime() {
  let backend:
    | ReturnType<typeof createLocalIMessageBackend>
    | ReturnType<typeof createBlueBubblesIMessageBackend>
    | null = null;
  let inboundDebouncer: ReturnType<typeof createIMessageDebouncer> | null =
    null;
  let selfChatGuard: ReturnType<typeof createIMessageSelfChatGuard> | null =
    null;

  const readLocalSelfChatMetadata = (
    message: IMessageInboundBatch,
  ): IMessageLocalSelfChatMetadata | null => {
    if (message.backend !== 'local' || message.isGroup) {
      return null;
    }
    const rawEvent =
      message.rawEvent && typeof message.rawEvent === 'object'
        ? (message.rawEvent as {
            isFromMe?: number | boolean | null;
            handle?: string | null;
            chatIdentifier?: string | null;
            messageDate?: number | string | null;
          })
        : null;
    if (!rawEvent) {
      return null;
    }

    const sender = normalizeIMessageHandle(
      String(rawEvent.handle || rawEvent.chatIdentifier || message.handle),
    );
    const chatIdentifier = normalizeIMessageHandle(
      String(rawEvent.chatIdentifier || ''),
    );
    if (!sender || !chatIdentifier || sender !== chatIdentifier) {
      return null;
    }

    return {
      isFromMe: rawEvent.isFromMe === true || rawEvent.isFromMe === 1,
    };
  };

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
      const selfChatMetadata = readLocalSelfChatMetadata(inbound);
      const decision = selfChatGuard?.shouldDropInbound({
        inbound,
        selfChatMetadata,
      });
      if (decision?.drop) {
        logger.debug(
          { channelId: inbound.channelId, messageId: inbound.messageId },
          decision.reason,
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
    const reply: IMessageReplyFn = async (content) => {
      await runtime.sendToIMessageChat(
        batch.channelId,
        readLocalSelfChatMetadata(batch)
          ? formatSelfChatReply(content, batch.sessionId)
          : content,
      );
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
        abortSignal: IMESSAGE_NOOP_ABORT_SIGNAL,
        inbound: batch,
      },
    );
  };
  const runtimeLifecycle = createChannelRuntime<IMessageMessageHandler>({
    kind: 'imessage',
    capabilities: IMESSAGE_CAPABILITIES,
    start: async ({ handler }) => {
      selfChatGuard = createIMessageSelfChatGuard({
        resolveReplyPrefix: resolveSelfChatReplyPrefix,
      });
      inboundDebouncer = createIMessageDebouncer(async (batch) => {
        await dispatchInboundBatch(batch, handler);
      });
      await ensureBackend(handler).start();
    },
    cleanup: async () => {
      await inboundDebouncer?.flushAll();
      await backend?.shutdown();
      inboundDebouncer = null;
      selfChatGuard?.clear();
      selfChatGuard = null;
      backend = null;
    },
  });

  const runtime = {
    initIMessage: runtimeLifecycle.init,
    async sendToIMessageChat(target: string, text: string): Promise<void> {
      const refs = await ensureBackend().sendText(target, text);
      selfChatGuard?.rememberOutbound(refs);
    },
    async sendIMessageMediaToChat(
      params: IMessageMediaSendParams,
    ): Promise<void> {
      const ref = await ensureBackend().sendMedia(params);
      if (ref) {
        selfChatGuard?.rememberOutbound(ref);
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
    shutdownIMessage: runtimeLifecycle.shutdown,
  };

  return runtime;
}

const runtime = createIMessageRuntime();

export const initIMessage = runtime.initIMessage;
export const sendToIMessageChat = runtime.sendToIMessageChat;
export const sendIMessageMediaToChat = runtime.sendIMessageMediaToChat;
export const handleIMessageWebhook = runtime.handleIMessageWebhook;
export const shutdownIMessage = runtime.shutdownIMessage;
