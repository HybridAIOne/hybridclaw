interface IMessageInboundRef {
  channelId?: string | null;
  messageId?: string | null;
}

interface IMessageInboundDedupeCache {
  remember(ref: IMessageInboundRef): void;
  has(ref: IMessageInboundRef): boolean;
  clear(): void;
}

const INBOUND_TTL_MS = 10 * 60 * 1000;
const MAX_INBOUND_ENTRIES = 2_048;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

function buildCacheKey(ref: IMessageInboundRef): string | null {
  const channelId = String(ref.channelId || '').trim();
  const messageId = String(ref.messageId || '').trim();
  if (!channelId || !messageId) return null;
  return `${channelId}:id:${messageId}`;
}

class DefaultIMessageInboundDedupeCache implements IMessageInboundDedupeCache {
  private cache = new Map<string, number>();
  private lastCleanupAt = 0;

  remember(ref: IMessageInboundRef): void {
    const key = buildCacheKey(ref);
    if (!key) return;
    const now = Date.now();
    this.cache.set(key, now);
    this.maybeCleanup(now);
  }

  has(ref: IMessageInboundRef): boolean {
    this.maybeCleanup(Date.now());
    const key = buildCacheKey(ref);
    if (!key) return false;
    const seenAt = this.cache.get(key);
    return typeof seenAt === 'number' && Date.now() - seenAt <= INBOUND_TTL_MS;
  }

  clear(): void {
    this.cache.clear();
    this.lastCleanupAt = 0;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    for (const [key, seenAt] of this.cache.entries()) {
      if (now - seenAt > INBOUND_TTL_MS) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size > MAX_INBOUND_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.cache.delete(oldestKey);
    }
  }
}

export function createIMessageInboundDedupeCache(): IMessageInboundDedupeCache {
  return new DefaultIMessageInboundDedupeCache();
}
