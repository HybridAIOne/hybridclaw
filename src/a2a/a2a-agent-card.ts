import { createHash } from 'node:crypto';

import type { A2AAgentCard } from './a2a-json-rpc.js';
import {
  isA2AAllowedHttpUrl,
  isRecord,
  normalizePositiveInteger,
} from './utils.js';

export const A2A_AGENT_CARD_CACHE_TTL_MS = 5 * 60_000;
export const A2A_AGENT_CARD_CACHE_MAX_ENTRIES = 256;

interface CachedAgentCard {
  card: A2AAgentCard;
  etag?: string;
  expiresAt: number;
}

const agentCardCache = new Map<string, CachedAgentCard>();

export class A2AHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'A2AHttpError';
  }
}

export class A2AFailFastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2AFailFastError';
  }
}

function isAgentCard(value: unknown): value is A2AAgentCard {
  return isRecord(value) && typeof value.url === 'string' && !!value.url.trim();
}

function cacheKeyFor(input: {
  agentCardUrl: string;
  authCacheKey?: string;
}): string {
  if (!input.authCacheKey) return input.agentCardUrl;
  const authHash = createHash('sha256')
    .update(input.authCacheKey)
    .digest('base64url');
  return `${input.agentCardUrl}#auth=${authHash}`;
}

function evictExpiredAgentCards(nowMs: number): void {
  for (const [key, cached] of agentCardCache) {
    if (cached.expiresAt <= nowMs) {
      agentCardCache.delete(key);
    }
  }
}

function cacheAgentCard(
  cacheKey: string,
  card: CachedAgentCard,
  nowMs: number,
): void {
  evictExpiredAgentCards(nowMs);
  if (
    !agentCardCache.has(cacheKey) &&
    agentCardCache.size >= A2A_AGENT_CARD_CACHE_MAX_ENTRIES
  ) {
    const oldestKey = agentCardCache.keys().next().value;
    if (oldestKey) {
      agentCardCache.delete(oldestKey);
    }
  }
  agentCardCache.set(cacheKey, card);
}

export async function fetchA2AAgentCard(input: {
  agentCardUrl: string;
  fetchImpl?: typeof fetch;
  now: Date;
  headers?: Record<string, string>;
  authCacheKey?: string;
  agentCardCacheTtlMs?: number;
}): Promise<A2AAgentCard> {
  if (!isA2AAllowedHttpUrl(input.agentCardUrl)) {
    throw new A2AFailFastError(
      'Agent Card URL must use https unless targeting loopback',
    );
  }
  const nowMs = input.now.getTime();
  const ttlMs = normalizePositiveInteger(
    input.agentCardCacheTtlMs,
    A2A_AGENT_CARD_CACHE_TTL_MS,
  );
  const cacheKey = cacheKeyFor(input);
  const cached = agentCardCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.card;
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(input.headers || {}),
  };
  if (cached?.etag) {
    headers['if-none-match'] = cached.etag;
  }

  const response = await (input.fetchImpl ?? fetch)(input.agentCardUrl, {
    method: 'GET',
    headers,
    redirect: 'error',
  });
  if (response.status === 304 && cached) {
    const refreshed = { ...cached, expiresAt: nowMs + ttlMs };
    cacheAgentCard(cacheKey, refreshed, nowMs);
    return refreshed.card;
  }
  if (!response.ok) {
    throw new A2AHttpError(
      `Agent Card HTTP ${response.status}`,
      response.status,
    );
  }

  const body = (await response.json()) as unknown;
  if (!isAgentCard(body)) {
    throw new A2AFailFastError('Agent Card must include a URL');
  }
  const card: A2AAgentCard = {
    ...body,
    url: body.url.trim(),
  };
  if (!isA2AAllowedHttpUrl(card.url)) {
    throw new A2AFailFastError(
      'Agent Card url must use https unless targeting loopback',
    );
  }
  cacheAgentCard(
    cacheKey,
    {
      card,
      etag: response.headers.get('etag') || undefined,
      expiresAt: nowMs + ttlMs,
    },
    nowMs,
  );
  return card;
}

export function clearA2AAgentCardCache(): void {
  agentCardCache.clear();
}
