import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL } from '../config/config.js';
import { logger } from '../logger.js';
import type { HybridAIBot } from '../types.js';

interface BotCacheEntry {
  bots: HybridAIBot[];
  fetchedAtMs: number;
}

let botCache: BotCacheEntry | null = null;

function normalizeBots(payload: unknown): HybridAIBot[] {
  const data = payload as
    | {
        data?: Record<string, unknown>[];
        bots?: Record<string, unknown>[];
        items?: Record<string, unknown>[];
      }
    | Record<string, unknown>[];
  const raw = Array.isArray(data)
    ? data
    : data.data || data.bots || data.items || [];

  return raw.map((item) => ({
    id: String(item.id ?? item._id ?? item.chatbot_id ?? item.bot_id ?? ''),
    name: String(item.bot_name ?? item.name ?? 'Unnamed'),
    description:
      item.description != null ? String(item.description) : undefined,
  }));
}

export async function fetchHybridAIBots(options?: {
  cacheTtlMs?: number;
}): Promise<HybridAIBot[]> {
  const cacheTtlMs = Math.max(0, options?.cacheTtlMs ?? 0);
  const now = Date.now();

  if (cacheTtlMs > 0 && botCache && now - botCache.fetchedAtMs < cacheTtlMs) {
    return botCache.bots;
  }

  const url = `${HYBRIDAI_BASE_URL}/api/v1/bot-management/bots`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getHybridAIApiKey()}` },
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

/**
 * Notify HybridAI that a bot is being used (or no longer used) by HybridClaw.
 * Fires and logs errors but never throws so callers can treat it as best-effort.
 */
export async function updateBotUsedFor(
  botId: string,
  agentId: string | null,
): Promise<void> {
  const apiKey = getHybridAIApiKey();
  if (!apiKey) return;

  const usedfor = agentId ? `HybridClaw:${agentId}` : null;
  const url = `${HYBRIDAI_BASE_URL}/api/bots/settings/${encodeURIComponent(botId)}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ usedfor }),
    });
    if (!res.ok) {
      logger.warn(
        { botId, usedfor, status: res.status },
        'Failed to update bot usedfor flag',
      );
    }
  } catch (err) {
    logger.warn({ botId, usedfor, err }, 'Error updating bot usedfor flag');
  }
}
