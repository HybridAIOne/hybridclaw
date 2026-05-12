import type {
  SearchProviderMode,
  SearchProviderName,
  WebSearchConfig,
} from '../shared/web-search-config.js';

const DEFAULT_COUNT = 5;
const MIN_COUNT = 1;
const MAX_COUNT = 10;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 100;
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const PERPLEXITY_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const PERPLEXITY_SEARCH_ENDPOINT = 'https://api.perplexity.ai/search';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const DUCKDUCKGO_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

const AUTO_PROVIDER_ORDER: SearchProviderName[] = [
  'brave',
  'perplexity',
  'tavily',
  'searxng',
];

const FRESHNESS_TO_BRAVE: Record<SearchFreshness, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

const FRESHNESS_TO_PERPLEXITY: Record<SearchFreshness, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
};

const FRESHNESS_TO_TAVILY_DAYS: Record<SearchFreshness, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const FRESHNESS_TO_SEARXNG: Partial<Record<SearchFreshness, string>> = {
  day: 'day',
  month: 'month',
  year: 'year',
};

const BRAVE_LANGUAGE_ALIASES: Record<string, string> = {
  he: 'iw',
  id: 'in',
  nb: 'no',
  nn: 'no',
  zh: 'zh-hans',
  'zh-cn': 'zh-hans',
  'zh-tw': 'zh-hant',
};

export type {
  SearchProviderMode,
  SearchProviderName,
  WebSearchConfig,
} from '../shared/web-search-config.js';

export type SearchFreshness = 'day' | 'week' | 'month' | 'year';

export interface SearchProvider {
  name: SearchProviderName;
  search(
    query: string,
    count: number,
    signal: AbortSignal,
  ): Promise<SearchResult[]>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

export type WebSearchRuntimeConfig = WebSearchConfig;

export interface WebSearchParams {
  query: string;
  count?: number;
  freshness?: SearchFreshness;
  country?: string;
  language?: string;
  provider?: SearchProviderMode;
}

interface NormalizedSearchParams {
  query: string;
  count: number;
  freshness?: SearchFreshness;
  country?: string;
  language?: string;
  provider?: SearchProviderMode;
}

interface SearchExecutionContext {
  freshness?: SearchFreshness;
  country?: string;
  language?: string;
}

export interface WebSearchExecutionResult {
  query: string;
  provider: SearchProviderName;
  requestedProvider: SearchProviderMode;
  attemptedProviders: SearchProviderName[];
  results: SearchResult[];
  fetchedAt: string;
  tookMs: number;
  cached?: boolean;
}

interface CacheEntry {
  value: WebSearchExecutionResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function readCache(key: string): WebSearchExecutionResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(
  key: string,
  value: WebSearchExecutionResult,
  ttlMs: number,
): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export function clearWebSearchCache(): void {
  cache.clear();
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

function readEnv(name: string): string {
  return String(process.env[name] || '').trim();
}

function normalizeCount(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value, 10)
        : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.trunc(parsed)));
}

function normalizeCacheTtlMinutes(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value, 10)
        : 5;
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(60, Math.trunc(parsed)));
}

function normalizeProviderName(value: unknown): SearchProviderName | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  switch (normalized) {
    case 'brave':
    case 'perplexity':
    case 'tavily':
    case 'duckduckgo':
    case 'searxng':
      return normalized;
    default:
      return null;
  }
}

function normalizeProviderMode(
  value: unknown,
  fallback: SearchProviderMode = 'auto',
): SearchProviderMode {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'auto') return 'auto';
  const provider = normalizeProviderName(normalized);
  if (!provider) {
    throw new Error(`Invalid web search provider: ${String(value)}`);
  }
  return provider;
}

