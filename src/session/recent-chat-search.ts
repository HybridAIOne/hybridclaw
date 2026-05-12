export const DEFAULT_RECENT_CHAT_SESSION_LIMIT = 10;
export const MAX_RECENT_CHAT_SESSION_LIMIT = 200;
export const MAX_RECENT_CHAT_QUERY_LENGTH = 200;
const RECENT_CHAT_SEARCH_TERM_PATTERN = /[\p{L}\p{N}]+/gu;
const MAX_RECENT_CHAT_SEARCH_TERMS = 12;

export function normalizeRecentChatSessionLimit(limit?: number | null): number {
  const normalized =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.floor(limit)
      : DEFAULT_RECENT_CHAT_SESSION_LIMIT;
  return Math.max(1, Math.min(normalized, MAX_RECENT_CHAT_SESSION_LIMIT));
}

export function normalizeRecentChatSearchQuery(query?: string | null): string {
  return String(query || '')
    .trim()
    .slice(0, MAX_RECENT_CHAT_QUERY_LENGTH);
}

export function buildRecentChatSearchMatchQuery(
  normalizedQuery: string,
): string {
  const terms =
    normalizedQuery
      .match(RECENT_CHAT_SEARCH_TERM_PATTERN)
      ?.slice(0, MAX_RECENT_CHAT_SEARCH_TERMS) || [];
  return terms.map((term) => `${term}*`).join(' AND ');
}
