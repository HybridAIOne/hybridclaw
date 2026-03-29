export interface IMessageSelfChatRef {
  channelId?: string | null;
  createdAt?: number | string | null;
  text?: string | null;
}

export interface IMessageSelfChatCache {
  remember(ref: IMessageSelfChatRef): void;
  has(ref: IMessageSelfChatRef): boolean;
  clear(): void;
}

const SELF_CHAT_TTL_MS = 10_000;
const MAX_SELF_CHAT_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, 256);
}

function normalizeCreatedAt(value: number | string | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return String(value || '').trim();
}

function buildKey(ref: IMessageSelfChatRef): string | null {
  const channelId = String(ref.channelId || '').trim();
  const createdAt = normalizeCreatedAt(ref.createdAt);
  const text = normalizeText(ref.text);
  if (!channelId || !createdAt || !text) {
    return null;
  }
  return `${channelId}:${createdAt}:${text}`;
}

class DefaultIMessageSelfChatCache implements IMessageSelfChatCache {
  private cache = new Map<string, number>();
  private lastCleanupAt = 0;

  remember(ref: IMessageSelfChatRef): void {
    const key = buildKey(ref);
    if (!key) return;
    const now = Date.now();
    this.cache.set(key, now);
    this.maybeCleanup(now);
  }

  has(ref: IMessageSelfChatRef): boolean {
    const key = buildKey(ref);
    if (!key) return false;
    const now = Date.now();
    this.maybeCleanup(now);
    const seenAt = this.cache.get(key);
    return typeof seenAt === 'number' && now - seenAt <= SELF_CHAT_TTL_MS;
  }

  clear(): void {
    this.cache.clear();
    this.lastCleanupAt = 0;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
    this.lastCleanupAt = now;

    for (const [key, seenAt] of this.cache.entries()) {
      if (now - seenAt > SELF_CHAT_TTL_MS) {
        this.cache.delete(key);
      }
    }

    while (this.cache.size > MAX_SELF_CHAT_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.cache.delete(oldestKey);
    }
  }
}

export function createIMessageSelfChatCache(): IMessageSelfChatCache {
  return new DefaultIMessageSelfChatCache();
}
