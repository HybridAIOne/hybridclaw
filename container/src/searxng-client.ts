import { parsePositiveInteger } from '@hybridclaw/shared/primitive-values';
import {
  normalizeWhitespace,
  validateHttpUrl,
} from '@hybridclaw/shared/provider-wire/web-search-parsers';

const DEFAULT_SEARXNG_PAGE = 1;
const DEFAULT_SEARXNG_SAFE_SEARCH = 1;

export type SearxngTimeRange = 'day' | 'month' | 'year';
export type SearxngSafeSearch = 0 | 1 | 2;

export interface SearxngSearchOptions {
  baseUrl: string;
  query: string;
  categories?: string[] | string;
  engines?: string[] | string;
  language?: string;
  page?: number;
  count?: number;
  safeSearch?: SearxngSafeSearch;
  timeRange?: SearxngTimeRange;
}

function normalizeSearxngPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.endsWith('/search')) return trimmed || '/search';
  return `${trimmed || ''}/search`;
}

function normalizeSafeSearch(value: unknown): SearxngSafeSearch {
  return value === 0 || value === 1 || value === 2
    ? value
    : DEFAULT_SEARXNG_SAFE_SEARCH;
}

export function normalizeSearxngListParam(
  value: string[] | string | undefined,
): string {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of rawValues) {
    const item = String(raw || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return normalized.join(',');
}

export function buildSearxngSearchUrl(options: SearxngSearchOptions): string {
  const normalizedBase = validateHttpUrl(options.baseUrl);
  if (!normalizedBase) throw new Error('SearXNG base URL is invalid');
  const query = normalizeWhitespace(options.query);
  if (!query) throw new Error('SearXNG query is required');

  const url = new URL(normalizedBase);
  url.pathname = normalizeSearxngPath(url.pathname);
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', query);
  url.searchParams.set(
    'pageno',
    String(parsePositiveInteger(options.page) ?? DEFAULT_SEARXNG_PAGE),
  );
  if (options.count != null) {
    const count = parsePositiveInteger(options.count);
    if (count !== null) url.searchParams.set('num_results', String(count));
  }
  url.searchParams.set('language', options.language || 'all');
  url.searchParams.set(
    'safesearch',
    String(normalizeSafeSearch(options.safeSearch)),
  );

  const categories = normalizeSearxngListParam(options.categories);
  if (categories) url.searchParams.set('categories', categories);

  const engines = normalizeSearxngListParam(options.engines);
  if (engines) url.searchParams.set('engines', engines);

  if (options.timeRange) {
    url.searchParams.set('time_range', options.timeRange);
  }

  return url.toString();
}