function normalizeProviderList(value: unknown): SearchProviderName[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set<SearchProviderName>();
  const providers: SearchProviderName[] = [];
  for (const raw of rawValues) {
    const provider = normalizeProviderName(raw);
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

function normalizeFreshness(value: unknown): SearchFreshness | undefined {
  if (value == null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  switch (normalized) {
    case 'day':
    case 'week':
    case 'month':
    case 'year':
      return normalized;
    default:
      throw new Error(`Invalid freshness: ${String(value)}`);
  }
}

function normalizeCountry(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(`Invalid country code: ${String(value)}`);
  }
  return normalized;
}

function normalizeLanguage(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(normalized)) {
    throw new Error(`Invalid language code: ${String(value)}`);
  }
  return normalized;
}

export function normalizeSearchParams(
  params: WebSearchParams,
  config: Pick<WebSearchConfig, 'defaultCount'> = {
    defaultCount: DEFAULT_COUNT,
  },
): NormalizedSearchParams {
  if (params.query == null) throw new Error('Search query is required');
  const query = String(params.query).trim();
  if (!query) throw new Error('Search query cannot be empty');

  return {
    query,
    count: normalizeCount(params.count, normalizeCount(config.defaultCount, 5)),
    freshness: normalizeFreshness(params.freshness),
    country: normalizeCountry(params.country),
    language: normalizeLanguage(params.language),
    provider: params.provider
      ? normalizeProviderMode(params.provider)
      : undefined,
  };
}

export function getWebSearchConfigFromEnv(
  override?: Partial<WebSearchRuntimeConfig>,
): WebSearchConfig {
  const envConfig: WebSearchConfig = {
    provider: normalizeProviderMode(
      readEnv('HYBRIDCLAW_WEB_SEARCH_PROVIDER'),
      'auto',
    ),
    fallbackProviders: normalizeProviderList(
      readEnv('HYBRIDCLAW_WEB_SEARCH_FALLBACK_PROVIDERS'),
    ),
    defaultCount: normalizeCount(
      readEnv('HYBRIDCLAW_WEB_SEARCH_DEFAULT_COUNT'),
      DEFAULT_COUNT,
    ),
    cacheTtlMinutes: normalizeCacheTtlMinutes(
      readEnv('HYBRIDCLAW_WEB_SEARCH_CACHE_TTL_MINUTES'),
    ),
    searxngBaseUrl:
      readEnv('SEARXNG_BASE_URL') ||
      readEnv('HYBRIDCLAW_WEB_SEARCH_SEARXNG_BASE_URL'),
    tavilySearchDepth:
      readEnv('HYBRIDCLAW_WEB_SEARCH_TAVILY_SEARCH_DEPTH').toLowerCase() ===
      'basic'
        ? 'basic'
        : 'advanced',
    braveApiKey: readEnv('BRAVE_API_KEY'),
    perplexityApiKey: readEnv('PERPLEXITY_API_KEY'),
    tavilyApiKey: readEnv('TAVILY_API_KEY'),
  };

  return {
    ...envConfig,
    ...(override?.provider != null
      ? { provider: normalizeProviderMode(override.provider) }
      : {}),
    ...(override?.fallbackProviders != null
      ? {
          fallbackProviders: normalizeProviderList(override.fallbackProviders),
        }
      : {}),
    ...(override?.defaultCount != null
      ? {
          defaultCount: normalizeCount(
            override.defaultCount,
            envConfig.defaultCount,
          ),
        }
      : {}),
    ...(override?.cacheTtlMinutes != null
      ? {
          cacheTtlMinutes: normalizeCacheTtlMinutes(override.cacheTtlMinutes),
        }
      : {}),
    ...(override?.searxngBaseUrl != null
      ? {
          searxngBaseUrl: String(override.searxngBaseUrl || '').trim(),
        }
      : {}),
    ...(override?.tavilySearchDepth != null
      ? {
          tavilySearchDepth:
            String(override.tavilySearchDepth).trim().toLowerCase() === 'basic'
              ? 'basic'
              : 'advanced',
        }
      : {}),
    ...(override?.braveApiKey != null
      ? { braveApiKey: String(override.braveApiKey || '').trim() }
      : {}),
    ...(override?.perplexityApiKey != null
      ? { perplexityApiKey: String(override.perplexityApiKey || '').trim() }
      : {}),
    ...(override?.tavilyApiKey != null
      ? { tavilyApiKey: String(override.tavilyApiKey || '').trim() }
      : {}),
  };
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

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const urlKey = result.url.toLowerCase();
    if (seen.has(urlKey)) continue;
    seen.add(urlKey);
    deduped.push(result);
  }
  return deduped;
}

