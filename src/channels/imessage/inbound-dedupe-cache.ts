import { createTtlCache } from './ttl-cache.js';

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
  private cache = createTtlCache<string, true>({
    ttlMs: INBOUND_TTL_MS,
    maxEntries: MAX_INBOUND_ENTRIES,
    cleanupMinIntervalMs: CLEANUP_MIN_INTERVAL_MS,
  });

  remember(ref: IMessageInboundRef): void {
    const key = buildCacheKey(ref);
    if (!key) return;
    this.cache.set(key, true);
  }

  has(ref: IMessageInboundRef): boolean {
    const key = buildCacheKey(ref);
    if (!key) return false;
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

export function createIMessageInboundDedupeCache(): IMessageInboundDedupeCache {
  return new DefaultIMessageInboundDedupeCache();
}
