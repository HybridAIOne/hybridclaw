import type { WAMessage } from '@whiskeysockets/baileys';
import type { MediaContextItem } from '../../types/container.js';

const CONTROL_COMMAND_RE = /^\/(stop|pause|clear|reset|cancel|resume)\b/i;

export const DEFAULT_DEBOUNCE_MS = 2_500;

export interface WhatsAppInboundBatch {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  ackReaction: string;
  media: MediaContextItem[];
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
  isSelfChat: boolean;
  rawMessage: WAMessage;
  batchedMessages: WAMessage[];
}

interface PendingBatch {
  items: WhatsAppInboundBatch[];
  timer: ReturnType<typeof setTimeout> | null;
}

function mergeInboundBatches(
  items: WhatsAppInboundBatch[],
): WhatsAppInboundBatch | null {
  const last = items.at(-1);
  if (!last) return null;
  const mergedText = items
    .map((entry) => entry.content.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return {
    ...last,
    username:
      [...items]
        .reverse()
        .map((entry) => entry.username.trim())
        .find(Boolean) || last.username,
    content: mergedText,
    media: items.flatMap((entry) => entry.media),
    batchedMessages: items.flatMap((entry) => entry.batchedMessages),
  };
}

export function shouldDebounceWhatsAppInbound(params: {
  content: string;
  hasMedia: boolean;
}): boolean {
  const normalized = params.content.trim();
  if (!normalized) return false;
  if (params.hasMedia) return false;
  if (CONTROL_COMMAND_RE.test(normalized)) return false;
  return true;
}

export function resolveWhatsAppDebounceKey(
  item: Pick<WhatsAppInboundBatch, 'channelId' | 'userId'>,
): string {
  return `${item.channelId}::${item.userId}`;
}

export function createWhatsAppDebouncer(
  onFlush: (item: WhatsAppInboundBatch) => Promise<void>,
): {
  enqueue: (item: WhatsAppInboundBatch, debounceMs?: number) => void;
  clearAll: () => void;
  flushAll: () => Promise<void>;
} {
  const pending = new Map<string, PendingBatch>();

  const flushKey = async (key: string): Promise<void> => {
    const batch = pending.get(key);
    if (!batch) return;
    pending.delete(key);
    if (batch.timer) clearTimeout(batch.timer);
    const merged = mergeInboundBatches(batch.items);
    if (!merged) return;
    await onFlush(merged);
  };

  return {
    enqueue(item, debounceMs = DEFAULT_DEBOUNCE_MS) {
      const key = resolveWhatsAppDebounceKey(item);
      const existing = pending.get(key);
      if (existing?.timer) clearTimeout(existing.timer);

      const items = existing ? [...existing.items, item] : [item];
      const timer = setTimeout(
        () => {
          void flushKey(key);
        },
        Math.max(0, Math.floor(debounceMs)),
      );
      pending.set(key, { items, timer });
    },
    clearAll() {
      for (const batch of pending.values()) {
        if (batch.timer) clearTimeout(batch.timer);
      }
      pending.clear();
    },
    async flushAll() {
      for (const key of [...pending.keys()]) {
        await flushKey(key);
      }
    },
  };
}