function normalizeSearchResults(
  results: Array<{
    title?: unknown;
    url?: unknown;
    snippet?: unknown;
    age?: unknown;
  }>,
): SearchResult[] {
  const normalized: SearchResult[] = [];
  for (const entry of results) {
    const title = normalizeWhitespace(String(entry.title || ''));
    const url = normalizeResultUrl(entry.url);
    if (!title || !url) continue;
    const snippet = normalizeWhitespace(String(entry.snippet || ''));
    const age = normalizeWhitespace(String(entry.age || ''));
    normalized.push({
      title,
      url,
      snippet,
      ...(age ? { age } : {}),
    });
  }
  return dedupeResults(normalized);
}

function createTimeoutSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cancel: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const cancel = () => {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
  };

  return {
    signal: controller.signal,
    cancel,
    didTimeout: () => timedOut,
  };
}

async function readResponseText(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (body && typeof body === 'object' && 'getReader' in body) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let truncated = false;
    const parts: string[] = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        let chunk = value;
        if (bytesRead + chunk.byteLength > maxBytes) {
          const remaining = Math.max(0, maxBytes - bytesRead);
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          chunk = chunk.subarray(0, remaining);
          truncated = true;
        }

        bytesRead += chunk.byteLength;
        parts.push(decoder.decode(chunk, { stream: true }));
        if (truncated || bytesRead >= maxBytes) {
          truncated = true;
          break;
        }
      }
    } finally {
      if (truncated) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
      }
    }

    parts.push(decoder.decode());
    return { text: parts.join(''), truncated };
  }

  const text = await res.text();
  return { text, truncated: false };
}

