import fs from 'node:fs';

import { getMemoryValue, setMemoryValue } from '../memory/db.js';
import type { MediaContextItem } from '../types/container.js';

const SESSION_MEDIA_HISTORY_KEY = 'media:recent-attachments';
const MAX_REMEMBERED_ATTACHMENTS = 8;

export interface RememberedMediaItem extends MediaContextItem {
  path: string;
  attachedAt: string;
}

function normalizeRemembered(value: unknown): RememberedMediaItem[] {
  if (!Array.isArray(value)) return [];
  const items: RememberedMediaItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const filePath = typeof record.path === 'string' ? record.path.trim() : '';
    if (!filePath) continue;
    items.push({
      path: filePath,
      url: typeof record.url === 'string' ? record.url : '',
      originalUrl:
        typeof record.originalUrl === 'string' ? record.originalUrl : '',
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
      sizeBytes:
        typeof record.sizeBytes === 'number' &&
        Number.isFinite(record.sizeBytes)
          ? record.sizeBytes
          : 0,
      filename: typeof record.filename === 'string' ? record.filename : '',
      attachedAt:
        typeof record.attachedAt === 'string' ? record.attachedAt : '',
    });
  }
  return items;
}

/**
 * Remember the attachments of the current turn so a later turn without an
 * attachment ("convert it into Excel") can still find the cached files.
 * Newest first, deduplicated by path, capped to a small window.
 */
export function rememberSessionMedia(
  sessionId: string,
  media: MediaContextItem[],
  now: Date = new Date(),
): void {
  const fresh = media
    .filter((item): item is MediaContextItem & { path: string } =>
      Boolean(item.path?.trim()),
    )
    .map((item) => ({ ...item, attachedAt: now.toISOString() }));
  if (fresh.length === 0) return;

  const seen = new Set(fresh.map((item) => item.path));
  const previous = normalizeRemembered(
    getMemoryValue(sessionId, SESSION_MEDIA_HISTORY_KEY),
  ).filter((item) => !seen.has(item.path));
  const next = [...fresh, ...previous].slice(0, MAX_REMEMBERED_ATTACHMENTS);
  setMemoryValue(sessionId, SESSION_MEDIA_HISTORY_KEY, next);
}

/**
 * Attachments from earlier turns of this session whose cached file still
 * exists. Entries whose file has been cleaned up are dropped from the store.
 */
export function recallSessionMedia(sessionId: string): RememberedMediaItem[] {
  const remembered = normalizeRemembered(
    getMemoryValue(sessionId, SESSION_MEDIA_HISTORY_KEY),
  );
  if (remembered.length === 0) return [];
  const available = remembered.filter((item) => {
    try {
      return fs.existsSync(item.path);
    } catch {
      return false;
    }
  });
  if (available.length !== remembered.length) {
    setMemoryValue(sessionId, SESSION_MEDIA_HISTORY_KEY, available);
  }
  return available;
}
