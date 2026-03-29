export interface IMessageOutboundMessageRef {
  channelId?: string | null;
  messageId?: string | null;
  text?: string | null;
}

export interface IMessageSelfEchoCache {
  remember(
    refs: IMessageOutboundMessageRef | IMessageOutboundMessageRef[],
  ): void;
  has(ref: IMessageOutboundMessageRef): boolean;
  clear(): void;
}

const SELF_ECHO_TTL_MS = 60_000;
const MAX_SELF_ECHO_ENTRIES = 1_024;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, 256);
}

function buildCacheKey(ref: IMessageOutboundMessageRef): string | null {
  const channelId = String(ref.channelId || '').trim();
  if (!channelId) return null;

  const messageId = String(ref.messageId || '').trim();
  if (messageId) {
    return `${channelId}:id:${messageId}`;
  }

  const text = normalizeText(ref.text);
  if (!text) return null;
  return `${channelId}:text:${text}`;
}

class DefaultIMessageSelfEchoCache implements IMessageSelfEchoCache {
  private cache = new Map<string, number>();
  private lastCleanupAt = 0;

  remember(refs: IMessageOutboundMessageRef | IMessageOutboundMessageRef[]) {
    const entries = Array.isArray(refs) ? refs : [refs];
    const now = Date.now();
    for (const ref of entries) {
      const key = buildCacheKey(ref);
      if (!key) continue;
      this.cache.set(key, now);
    }
    this.maybeCleanup(now);
  }

  has(ref: IMessageOutboundMessageRef): boolean {
    this.maybeCleanup(Date.now());
    const key = buildCacheKey(ref);
    if (!key) return false;
    const seenAt = this.cache.get(key);
    return (
      typeof seenAt === 'number' && Date.now() - seenAt <= SELF_ECHO_TTL_MS
    );
  }

  clear(): void {
    this.cache.clear();
    this.lastCleanupAt = 0;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    for (const [key, seenAt] of this.cache.entries()) {
      if (now - seenAt > SELF_ECHO_TTL_MS) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size > MAX_SELF_ECHO_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.cache.delete(oldestKey);
    }
  }
}

export function createIMessageSelfEchoCache(): IMessageSelfEchoCache {
  return new DefaultIMessageSelfEchoCache();
}
