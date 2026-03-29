import type { IMessageInboundBatch } from './debounce.js';
import { createIMessageInboundDedupeCache } from './inbound-dedupe-cache.js';
import {
  createIMessageSelfEchoCache,
  type IMessageOutboundMessageRef,
} from './self-echo-cache.js';
import { normalizeIMessageComparableText } from './text-normalization.js';
import { createTtlCache } from './ttl-cache.js';

export interface IMessageLocalSelfChatMetadata {
  isFromMe: boolean;
}

export interface IMessageSelfChatGuardDecision {
  drop: boolean;
  reason?: string;
}

export interface IMessageSelfChatGuard {
  shouldDropInbound(params: {
    inbound: Pick<
      IMessageInboundBatch,
      'channelId' | 'content' | 'messageId' | 'sessionId'
    >;
    selfChatMetadata: IMessageLocalSelfChatMetadata | null;
  }): IMessageSelfChatGuardDecision;
  rememberOutbound(
    refs: IMessageOutboundMessageRef | IMessageOutboundMessageRef[],
  ): void;
  clear(): void;
}

interface SelfChatObservation {
  seenAt: number;
  isFromMe: boolean;
}

const SELF_CHAT_REFLECTION_TTL_MS = 15_000;
const MAX_SELF_CHAT_KEYS = 512;
const MAX_SELF_CHAT_OBSERVATIONS_PER_KEY = 4;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildObservationKey(params: {
  channelId?: string | null;
  text?: string | null;
}): string | null {
  const channelId = String(params.channelId || '').trim();
  const text = normalizeIMessageComparableText(params.text);
  if (!channelId || !text) return null;
  return `${channelId}:${text}`;
}

class DefaultIMessageSelfChatGuard implements IMessageSelfChatGuard {
  private inboundDedupeCache = createIMessageInboundDedupeCache();
  private selfEchoCache = createIMessageSelfEchoCache();
  private selfChatObservations = createTtlCache<string, SelfChatObservation[]>({
    ttlMs: SELF_CHAT_REFLECTION_TTL_MS,
    maxEntries: MAX_SELF_CHAT_KEYS,
    cleanupMinIntervalMs: CLEANUP_MIN_INTERVAL_MS,
  });

  constructor(
    private readonly resolveReplyPrefix: (sessionId: string) => string,
  ) {}

  shouldDropInbound(params: {
    inbound: Pick<
      IMessageInboundBatch,
      'channelId' | 'content' | 'messageId' | 'sessionId'
    >;
    selfChatMetadata: IMessageLocalSelfChatMetadata | null;
  }): IMessageSelfChatGuardDecision {
    const { inbound, selfChatMetadata } = params;

    if (
      selfChatMetadata &&
      this.isReflectedSelfChatReply(inbound.content, inbound.sessionId)
    ) {
      return {
        drop: true,
        reason: 'Ignoring reflected local self-chat iMessage marker message',
      };
    }

    if (
      this.inboundDedupeCache.has({
        channelId: inbound.channelId,
        messageId: inbound.messageId,
      })
    ) {
      return {
        drop: true,
        reason: 'Ignoring duplicate iMessage inbound message',
      };
    }
    this.inboundDedupeCache.remember({
      channelId: inbound.channelId,
      messageId: inbound.messageId,
    });

    if (
      selfChatMetadata?.isFromMe &&
      this.selfEchoCache.has({
        channelId: inbound.channelId,
        messageId: inbound.messageId,
        text: inbound.content,
        textMatchPolicy: 'any',
      })
    ) {
      return {
        drop: true,
        reason: 'Ignoring local self-chat iMessage echo',
      };
    }

    if (
      this.selfEchoCache.has({
        channelId: inbound.channelId,
        messageId: inbound.messageId,
        text: inbound.content,
      })
    ) {
      return {
        drop: true,
        reason: 'Ignoring reflected iMessage outbound message',
      };
    }

    if (!selfChatMetadata) {
      return { drop: false };
    }

    const key = buildObservationKey({
      channelId: inbound.channelId,
      text: inbound.content,
    });
    if (!key) {
      return { drop: false };
    }

    const now = Date.now();
    const existing = this.selfChatObservations.get(key) || [];
    const matchingOpposite = existing.find(
      (entry) =>
        entry.isFromMe !== selfChatMetadata.isFromMe &&
        now - entry.seenAt <= SELF_CHAT_REFLECTION_TTL_MS,
    );
    if (matchingOpposite) {
      return {
        drop: true,
        reason: 'Ignoring mirrored local self-chat iMessage duplicate',
      };
    }

    this.selfChatObservations.set(
      key,
      [
        ...existing,
        {
          seenAt: now,
          isFromMe: selfChatMetadata.isFromMe,
        },
      ].slice(-MAX_SELF_CHAT_OBSERVATIONS_PER_KEY),
    );
    return { drop: false };
  }

  rememberOutbound(
    refs: IMessageOutboundMessageRef | IMessageOutboundMessageRef[],
  ): void {
    this.selfEchoCache.remember(refs);
  }

  clear(): void {
    this.inboundDedupeCache.clear();
    this.selfEchoCache.clear();
    this.selfChatObservations.clear();
  }

  private isReflectedSelfChatReply(
    content: string,
    sessionId: string,
  ): boolean {
    const prefix = this.resolveReplyPrefix(sessionId);
    const bareLabel = prefix.slice(1, -1).trim();
    if (!bareLabel) return false;
    const reflectionPrefixRe = new RegExp(
      `^(?:\\S{1,3}\\s*)?\\[?${escapeRegExp(bareLabel)}\\](?:\\s|$)`,
      'i',
    );
    return reflectionPrefixRe.test(content.trimStart());
  }
}

export function createIMessageSelfChatGuard(params: {
  resolveReplyPrefix: (sessionId: string) => string;
}): IMessageSelfChatGuard {
  return new DefaultIMessageSelfChatGuard(params.resolveReplyPrefix);
}
