export interface TtlCache<K, V> {
  set(key: K, value: V): void;
  get(key: K): V | undefined;
  has(key: K): boolean;
  values(): V[];
  clear(): void;
}

interface TtlCacheEntry<V> {
  value: V;
  seenAt: number;
}

export function createTtlCache<K, V>(params: {
  ttlMs: number | ((value: V) => number);
  maxEntries: number;
  cleanupMinIntervalMs: number;
}): TtlCache<K, V> {
  const entries = new Map<K, TtlCacheEntry<V>>();
  let lastCleanupAt = 0;

  const resolveTtlMs = (value: V): number =>
    typeof params.ttlMs === 'function' ? params.ttlMs(value) : params.ttlMs;

  const isExpired = (entry: TtlCacheEntry<V>, now: number): boolean =>
    now - entry.seenAt > resolveTtlMs(entry.value);

  const maybeCleanup = (now: number): void => {
    if (now - lastCleanupAt < params.cleanupMinIntervalMs) return;
    lastCleanupAt = now;

    for (const [key, entry] of entries.entries()) {
      if (isExpired(entry, now)) {
        entries.delete(key);
      }
    }

    while (entries.size > params.maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  };

  return {
    set(key, value) {
      const now = Date.now();
      entries.set(key, { value, seenAt: now });
      maybeCleanup(now);
    },
    get(key) {
      const now = Date.now();
      maybeCleanup(now);
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (isExpired(entry, now)) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    has(key) {
      return this.get(key) !== undefined;
    },
    values() {
      const now = Date.now();
      maybeCleanup(now);
      const values: V[] = [];
      for (const [key, entry] of entries.entries()) {
        if (isExpired(entry, now)) {
          entries.delete(key);
          continue;
        }
        values.push(entry.value);
      }
      return values;
    },
    clear() {
      entries.clear();
      lastCleanupAt = 0;
    },
  };
}
