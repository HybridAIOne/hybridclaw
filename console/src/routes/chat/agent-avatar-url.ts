import { useEffect, useState } from 'react';
import { fetchAgentAvatarBlob } from '../../api/chat';

type CacheEntry = {
  objectUrl: string | null;
  loading: boolean;
  promise: Promise<string | null> | null;
  listeners: Set<() => void>;
};

const avatarUrlCache = new Map<string, CacheEntry>();

export function clearAgentAvatarUrlCacheForTest(): void {
  for (const entry of avatarUrlCache.values()) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  }
  avatarUrlCache.clear();
}

function cacheKey(token: string, imageUrl: string): string {
  return `${token}\u0000${imageUrl}`;
}

function getEntry(token: string, imageUrl: string): CacheEntry {
  const key = cacheKey(token, imageUrl);
  let entry = avatarUrlCache.get(key);
  if (!entry) {
    entry = {
      objectUrl: null,
      loading: false,
      promise: null,
      listeners: new Set(),
    };
    avatarUrlCache.set(key, entry);
  }
  return entry;
}

function notify(entry: CacheEntry): void {
  for (const listener of entry.listeners) listener();
}

export function preloadAgentAvatarUrl(
  token: string,
  imageUrl?: string | null,
): Promise<string | null> | null {
  const normalizedUrl = imageUrl?.trim();
  const normalizedToken = token.trim();
  if (!normalizedUrl) return null;

  const entry = getEntry(normalizedToken, normalizedUrl);
  if (entry.objectUrl) return Promise.resolve(entry.objectUrl);
  if (entry.promise) return entry.promise;

  entry.loading = true;
  entry.promise = fetchAgentAvatarBlob(normalizedToken, normalizedUrl)
    .then((blob) => {
      const next = URL.createObjectURL(blob);
      entry.objectUrl = next;
      entry.loading = false;
      entry.promise = null;
      notify(entry);
      return next;
    })
    .catch(() => {
      entry.objectUrl = null;
      entry.loading = false;
      entry.promise = null;
      notify(entry);
      return null;
    });
  notify(entry);
  return entry.promise;
}

export function useAgentAvatarUrl(params: {
  token: string;
  imageUrl?: string | null;
}): { objectUrl: string | null; loading: boolean } {
  const normalizedToken = params.token.trim();
  const normalizedUrl = params.imageUrl?.trim() ?? '';
  const [snapshot, setSnapshot] = useState(() => {
    if (!normalizedUrl) {
      return { objectUrl: null, loading: false };
    }
    const entry = getEntry(normalizedToken, normalizedUrl);
    return { objectUrl: entry.objectUrl, loading: entry.loading };
  });

  useEffect(() => {
    if (!normalizedUrl) {
      setSnapshot({ objectUrl: null, loading: false });
      return;
    }

    const entry = getEntry(normalizedToken, normalizedUrl);
    const update = () => {
      setSnapshot({ objectUrl: entry.objectUrl, loading: entry.loading });
    };
    entry.listeners.add(update);
    update();
    void preloadAgentAvatarUrl(normalizedToken, normalizedUrl);

    return () => {
      entry.listeners.delete(update);
    };
  }, [normalizedToken, normalizedUrl]);

  return snapshot;
}
