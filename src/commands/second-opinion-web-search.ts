import type { SearchProviderName } from '@hybridclaw/contracts/web-search-config';
import {
  BRAVE_SEARCH_ENDPOINT,
  DUCKDUCKGO_SEARCH_ENDPOINT,
  dedupeResults,
  parseBraveSearchResponse,
  parseDuckDuckGoHtml,
  parseTavilySearchResponse,
  type SearchResult,
  stripTags,
  TAVILY_SEARCH_ENDPOINT,
} from '@hybridclaw/shared/provider-wire/web-search-parsers';
import {
  BRAVE_API_KEY,
  TAVILY_API_KEY,
  WEB_SEARCH_FALLBACK_PROVIDERS,
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_TAVILY_SEARCH_DEPTH,
} from '../config/config.js';

export type SecondOpinionWebSearchProvider = Extract<
  SearchProviderName,
  'brave' | 'tavily' | 'duckduckgo'
>;

export type SecondOpinionWebSearchResult = Omit<SearchResult, 'rawContent'> & {
  fetchedExcerpt?: string;
};

export interface SecondOpinionWebSearchEvidence {
  provider: SecondOpinionWebSearchProvider;
  queries: string[];
  results: SecondOpinionWebSearchResult[];
}

const SECOND_OPINION_SEARCH_TIMEOUT_MS = 30_000;
const SECOND_OPINION_FETCH_TIMEOUT_MS = 10_000;
const SECOND_OPINION_SEARCH_RESULT_LIMIT = 10;
const SECOND_OPINION_FETCH_EXCERPT_LIMIT = 1200;
const SECOND_OPINION_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function findHtmlTagEnd(value: string, start: number): number {
  let quote = '';
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function removeRawHtmlElement(value: string, tagName: string): string {
  const lower = value.toLowerCase();
  const openPrefix = `<${tagName}`;
  const closePrefix = `</${tagName}`;
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    let openStart = lower.indexOf(openPrefix, cursor);
    while (
      openStart >= 0 &&
      ![' ', '\t', '\r', '\n', '>', '/'].includes(
        lower[openStart + openPrefix.length] || '',
      )
    ) {
      openStart = lower.indexOf(openPrefix, openStart + openPrefix.length);
    }
    if (openStart < 0) break;
    output += value.slice(cursor, openStart);
    const openEnd = findHtmlTagEnd(value, openStart + openPrefix.length);
    if (openEnd < 0) return output;

    let closeStart = lower.indexOf(closePrefix, openEnd + 1);
    while (
      closeStart >= 0 &&
      ![' ', '\t', '\r', '\n', '>'].includes(
        lower[closeStart + closePrefix.length] || '',
      )
    ) {
      closeStart = lower.indexOf(closePrefix, closeStart + closePrefix.length);
    }
    if (closeStart < 0) return output;
    const closeEnd = findHtmlTagEnd(value, closeStart + closePrefix.length);
    if (closeEnd < 0) return output;
    cursor = closeEnd + 1;
  }
  return output + value.slice(cursor);
}

function removeRawHtmlElements(value: string): string {
  return removeRawHtmlElement(removeRawHtmlElement(value, 'script'), 'style');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
  return parseBraveSearchResponse(await response.json());
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
  return parseTavilySearchResponse(await response.json()).map(
    ({ rawContent, ...result }) =>
      rawContent
        ? {
            ...result,
            fetchedExcerpt: collapseWhitespace(rawContent).slice(
              0,
              SECOND_OPINION_FETCH_EXCERPT_LIMIT,
            ),
          }
        : result,
  );
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
  const withoutScripts = removeRawHtmlElements(value);
  return collapseWhitespace(stripTags(withoutScripts)).slice(
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
    .map((query) => collapseWhitespace(query).slice(0, 500))
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
