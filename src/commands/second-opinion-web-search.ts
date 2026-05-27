import {
  BRAVE_API_KEY,
  TAVILY_API_KEY,
  WEB_SEARCH_FALLBACK_PROVIDERS,
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_TAVILY_SEARCH_DEPTH,
} from '../config/config.js';

export type SecondOpinionWebSearchProvider = 'brave' | 'tavily' | 'duckduckgo';

export interface SecondOpinionWebSearchResult {
  title: string;
  url: string;
  snippet: string;
  fetchedExcerpt?: string;
}

export interface SecondOpinionWebSearchEvidence {
  provider: SecondOpinionWebSearchProvider;
  queries: string[];
  results: SecondOpinionWebSearchResult[];
}

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const DUCKDUCKGO_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const SECOND_OPINION_SEARCH_TIMEOUT_MS = 30_000;
const SECOND_OPINION_FETCH_TIMEOUT_MS = 10_000;
const SECOND_OPINION_SEARCH_RESULT_LIMIT = 10;
const SECOND_OPINION_FETCH_EXCERPT_LIMIT = 1200;
const SECOND_OPINION_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
  return value.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeSearchResultEntry(params: {
  title: unknown;
  url: unknown;
  snippet: unknown;
  fetchedExcerpt?: unknown;
}): SecondOpinionWebSearchResult | null {
  const title = normalizeWhitespace(String(params.title || ''));
  const url = normalizeUrl(params.url);
  if (!title || !url) return null;
  const snippet = normalizeWhitespace(String(params.snippet || ''));
  const fetchedExcerpt = normalizeWhitespace(
    String(params.fetchedExcerpt || ''),
  );
  return {
    title,
    url,
    snippet,
    ...(fetchedExcerpt
      ? {
          fetchedExcerpt: fetchedExcerpt.slice(
            0,
            SECOND_OPINION_FETCH_EXCERPT_LIMIT,
          ),
        }
      : {}),
  };
}

function normalizeBraveResult(
  entry: unknown,
): SecondOpinionWebSearchResult | null {
  if (!isRecord(entry)) return null;
  return normalizeSearchResultEntry({
    title: entry.title,
    url: entry.url,
    snippet: entry.description ?? entry.snippet,
  });
}

function normalizeTavilyResult(
  entry: unknown,
): SecondOpinionWebSearchResult | null {
  if (!isRecord(entry)) return null;
  return normalizeSearchResultEntry({
    title: entry.title,
    url: entry.url,
    snippet: entry.content ?? entry.snippet,
    fetchedExcerpt: entry.raw_content,
  });
}

function unwrapDuckDuckGoUrl(href: string): string {
  const decodedHref = decodeEntities(href).trim();
  if (!decodedHref) return '';
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
      return normalizeUrl(redirectTarget);
    }
  } catch {
    return normalizeUrl(absoluteHref);
  }

  return normalizeUrl(absoluteHref);
}

function parseDuckDuckGoHtml(html: string): SecondOpinionWebSearchResult[] {
  const results: SecondOpinionWebSearchResult[] = [];
  const linkRe =
    /<a[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = Array.from(html.matchAll(linkRe));

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const start = link.index ?? 0;
    const end = links[index + 1]?.index ?? html.length;
    const segment = html.slice(start, end);
    const url = unwrapDuckDuckGoUrl(link[1] || '');
    const title = normalizeWhitespace(stripTags(link[2] || ''));
    if (!url || !title) continue;

    const snippetMatch = segment.match(
      /class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    );
    results.push({
      title,
      url,
      snippet: normalizeWhitespace(stripTags(snippetMatch?.[1] || '')),
    });
  }
  return dedupeResults(results);
}

function buildTavilyBody(query: string): Record<string, unknown> {
  return {
    query,
    max_results: SECOND_OPINION_SEARCH_RESULT_LIMIT,
    search_depth: WEB_SEARCH_TAVILY_SEARCH_DEPTH,
    include_answer: false,
    include_images: false,
    include_raw_content: true,
  };
}

async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function dedupeResults(
  results: SecondOpinionWebSearchResult[],
): SecondOpinionWebSearchResult[] {
  const seenUrls = new Set<string>();
  const deduped: SecondOpinionWebSearchResult[] = [];
  for (const result of results) {
    const key = result.url.toLowerCase();
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    deduped.push(result);
  }
  return deduped;
}

async function searchBrave(
  query: string,
): Promise<SecondOpinionWebSearchResult[]> {
  if (!BRAVE_API_KEY.trim()) throw new Error('Brave is not configured');
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(SECOND_OPINION_SEARCH_RESULT_LIMIT));

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': SECOND_OPINION_USER_AGENT,
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    },
    SECOND_OPINION_SEARCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Brave search failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { web?: { results?: unknown[] } };
  const rawResults = isRecord(payload.web)
    ? extractArray(payload.web.results)
    : [];
  return rawResults
    .map(normalizeBraveResult)
    .filter((entry): entry is SecondOpinionWebSearchResult => entry !== null);
}