async function readJsonResponse(
  res: Response,
  provider: string,
): Promise<unknown> {
  const { text } = await readResponseText(res, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${provider} returned invalid JSON`);
  }
}

function buildHttpError(res: Response): Error {
  return new Error(`HTTP ${res.status}`);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted|abort/i.test(error.message))
  );
}

function sanitizeProviderError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const message = error.message.replace(/\s+/g, ' ').trim();
  if (/HTTP \d+/i.test(message)) {
    return message.match(/HTTP \d+/i)?.[0].replace(/^HTTP\s+/i, '') || message;
  }
  if (/timeout/i.test(message)) return 'timeout';
  if (/not configured/i.test(message)) return 'not configured';
  if (/invalid/i.test(message)) return 'invalid response';
  return message.slice(0, 80);
}

function buildCacheKey(
  params: NormalizedSearchParams,
  requestedProvider: SearchProviderMode,
): string {
  const suffix = [params.country || '', params.language || '']
    .filter(Boolean)
    .join(':');
  return `search:${params.query}:${params.count}:${requestedProvider}:${params.freshness || ''}${suffix ? `:${suffix}` : ''}`.toLowerCase();
}

export function mapFreshnessForProvider(
  provider: SearchProviderName,
  freshness?: SearchFreshness,
): string | number | undefined {
  if (!freshness) return undefined;
  switch (provider) {
    case 'brave':
      return FRESHNESS_TO_BRAVE[freshness];
    case 'perplexity':
      return FRESHNESS_TO_PERPLEXITY[freshness];
    case 'tavily':
      return FRESHNESS_TO_TAVILY_DAYS[freshness];
    case 'searxng':
      return FRESHNESS_TO_SEARXNG[freshness];
    case 'duckduckgo':
      return undefined;
  }
}

function mapLanguageForBrave(language?: string): string | undefined {
  if (!language) return undefined;
  return BRAVE_LANGUAGE_ALIASES[language] || language;
}

function buildProviderRequestContext(
  context: SearchExecutionContext,
): SearchExecutionContext & {
  braveFreshness?: string;
  braveLanguage?: string;
  perplexityFreshness?: string;
  tavilyDays?: number;
  searxngTimeRange?: string;
} {
  return {
    ...context,
    braveFreshness:
      typeof mapFreshnessForProvider('brave', context.freshness) === 'string'
        ? (mapFreshnessForProvider('brave', context.freshness) as string)
        : undefined,
    braveLanguage: mapLanguageForBrave(context.language),
    perplexityFreshness:
      typeof mapFreshnessForProvider('perplexity', context.freshness) ===
      'string'
        ? (mapFreshnessForProvider('perplexity', context.freshness) as string)
        : undefined,
    tavilyDays:
      typeof mapFreshnessForProvider('tavily', context.freshness) === 'number'
        ? (mapFreshnessForProvider('tavily', context.freshness) as number)
        : undefined,
    searxngTimeRange:
      typeof mapFreshnessForProvider('searxng', context.freshness) === 'string'
        ? (mapFreshnessForProvider('searxng', context.freshness) as string)
        : undefined,
  };
}

function extractArray(
  value: unknown,
): Array<Record<string, unknown> | string | number> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> | string | number =>
      isRecord(entry) || typeof entry === 'string' || typeof entry === 'number',
  );
}

export function parseBraveSearchResponse(payload: unknown): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid Brave search response');
  const rawWeb = isRecord(payload.web) ? payload.web : {};
  const rawResults = extractArray(rawWeb.results);
  return normalizeSearchResults(
    rawResults
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        title: entry.title,
        url: entry.url,
        snippet: entry.description ?? entry.snippet,
        age: entry.age ?? entry.page_age ?? entry.pageAge,
      })),
  );
}

function parsePerplexitySearchResponse(payload: unknown): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid Perplexity search response');
  const rawResults = extractArray(
    payload.results ?? payload.search_results ?? payload.data,
  );
  return normalizeSearchResults(
    rawResults
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        title: entry.title ?? entry.name,
        url: entry.url,
        snippet: entry.snippet ?? entry.content ?? entry.description,
        age:
          entry.age ?? entry.date ?? entry.published_date ?? entry.last_updated,
      })),
  );
}

function parseTavilySearchResponse(payload: unknown): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid Tavily search response');
  const rawResults = extractArray(payload.results);
  return normalizeSearchResults(
    rawResults
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        title: entry.title,
        url: entry.url,
        snippet: entry.content ?? entry.snippet ?? entry.description,
        age: entry.published_date,
      })),
  );
}

function parseSearxngSearchResponse(payload: unknown): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid SearXNG search response');
  const rawResults = extractArray(payload.results);
  return normalizeSearchResults(
    rawResults
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        title: entry.title,
        url: entry.url,
        snippet: entry.content ?? entry.snippet ?? entry.description,
        age: entry.publishedDate ?? entry.published_date ?? entry.age,
      })),
  );
}

function unwrapDuckDuckGoUrl(href: string): string | null {
  const decodedHref = decodeEntities(href).trim();
  if (!decodedHref) return null;

  const absoluteHref = decodedHref.startsWith('//')
    ? `https:${decodedHref}`
    : decodedHref.startsWith('/')
      ? new URL(decodedHref, 'https://duckduckgo.com').toString()
      : decodedHref;

  try {
    const parsed = new URL(absoluteHref);
    const redirectTarget = parsed.searchParams.get('uddg');
    if (
      redirectTarget &&
      (parsed.hostname === 'duckduckgo.com' ||
        parsed.hostname === 'html.duckduckgo.com')
    ) {
      return normalizeResultUrl(redirectTarget);
    }
  } catch {
    return normalizeResultUrl(absoluteHref);
  }

  return normalizeResultUrl(absoluteHref);
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe =
    /<a[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = Array.from(html.matchAll(linkRe));

  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    const start = link.index ?? 0;
    const end = links[i + 1]?.index ?? html.length;
    const segment = html.slice(start, end);
    const url = unwrapDuckDuckGoUrl(link[1] || '');
    if (!url) continue;

    const title = normalizeWhitespace(stripTags(link[2] || ''));
    if (!title) continue;

    const snippetMatch = segment.match(
      /class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    );
    const snippet = normalizeWhitespace(stripTags(snippetMatch?.[1] || ''));

    results.push({ title, url, snippet });
  }

  return dedupeResults(results);
}

function createBraveProvider(
  config: WebSearchConfig,
  context: SearchExecutionContext,
): SearchProvider {
  const requestContext = buildProviderRequestContext(context);
  return {
    name: 'brave',
    async search(query: string, count: number, signal: AbortSignal) {
      if (!config.braveApiKey) throw new Error('Brave is not configured');
      const timeout = createTimeoutSignal(signal, DEFAULT_PROVIDER_TIMEOUT_MS);
      try {
        const url = new URL(BRAVE_SEARCH_ENDPOINT);
        url.searchParams.set('q', query);
        url.searchParams.set('count', String(count));
        if (requestContext.country) {
          url.searchParams.set('country', requestContext.country);
        }
        if (requestContext.braveLanguage) {
          url.searchParams.set('search_lang', requestContext.braveLanguage);
        }
        if (requestContext.braveFreshness) {
          url.searchParams.set('freshness', requestContext.braveFreshness);
        }

        const res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            'X-Subscription-Token': config.braveApiKey,
          },
          signal: timeout.signal,
        });
        if (!res.ok) throw buildHttpError(res);
        return parseBraveSearchResponse(await readJsonResponse(res, 'Brave'));
      } catch (error) {
        if (signal.aborted) throw error;
        if (timeout.didTimeout() || isAbortError(error)) {
          throw new Error('timeout');
        }
        throw error;
      } finally {
        timeout.cancel();
      }
    },
  };
}

function createPerplexityProvider(
  config: WebSearchConfig,
  context: SearchExecutionContext,
): SearchProvider {
  const requestContext = buildProviderRequestContext(context);
  return {
    name: 'perplexity',
    async search(query: string, count: number, signal: AbortSignal) {
      if (!config.perplexityApiKey) {
        throw new Error('Perplexity is not configured');
      }

      const timeout = createTimeoutSignal(signal, PERPLEXITY_TIMEOUT_MS);
      try {
        const body: Record<string, unknown> = {
          query,
          max_results: count,
        };
        if (requestContext.perplexityFreshness) {
          body.search_recency_filter = requestContext.perplexityFreshness;
        }
        if (requestContext.country) {
          body.country = requestContext.country;
        }

        const res = await fetch(PERPLEXITY_SEARCH_ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.perplexityApiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: timeout.signal,
        });
        if (!res.ok) throw buildHttpError(res);
        return parsePerplexitySearchResponse(
          await readJsonResponse(res, 'Perplexity'),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (timeout.didTimeout() || isAbortError(error)) {
          throw new Error('timeout');
        }
        throw error;
      } finally {
        timeout.cancel();
      }
    },
  };
}

function createTavilyProvider(
  config: WebSearchConfig,
  context: SearchExecutionContext,
): SearchProvider {
  const requestContext = buildProviderRequestContext(context);
  return {
    name: 'tavily',
    async search(query: string, count: number, signal: AbortSignal) {
      if (!config.tavilyApiKey) throw new Error('Tavily is not configured');

      const timeout = createTimeoutSignal(signal, DEFAULT_PROVIDER_TIMEOUT_MS);
      try {
        const body: Record<string, unknown> = {
          query,
          max_results: count,
          search_depth: config.tavilySearchDepth,
          include_answer: false,
          include_images: false,
          include_raw_content: false,
        };
        if (requestContext.tavilyDays != null) {
          body.days = requestContext.tavilyDays;
        }

        const res = await fetch(TAVILY_SEARCH_ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.tavilyApiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: timeout.signal,
        });
        if (!res.ok) throw buildHttpError(res);
        return parseTavilySearchResponse(await readJsonResponse(res, 'Tavily'));
      } catch (error) {
        if (signal.aborted) throw error;
        if (timeout.didTimeout() || isAbortError(error)) {
          throw new Error('timeout');
        }
        throw error;
      } finally {
        timeout.cancel();
      }
    },
  };
}

function createDuckDuckGoProvider(): SearchProvider {
  return {
    name: 'duckduckgo',
    async search(query: string, count: number, signal: AbortSignal) {
      const timeout = createTimeoutSignal(signal, DEFAULT_PROVIDER_TIMEOUT_MS);
      try {
        const url = new URL(DUCKDUCKGO_SEARCH_ENDPOINT);
        url.searchParams.set('q', query);

        const res = await fetch(url, {
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': USER_AGENT,
          },
          signal: timeout.signal,
        });
        if (!res.ok) throw buildHttpError(res);
        const { text } = await readResponseText(res, MAX_RESPONSE_BYTES);
        return parseDuckDuckGoHtml(text).slice(0, count);
      } catch (error) {
        if (signal.aborted) throw error;
        if (timeout.didTimeout() || isAbortError(error)) {
          throw new Error('timeout');
        }
        throw error;
      } finally {
        timeout.cancel();
      }
    },
  };
}

function buildSearxngSearchUrl(
  baseUrl: string,
  query: string,
  count: number,
  context: ReturnType<typeof buildProviderRequestContext>,
): string {
  const normalizedBase = validateHttpUrl(baseUrl);
  if (!normalizedBase) throw new Error('SearXNG base URL is invalid');
  const url = new URL(normalizedBase);
  if (!url.pathname.endsWith('/search')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
  }
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', query);
  url.searchParams.set('pageno', '1');
  url.searchParams.set('language', context.language || 'all');
  url.searchParams.set('safesearch', '0');
  url.searchParams.set('results', String(count));
  if (context.searxngTimeRange) {
    url.searchParams.set('time_range', context.searxngTimeRange);
  }
  return url.toString();
}

function createSearxngProvider(
  config: WebSearchConfig,
  context: SearchExecutionContext,
): SearchProvider {
  const requestContext = buildProviderRequestContext(context);
  return {
    name: 'searxng',
    async search(query: string, count: number, signal: AbortSignal) {
      if (!config.searxngBaseUrl) throw new Error('SearXNG is not configured');

      const timeout = createTimeoutSignal(signal, DEFAULT_PROVIDER_TIMEOUT_MS);
      try {
        const res = await fetch(
          buildSearxngSearchUrl(
            config.searxngBaseUrl,
            query,
            count,
            requestContext,
          ),
          {
            headers: {
              Accept: 'application/json',
              'User-Agent': USER_AGENT,
            },
            signal: timeout.signal,
          },
        );
        if (!res.ok) throw buildHttpError(res);
        return parseSearxngSearchResponse(
          await readJsonResponse(res, 'SearXNG'),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (timeout.didTimeout() || isAbortError(error)) {
          throw new Error('timeout');
        }
        throw error;
      } finally {
        timeout.cancel();
      }
    },
  };
}

function createProvider(
  name: SearchProviderName,
  config: WebSearchConfig,
  context: SearchExecutionContext,
): SearchProvider {
  switch (name) {
    case 'brave':
      return createBraveProvider(config, context);
    case 'perplexity':
      return createPerplexityProvider(config, context);
    case 'tavily':
      return createTavilyProvider(config, context);
    case 'duckduckgo':
      return createDuckDuckGoProvider();
    case 'searxng':
      return createSearxngProvider(config, context);
  }
}

function isProviderAvailable(
  name: SearchProviderName,
  config: WebSearchConfig,
): boolean {
  switch (name) {
    case 'brave':
      return Boolean(config.braveApiKey);
    case 'perplexity':
      return Boolean(config.perplexityApiKey);
    case 'tavily':
      return Boolean(config.tavilyApiKey);
    case 'searxng':
      return Boolean(config.searxngBaseUrl);
    case 'duckduckgo':
      return true;
  }
}

export function buildProviderChain(
  config: WebSearchConfig,
  context: SearchExecutionContext = {},
): SearchProvider[] {
  const mode = normalizeProviderMode(config.provider);
  const seen = new Set<SearchProviderName>();
  const ordered: SearchProviderName[] = [];

  const add = (name: SearchProviderName) => {
    if (seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
  };

  if (mode === 'auto') {
    for (const provider of AUTO_PROVIDER_ORDER) {
      if (isProviderAvailable(provider, config)) add(provider);
    }
  } else if (mode !== 'duckduckgo') {
    add(mode);
    for (const fallback of normalizeProviderList(config.fallbackProviders)) {
      add(fallback);
    }
  }

  add('duckduckgo');
  return ordered.map((provider) => createProvider(provider, config, context));
}

export async function searchWeb(
  params: WebSearchParams,
  configOverride?: Partial<WebSearchRuntimeConfig>,
): Promise<WebSearchExecutionResult> {
  const config = getWebSearchConfigFromEnv(configOverride);
  const normalized = normalizeSearchParams(params, config);
  const requestedProvider = normalized.provider ?? config.provider;
  const effectiveConfig: WebSearchConfig = {
    ...config,
    provider: requestedProvider,
  };
  const cacheKey = buildCacheKey(normalized, requestedProvider);
  const cached = readCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  const controller = new AbortController();
  const start = Date.now();
  const providers = buildProviderChain(effectiveConfig, normalized);
  const attemptedProviders: SearchProviderName[] = [];
  const errors: string[] = [];

  for (const provider of providers) {
    attemptedProviders.push(provider.name);
    try {
      const results = await provider.search(
        normalized.query,
        normalized.count,
        controller.signal,
      );
      const result: WebSearchExecutionResult = {
        query: normalized.query,
        provider: provider.name,
        requestedProvider,
        attemptedProviders,
        results: results.slice(0, normalized.count),
        fetchedAt: new Date().toISOString(),
        tookMs: Date.now() - start,
      };
      writeCache(
        cacheKey,
        result,
        effectiveConfig.cacheTtlMinutes * 60_000 || DEFAULT_CACHE_TTL_MS,
      );
      return result;
    } catch (error) {
      errors.push(`${provider.name}:${sanitizeProviderError(error)}`);
    }
  }

  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

function formatSearchResults(result: WebSearchExecutionResult): string {
  const cachedSuffix = result.cached ? ' [cached]' : '';
  const header = `Web search via ${result.provider}${cachedSuffix} (${result.results.length} result${result.results.length === 1 ? '' : 's'}, ${result.tookMs}ms)`;
  if (result.results.length === 0) {
    return `${header}\n\nNo results found for "${result.query}".`;
  }

  const lines = [header];
  for (const [index, entry] of result.results.entries()) {
    lines.push('');
    lines.push(`${index + 1}. ${entry.title}`);
    lines.push(entry.url);
    if (entry.age) lines.push(`Age: ${entry.age}`);
    if (entry.snippet) lines.push(entry.snippet);
  }
  return lines.join('\n');
}

export async function webSearch(
  params: WebSearchParams,
  configOverride?: Partial<WebSearchRuntimeConfig>,
): Promise<string> {
  return formatSearchResults(await searchWeb(params, configOverride));
}
