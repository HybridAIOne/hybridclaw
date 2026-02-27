import { HYBRIDAI_API_KEY, HYBRIDAI_BASE_URL } from './config.js';
import type { HybridAIBot } from './types.js';

interface BotCacheEntry {
  bots: HybridAIBot[];
  fetchedAtMs: number;
}

let botCache: BotCacheEntry | null = null;

function normalizeBots(payload: unknown): HybridAIBot[] {
  const data = payload as
    | { data?: Record<string, unknown>[]; bots?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
    | Record<string, unknown>[];
  const raw = Array.isArray(data) ? data : (data.data || data.bots || data.items || []);

  return raw.map((item) => ({
    id: String(item.id ?? item._id ?? item.chatbot_id ?? item.bot_id ?? ''),
    name: String(item.bot_name ?? item.name ?? 'Unnamed'),
    description: item.description != null ? String(item.description) : undefined,
  }));
}

export async function fetchHybridAIBots(options?: { cacheTtlMs?: number }): Promise<HybridAIBot[]> {
  const cacheTtlMs = Math.max(0, options?.cacheTtlMs ?? 0);
  const now = Date.now();

  if (cacheTtlMs > 0 && botCache && now - botCache.fetchedAtMs < cacheTtlMs) {
    return botCache.bots;
  }

  const url = `${HYBRIDAI_BASE_URL}/api/v1/bot-management/bots`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${HYBRIDAI_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch bots: ${res.status} ${res.statusText}`);
  }

  const bots = normalizeBots(await res.json());
  if (cacheTtlMs > 0) {
    botCache = { bots, fetchedAtMs: now };
  } else {
    botCache = null;
  }
  return bots;
}
