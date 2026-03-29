export interface IMessageOutboundMessageRef {
  channelId?: string | null;
  messageId?: string | null;
  text?: string | null;
}

export interface IMessageSelfEchoLookup {
  channelId?: string | null;
  messageId?: string | null;
  text?: string | null;
  skipIdShortCircuit?: boolean;
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

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\r\n?/g, '\n')
    .slice(0, 256);
}

function buildScope(ref: IMessageOutboundMessageRef): string | null {
  const channelId = String(ref.channelId || '').trim();
  if (!channelId) return null;
  return channelId;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === 'ok' || normalized === 'unknown') {
    return null;
  }
  return normalized;
}

function buildMessageIdKey(
  scope: string,
  messageId: string | null | undefined,
): string | null {
  const normalized = normalizeMessageId(messageId);
  return normalized ? `${scope}:id:${normalized}` : null;
}

function buildTextKey(
  scope: string,
  text: string | null | undefined,
): string | null {
  const normalized = normalizeText(text);
  return normalized ? `${scope}:text:${normalized}` : null;
}

class DefaultIMessageSelfEchoCache implements IMessageSelfEchoCache {
  private textCache = new Map<string, number>();
  private textBackedByIdCache = new Map<string, number>();
  private messageIdCache = new Map<string, number>();
  private lastCleanupAt = 0;

  remember(refs: IMessageOutboundMessageRef | IMessageOutboundMessageRef[]) {
    const entries = Array.isArray(refs) ? refs : [refs];
    const now = Date.now();
    for (const ref of entries) {
      const scope = buildScope(ref);
      if (!scope) continue;

      const textKey = buildTextKey(scope, ref.text);
      if (textKey) {
        this.textCache.set(textKey, now);
      }

      const messageIdKey = buildMessageIdKey(scope, ref.messageId);
      if (messageIdKey) {
        this.messageIdCache.set(messageIdKey, now);
        if (textKey) {
          this.textBackedByIdCache.set(textKey, now);
        }
      }
    }
    this.maybeCleanup(now);
  }

  has(ref: IMessageSelfEchoLookup): boolean {
    const now = Date.now();
    this.maybeCleanup(now);

    const scope = buildScope(ref);
    if (!scope) return false;

    const messageIdKey = buildMessageIdKey(scope, ref.messageId);
    const textKey = buildTextKey(scope, ref.text);

    if (messageIdKey) {
      const seenAt = this.messageIdCache.get(messageIdKey);
      if (typeof seenAt === 'number' && now - seenAt <= SELF_ECHO_ID_TTL_MS) {
        return true;
      }

      const textSeenAt =
        textKey && this.textCache.has(textKey)
          ? this.textCache.get(textKey)
          : undefined;
      const textBackedByIdSeenAt =
        textKey && this.textBackedByIdCache.has(textKey)
          ? this.textBackedByIdCache.get(textKey)
          : undefined;
      const hasTextOnlyMatch =
        typeof textSeenAt === 'number' &&
        now - textSeenAt <= SELF_ECHO_TEXT_TTL_MS &&
        (!textBackedByIdSeenAt || textSeenAt > textBackedByIdSeenAt);

      if (!ref.skipIdShortCircuit && !hasTextOnlyMatch) {
        return false;
      }
    }

    if (textKey) {
      const seenAt = this.textCache.get(textKey);
      if (typeof seenAt === 'number' && now - seenAt <= SELF_ECHO_TEXT_TTL_MS) {
        return true;
      }
    }

    return false;
  }

  clear(): void {
    this.textCache.clear();
    this.textBackedByIdCache.clear();
    this.messageIdCache.clear();
    this.lastCleanupAt = 0;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    for (const [key, seenAt] of this.textCache.entries()) {
      if (now - seenAt > SELF_ECHO_TEXT_TTL_MS) {
        this.textCache.delete(key);
      }
    }
    for (const [key, seenAt] of this.textBackedByIdCache.entries()) {
      if (now - seenAt > SELF_ECHO_TEXT_TTL_MS) {
        this.textBackedByIdCache.delete(key);
      }
    }
    for (const [key, seenAt] of this.messageIdCache.entries()) {
      if (now - seenAt > SELF_ECHO_ID_TTL_MS) {
        this.messageIdCache.delete(key);
      }
    }
    while (
      this.textCache.size +
        this.textBackedByIdCache.size +
        this.messageIdCache.size >
      MAX_SELF_ECHO_ENTRIES
    ) {
      const oldestTextKey = this.textCache.keys().next().value;
      if (typeof oldestTextKey === 'string') {
        this.textCache.delete(oldestTextKey);
        continue;
      }
      const oldestIdKey = this.messageIdCache.keys().next().value;
      if (typeof oldestIdKey === 'string') {
        this.messageIdCache.delete(oldestIdKey);
        continue;
      }
      const oldestBackedTextKey = this.textBackedByIdCache.keys().next().value;
      if (typeof oldestBackedTextKey === 'string') {
        this.textBackedByIdCache.delete(oldestBackedTextKey);
        continue;
      }
      const oldestKey =
        this.textCache.keys().next().value ??
        this.messageIdCache.keys().next().value ??
        this.textBackedByIdCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.textCache.delete(oldestKey);
      this.messageIdCache.delete(oldestKey);
      this.textBackedByIdCache.delete(oldestKey);
    }
  }
}

export function createIMessageSelfEchoCache(): IMessageSelfEchoCache {
  return new DefaultIMessageSelfEchoCache();
}
