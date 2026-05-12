const DEFAULT_SEARXNG_PAGE = 1;
const DEFAULT_SEARXNG_SAFE_SEARCH = 0;

export type SearxngTimeRange = 'day' | 'month' | 'year';
export type SearxngSafeSearch = 0 | 1 | 2;

export interface SearxngSearchOptions {
  baseUrl: string;
  query: string;
  categories?: string[] | string;
  engines?: string[] | string;
  language?: string;
  page?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gi, (_, dec) =>
      String.fromCharCode(Number.parseInt(dec, 10)),
    );
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''));
}

function normalizeWhitespace(value: string): string {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeText(value: unknown): string {
  return normalizeWhitespace(stripTags(String(value || '')));
}

function validateHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeResultUrl(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return validateHttpUrl(normalized);
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
  return value === 1 || value === 2 ? value : DEFAULT_SEARXNG_SAFE_SEARCH;
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

function readOptionalText(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function dedupeResults(results: SearxngSearchResult[]): SearxngSearchResult[] {
  const seen = new Set<string>();
  const deduped: SearxngSearchResult[] = [];
  for (const result of results) {
    const urlKey = result.url.toLowerCase();
    if (seen.has(urlKey)) continue;
    seen.add(urlKey);
    deduped.push(result);
  }
  return deduped;
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
    const age = readOptionalText(
      entry.publishedDate ?? entry.published_date ?? entry.age,
    );
    const category = readOptionalText(entry.category);
    const engine = readOptionalText(entry.engine);
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
