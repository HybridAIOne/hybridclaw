import {
  dedupeResults,
  isRecord,
  normalizeResultUrl,
  normalizeWhitespace,
  stripTags,
  validateHttpUrl,
} from './search-utils.js';

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

export interface SearxngSearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
  category?: string;
  engine?: string;
  thumbnail?: string;
}

function normalizeText(value: unknown): string {
  return normalizeWhitespace(stripTags(String(value || '')));
}

function normalizeSearxngPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.endsWith('/search')) return trimmed || '/search';
  return `${trimmed || ''}/search`;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value, 10)
        : fallback;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
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
    String(normalizePositiveInteger(options.page, DEFAULT_SEARXNG_PAGE)),
  );
  if (options.count != null) {
    const count = normalizePositiveInteger(options.count, 0);
    if (count > 0) url.searchParams.set('num_results', String(count));
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

export function parseSearxngSearchResponse(
  payload: unknown,
): SearxngSearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid SearXNG search response');
  if (!Array.isArray(payload.results)) return [];

  const results: SearxngSearchResult[] = [];
  for (const entry of payload.results) {
    if (!isRecord(entry)) continue;

    const title = normalizeText(entry.title);
    const url = normalizeResultUrl(entry.url);
    if (!title || !url) continue;

    const snippet = normalizeText(
      entry.content ?? entry.snippet ?? entry.description,
    );
    const age =
      normalizeText(entry.publishedDate ?? entry.published_date ?? entry.age) ||
      undefined;
    const category = normalizeText(entry.category) || undefined;
    const engine = normalizeText(entry.engine) || undefined;
    const thumbnail = normalizeResultUrl(entry.thumbnail ?? entry.img_src);

    results.push({
      title,
      url,
      snippet,
      ...(age ? { age } : {}),
      ...(category ? { category } : {}),
      ...(engine ? { engine } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    });
  }

  return dedupeResults(results);
}
