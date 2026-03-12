export interface WhatsAppOutboundMessageRef {
  chatJid: string;
  messageId: string | null;
}

export interface WhatsAppSelfEchoCache {
  remember: (
    refs: WhatsAppOutboundMessageRef | WhatsAppOutboundMessageRef[],
  ) => void;
  has: (ref: { chatJid?: string | null; messageId?: string | null }) => boolean;
  clear: () => void;
}

const SELF_ECHO_TTL_MS = 60_000;
const MAX_SELF_ECHO_ENTRIES = 1_024;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

function buildCacheKey(ref: {
  chatJid?: string | null;
  messageId?: string | null;
}): string | null {
  const chatJid = String(ref.chatJid || '').trim();
  const messageId = String(ref.messageId || '').trim();
  if (!chatJid || !messageId) return null;
  return `${chatJid}:${messageId}`;
}

class DefaultWhatsAppSelfEchoCache implements WhatsAppSelfEchoCache {
  private cache = new Map<string, number>();
  private lastCleanupAt = 0;

  remember(
    refs: WhatsAppOutboundMessageRef | WhatsAppOutboundMessageRef[],
  ): void {
    const entries = Array.isArray(refs) ? refs : [refs];
    const now = Date.now();
    for (const ref of entries) {
      const key = buildCacheKey(ref);
      if (!key) continue;
      this.cache.set(key, now);
    }
    this.maybeCleanup(now);
  }

  has(ref: { chatJid?: string | null; messageId?: string | null }): boolean {
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

export function createWhatsAppSelfEchoCache(): WhatsAppSelfEchoCache {
  return new DefaultWhatsAppSelfEchoCache();
}
