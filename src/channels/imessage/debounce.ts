import type { IMessageInbound } from './types.js';

const CONTROL_COMMAND_RE = /^\/(stop|pause|clear|reset|cancel|resume)\b/i;

export const DEFAULT_IMESSAGE_DEBOUNCE_MS = 2_500;

export interface IMessageInboundBatch extends IMessageInbound {
  rawEvents: unknown[];
}

interface PendingBatch {
  items: IMessageInboundBatch[];
  timer: ReturnType<typeof setTimeout> | null;
}

function mergeInboundBatches(
  items: IMessageInboundBatch[],
): IMessageInboundBatch | null {
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
    rawEvents: items.flatMap((entry) => entry.rawEvents),
  };
}

export function shouldDebounceIMessageInbound(params: {
  content: string;
  hasMedia: boolean;
}): boolean {
  const normalized = params.content.trim();
  if (!normalized) return false;
  if (params.hasMedia) return false;
  if (CONTROL_COMMAND_RE.test(normalized)) return false;
  return true;
}

export function resolveIMessageDebounceKey(
  item: Pick<IMessageInboundBatch, 'channelId' | 'userId'>,
): string {
  return `${item.channelId}::${item.userId}`;
}

export function createIMessageDebouncer(
  onFlush: (item: IMessageInboundBatch) => Promise<void>,
): {
  enqueue: (item: IMessageInboundBatch, debounceMs?: number) => void;
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
    enqueue(item, debounceMs = DEFAULT_IMESSAGE_DEBOUNCE_MS) {
      const key = resolveIMessageDebounceKey(item);
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
    async flushAll() {
      for (const key of [...pending.keys()]) {
        await flushKey(key);
      }
    },
  };
}