async function searchTavily(
  query: string,
): Promise<SecondOpinionWebSearchResult[]> {
  if (!TAVILY_API_KEY.trim()) throw new Error('Tavily is not configured');
  const response = await fetchWithTimeout(
    TAVILY_SEARCH_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTavilyBody(query)),
    },
    SECOND_OPINION_SEARCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Tavily search failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { results?: unknown[] };
  return (Array.isArray(payload.results) ? payload.results : [])
    .map(normalizeTavilyResult)
    .filter((entry): entry is SecondOpinionWebSearchResult => entry !== null);
}

async function searchDuckDuckGo(
  query: string,
): Promise<SecondOpinionWebSearchResult[]> {
  const url = new URL(DUCKDUCKGO_SEARCH_ENDPOINT);
  url.searchParams.set('q', query);
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': SECOND_OPINION_USER_AGENT,
      },
    },
    SECOND_OPINION_SEARCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed with HTTP ${response.status}.`);
  }
  return parseDuckDuckGoHtml(await response.text());
}

async function searchProvider(
  provider: SecondOpinionWebSearchProvider,
  query: string,
): Promise<SecondOpinionWebSearchResult[]> {
  switch (provider) {
    case 'brave':
      return searchBrave(query);
    case 'tavily':
      return searchTavily(query);
    case 'duckduckgo':
      return searchDuckDuckGo(query);
  }
}

function normalizeProvider(
  value: unknown,
): SecondOpinionWebSearchProvider | 'auto' | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'brave' ||
    normalized === 'tavily' ||
    normalized === 'duckduckgo'
  ) {
    return normalized;
  }
  return null;
}

function buildProviderChain(): SecondOpinionWebSearchProvider[] {
  const mode = normalizeProvider(WEB_SEARCH_PROVIDER) ?? 'auto';
  const seen = new Set<SecondOpinionWebSearchProvider>();
  const providers: SecondOpinionWebSearchProvider[] = [];
  const add = (provider: SecondOpinionWebSearchProvider) => {
    if (seen.has(provider)) return;
    seen.add(provider);
    providers.push(provider);
  };

  if (mode === 'auto') {
    if (BRAVE_API_KEY.trim()) add('brave');
    if (TAVILY_API_KEY.trim()) add('tavily');
  } else {
    add(mode);
    for (const fallback of WEB_SEARCH_FALLBACK_PROVIDERS) {
      const provider = normalizeProvider(fallback);
      if (provider && provider !== 'auto') add(provider);
    }
  }

  add('duckduckgo');
  return providers;
}

function htmlToExcerpt(value: string): string {
  const withoutScripts = value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return normalizeWhitespace(stripTags(withoutScripts)).slice(
    0,
    SECOND_OPINION_FETCH_EXCERPT_LIMIT,
  );
}

async function fetchExcerpt(url: string): Promise<string> {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'text/html,text/plain,application/json',
        'User-Agent': SECOND_OPINION_USER_AGENT,
      },
    },
    SECOND_OPINION_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) return '';
  return htmlToExcerpt(await response.text());
}

async function attachFetchedExcerpts(
  results: SecondOpinionWebSearchResult[],
): Promise<SecondOpinionWebSearchResult[]> {
  const enriched: SecondOpinionWebSearchResult[] = [];
  for (const result of results) {
    if (result.fetchedExcerpt) {
      enriched.push(result);
      continue;
    }
    try {
      const fetchedExcerpt = await fetchExcerpt(result.url);
      enriched.push({
        ...result,
        ...(fetchedExcerpt ? { fetchedExcerpt } : {}),
      });
    } catch {
      enriched.push(result);
    }
  }
  return enriched;
}

export async function runSecondOpinionWebSearch(params: {
  queries: string[];
}): Promise<SecondOpinionWebSearchEvidence> {
  const queries = params.queries
    .map((query) => normalizeWhitespace(query).slice(0, 500))
    .filter(Boolean)
    .slice(0, 5);
  if (queries.length === 0) {
    throw new Error(
      'Second opinion web fact-check requires model-generated search queries.',
    );
  }

  const failures: string[] = [];
  for (const provider of buildProviderChain()) {
    try {
      const results: SecondOpinionWebSearchResult[] = [];
      for (const query of queries) {
        results.push(...(await searchProvider(provider, query)));
        const deduped = dedupeResults(results);
        if (deduped.length >= SECOND_OPINION_SEARCH_RESULT_LIMIT) {
          return {
            provider,
            queries,
            results: await attachFetchedExcerpts(
              deduped.slice(0, SECOND_OPINION_SEARCH_RESULT_LIMIT),
            ),
          };
        }
      }
      const deduped = dedupeResults(results).slice(
        0,
        SECOND_OPINION_SEARCH_RESULT_LIMIT,
      );
      if (deduped.length > 0) {
        return {
          provider,
          queries,
          results: await attachFetchedExcerpts(deduped),
        };
      }
      failures.push(`${provider}: no results`);
    } catch (error) {
      failures.push(
        `${provider}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Second opinion web fact-check search failed for all providers (${failures.join(' | ')}). Configure BRAVE_API_KEY or TAVILY_API_KEY, or allow DuckDuckGo access.`,
  );
}
