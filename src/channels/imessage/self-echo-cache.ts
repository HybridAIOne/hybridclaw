import { normalizeIMessageComparableText } from './text-normalization.js';
import { createTtlCache } from './ttl-cache.js';

export interface IMessageOutboundMessageRef {
  channelId?: string | null;
  messageId?: string | null;
  text?: string | null;
}

export interface IMessageSelfEchoLookup {
  channelId?: string | null;
  messageId?: string | null;
  text?: string | null;
  textMatchPolicy?: 'untracked-only' | 'any';
}

export interface IMessageSelfEchoCache {
  remember(
    refs: IMessageOutboundMessageRef | IMessageOutboundMessageRef[],
  ): void;
  has(ref: IMessageSelfEchoLookup): boolean;
  clear(): void;
}

const SELF_ECHO_TEXT_TTL_MS = 10_000;
const SELF_ECHO_ID_TTL_MS = 60_000;
const MAX_SELF_ECHO_ENTRIES = 1_024;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

interface SelfEchoObservation {
  seenAt: number;
  scope: string;
  messageId: string | null;
  text: string | null;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === 'ok' || normalized === 'unknown') {
    return null;
  }
  return normalized;
}

class DefaultIMessageSelfEchoCache implements IMessageSelfEchoCache {
  private observations = createTtlCache<number, SelfEchoObservation>({
    ttlMs: (entry) =>
      entry.messageId ? SELF_ECHO_ID_TTL_MS : SELF_ECHO_TEXT_TTL_MS,
    maxEntries: MAX_SELF_ECHO_ENTRIES,
    cleanupMinIntervalMs: CLEANUP_MIN_INTERVAL_MS,
  });
  private nextObservationId = 1;

  remember(refs: IMessageOutboundMessageRef | IMessageOutboundMessageRef[]) {
    const entries = Array.isArray(refs) ? refs : [refs];
    for (const ref of entries) {
      const scope = String(ref.channelId || '').trim();
      if (!scope) continue;
      const messageId = normalizeMessageId(ref.messageId);
      const text = normalizeIMessageComparableText(ref.text);
      if (!messageId && !text) {
        continue;
      }
      this.observations.set(this.nextObservationId++, {
        seenAt: Date.now(),
        scope,
        messageId,
        text: text || null,
      });
    }
  }

  has(ref: IMessageSelfEchoLookup): boolean {
    const now = Date.now();
    const scope = String(ref.channelId || '').trim();
    if (!scope) return false;

    const messageId = normalizeMessageId(ref.messageId);
    const text = normalizeIMessageComparableText(ref.text) || null;
    const textMatchPolicy = ref.textMatchPolicy || 'untracked-only';
    const observations = this.observations.values();

    if (messageId) {
      const hasMessageIdMatch = observations.some(
        (entry) =>
          entry.scope === scope &&
          entry.messageId === messageId &&
          now - entry.seenAt <= SELF_ECHO_ID_TTL_MS,
      );
      if (hasMessageIdMatch) {
        return true;
      }
    }

    if (!text) {
      return false;
    }

    const textMatches = observations.filter(
      (entry) =>
        entry.scope === scope &&
        entry.text === text &&
        now - entry.seenAt <= SELF_ECHO_TEXT_TTL_MS,
    );
    if (textMatches.length === 0) {
      return false;
    }
    if (!messageId || textMatchPolicy === 'any') {
      return true;
    }
    return textMatches.some((entry) => !entry.messageId);
  }

  clear(): void {
    this.observations.clear();
    this.nextObservationId = 1;
  }
}

export function createIMessageSelfEchoCache(): IMessageSelfEchoCache {
  return new DefaultIMessageSelfEchoCache();
}
