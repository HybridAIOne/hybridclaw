import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { memoryService } from '../../memory/memory-service.js';
import { parseSessionKey } from '../../session/session-key.js';
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
import { normalizeIMessageHandle } from './handle.js';
import { createIMessageInboundDedupeCache } from './inbound-dedupe-cache.js';
import { createIMessageSelfChatCache } from './self-chat-cache.js';
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

const SELF_CHAT_REPLY_PREFIX_RE = /^\[[^\]]+\](?:\s|$)/i;
const SELF_CHAT_MIRROR_TTL_MS = 15_000;

interface SelfChatMirrorEntry {
  seenAt: number;
  isFromMe: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function isReflectedSelfChatReply(content: string, sessionId: string): boolean {
  const prefix = resolveSelfChatReplyPrefix(sessionId);
  const bareLabel = prefix.slice(1, -1).trim();
  if (!bareLabel) return false;
  const reflectionPrefixRe = new RegExp(
    `^(?:\\S{1,3}\\s*)?\\[?${escapeRegExp(bareLabel)}\\](?:\\s|$)`,
    'i',
  );
  return reflectionPrefixRe.test(content.trimStart());
}

function normalizeSelfChatMirrorText(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, 256);
}

function buildSelfChatMirrorKey(params: {
  channelId: string;
  text: string;
}): string | null {
  const channelId = String(params.channelId || '').trim();
  const text = normalizeSelfChatMirrorText(params.text);
  if (!channelId || !text) return null;
  return `${channelId}:${text}`;
}

export function createIMessageRuntime(): IMessageRuntime {
  let backend:
    | ReturnType<typeof createLocalIMessageBackend>
    | ReturnType<typeof createBlueBubblesIMessageBackend>
    | null = null;
  let inboundDebouncer: ReturnType<typeof createIMessageDebouncer> | null =
    null;
  let inboundDedupeCache: ReturnType<
    typeof createIMessageInboundDedupeCache
  > | null = null;
  let selfEchoCache: ReturnType<typeof createIMessageSelfEchoCache> | null =
    null;
  let selfChatCache: ReturnType<typeof createIMessageSelfChatCache> | null =
    null;
  let selfChatMirrorCache: Map<string, SelfChatMirrorEntry> | null = null;
  let runtimeInitialized = false;

  const readLocalSelfChatMetadata = (
    message: IMessageInboundBatch,
  ): { isFromMe: boolean; createdAt: number | string | null } | null => {
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
      createdAt: rawEvent.messageDate ?? null,
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
      if (
        selfChatMetadata &&
        isReflectedSelfChatReply(inbound.content, inbound.sessionId)
      ) {
        logger.debug(
          { channelId: inbound.channelId, messageId: inbound.messageId },
          'Ignoring reflected local self-chat iMessage marker message',
        );
        return;
      }
      if (
        inboundDedupeCache?.has({
          channelId: inbound.channelId,
          messageId: inbound.messageId,
        })
      ) {
        logger.debug(
          { channelId: inbound.channelId, messageId: inbound.messageId },
          'Ignoring duplicate iMessage inbound message',
        );
        return;
      }
      inboundDedupeCache?.remember({
        channelId: inbound.channelId,
        messageId: inbound.messageId,
      });
      if (selfChatMetadata?.isFromMe) {
        selfChatCache?.remember({
          channelId: inbound.channelId,
          createdAt: selfChatMetadata.createdAt,
          text: inbound.content,
        });
        if (
          selfEchoCache?.has({
            channelId: inbound.channelId,
            messageId: inbound.messageId,
            text: inbound.content,
            skipIdShortCircuit: true,
          })
        ) {
          logger.debug(
            { channelId: inbound.channelId, messageId: inbound.messageId },
            'Ignoring local self-chat iMessage echo',
          );
          return;
        }
      }
      if (
        !selfChatMetadata?.isFromMe &&
        selfChatMetadata &&
        selfChatCache?.has({
          channelId: inbound.channelId,
          createdAt: selfChatMetadata.createdAt,
          text: inbound.content,
        })
      ) {
        logger.debug(
          { channelId: inbound.channelId, messageId: inbound.messageId },
          'Ignoring reflected local self-chat iMessage duplicate',
        );
        return;
      }
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
      if (selfChatMetadata) {
        const mirrorKey = buildSelfChatMirrorKey({
          channelId: inbound.channelId,
          text: inbound.content,
        });
        const existingMirror = mirrorKey
          ? selfChatMirrorCache?.get(mirrorKey)
          : undefined;
        const now = Date.now();
        if (
          mirrorKey &&
          existingMirror &&
          now - existingMirror.seenAt <= SELF_CHAT_MIRROR_TTL_MS &&
          existingMirror.isFromMe !== selfChatMetadata.isFromMe
        ) {
          logger.debug(
            { channelId: inbound.channelId, messageId: inbound.messageId },
            'Ignoring mirrored local self-chat iMessage duplicate',
          );
          return;
        }
        if (mirrorKey && selfChatMirrorCache) {
          selfChatMirrorCache.set(mirrorKey, {
            seenAt: now,
            isFromMe: selfChatMetadata.isFromMe,
          });
          for (const [key, entry] of selfChatMirrorCache.entries()) {
            if (now - entry.seenAt > SELF_CHAT_MIRROR_TTL_MS) {
              selfChatMirrorCache.delete(key);
            }
          }
        }
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
      inboundDedupeCache = createIMessageInboundDedupeCache();
      selfEchoCache = createIMessageSelfEchoCache();
      selfChatCache = createIMessageSelfChatCache();
      selfChatMirrorCache = new Map();
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
      inboundDedupeCache?.clear();
      inboundDedupeCache = null;
      selfEchoCache?.clear();
      selfEchoCache = null;
      selfChatCache?.clear();
      selfChatCache = null;
      selfChatMirrorCache?.clear();
      selfChatMirrorCache = null;
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
