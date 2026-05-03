import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import type { A2AAgentCard } from './a2a-json-rpc.js';
import { isRecord } from './utils.js';

export const A2A_AGENT_CARD_CACHE_TTL_MS = 5 * 60_000;

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

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value as number));
}

function isAgentCard(value: unknown): value is A2AAgentCard {
  return isRecord(value) && typeof value.url === 'string' && !!value.url.trim();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  const [firstOctet] = normalized.split('.');
  return firstOctet === '127';
}

export function isA2AAllowedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
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

export async function fetchA2AAgentCard(input: {
  agentCardUrl: string;
  fetchImpl?: typeof fetch;
  now: Date;
  headers?: Record<string, string>;
  authCacheKey?: string;
  agentCardCacheTtlMs?: number;
}): Promise<A2AAgentCard> {
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
  });
  if (response.status === 304 && cached) {
    const refreshed = { ...cached, expiresAt: nowMs + ttlMs };
    agentCardCache.set(cacheKey, refreshed);
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
  agentCardCache.set(cacheKey, {
    card,
    etag: response.headers.get('etag') || undefined,
    expiresAt: nowMs + ttlMs,
  });
  return card;
}

export function clearA2AAgentCardCache(): void {
  agentCardCache.clear();
}
