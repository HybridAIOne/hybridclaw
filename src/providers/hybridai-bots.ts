import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL } from '../config/config.js';
import { logger } from '../logger.js';
import type { HybridAIBot } from '../types/api.js';

interface BotCacheEntry {
  bots: HybridAIBot[];
  fetchedAtMs: number;
}

const HYBRIDAI_BOT_FETCH_TIMEOUT_MS = 5_000;

let botCache: BotCacheEntry | null = null;

export class HybridAIBotFetchError extends Error {
  status: number;
  code?: number | string;
  type?: string;

  constructor(params: {
    status: number;
    message: string;
    code?: number | string;
    type?: string;
  }) {
    super(params.message);
    this.name = 'HybridAIBotFetchError';
    this.status = params.status;
    this.code = params.code;
    this.type = params.type;
  }
}

function readNestedErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    if (typeof error.cause === 'string' && error.cause.trim()) {
      return error.cause.trim();
    }
    if (
      error.cause &&
      typeof error.cause === 'object' &&
      'message' in error.cause &&
      typeof error.cause.message === 'string' &&
      error.cause.message.trim()
    ) {
      return error.cause.message.trim();
    }
  }
  return null;
}

function formatTransportFailure(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : String(error);
  const nested = readNestedErrorMessage(error);
  if (!nested || nested === message) {
    return message;
  }
  return `${message} (${nested})`;
}

function parseHybridAIErrorPayload(payload: unknown): {
  message: string | null;
  code?: number | string;
  type?: string;
} {
  if (typeof payload === 'string' && payload.trim()) {
    return { message: payload.trim() };
  }
  if (!payload || typeof payload !== 'object') {
    return { message: null };
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) {
    return {
      message: record.message.trim(),
      code:
        typeof record.code === 'number' || typeof record.code === 'string'
          ? record.code
          : undefined,
      type: typeof record.type === 'string' ? record.type : undefined,
    };
  }
  if (typeof record.error === 'string' && record.error.trim()) {
    return {
      message: record.error.trim(),
      code:
        typeof record.code === 'number' || typeof record.code === 'string'
          ? record.code
          : undefined,
      type: typeof record.type === 'string' ? record.type : undefined,
    };
  }

  const nested = record.error;
  if (!nested || typeof nested !== 'object') {
    return { message: null };
  }

  const nestedRecord = nested as Record<string, unknown>;
  return {
    message:
      typeof nestedRecord.message === 'string' && nestedRecord.message.trim()
        ? nestedRecord.message.trim()
        : typeof nestedRecord.error === 'string' && nestedRecord.error.trim()
          ? nestedRecord.error.trim()
          : null,
    code:
      typeof nestedRecord.code === 'number' ||
      typeof nestedRecord.code === 'string'
        ? nestedRecord.code
        : undefined,
    type: typeof nestedRecord.type === 'string' ? nestedRecord.type : undefined,
  };
}

export function normalizeBots(payload: unknown): HybridAIBot[] {
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

  return raw
    .map((item) => ({
      id: String(item.id ?? item._id ?? item.chatbot_id ?? item.bot_id ?? ''),
      name: String(item.bot_name ?? item.name ?? 'Unnamed'),
      description:
        item.description != null ? String(item.description) : undefined,
      model:
        item.model1 != null
          ? String(item.model1)
          : item.model != null
            ? String(item.model)
            : undefined,
    }))
    .filter((bot) => Boolean(bot.id));
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
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${getHybridAIApiKey()}` },
      signal: AbortSignal.timeout(HYBRIDAI_BOT_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn(
      { err: error, url },
      'HybridAI bot fetch failed before receiving a response',
    );
    throw new HybridAIBotFetchError({
      status: 0,
      type: 'network_error',
      message: formatTransportFailure(error),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let payload: unknown = null;
    try {
      payload = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      payload = null;
    }
    const parsed = parseHybridAIErrorPayload(payload);
    logger.warn(
      {
        url,
        status: res.status,
        statusText: res.statusText,
        code: parsed.code,
        type: parsed.type,
      },
      'HybridAI bot fetch returned a non-OK response',
    );
    throw new HybridAIBotFetchError({
      status: res.status,
      message:
        parsed.message ||
        `Failed to fetch bots: ${res.status} ${res.statusText}`,
      ...(parsed.code !== undefined ? { code: parsed.code } : {}),
      ...(parsed.type ? { type: parsed.type } : {}),
    });
  }

  const bots = normalizeBots(await res.json());
  if (cacheTtlMs > 0) {
    botCache = { bots, fetchedAtMs: now };
  } else {
    botCache = null;
  }
  return bots;
}
