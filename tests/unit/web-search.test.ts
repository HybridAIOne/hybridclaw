import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSearxngSearchUrl,
  parseSearxngSearchResponse,
} from '../../container/src/searxng-client.js';
import {
  buildProviderChain,
  clearWebSearchCache,
  getWebSearchConfigFromEnv,
  mapFreshnessForProvider,
  normalizeSearchParams,
  parseBraveSearchResponse,
  parseDuckDuckGoHtml,
  searchWeb,
  type WebSearchConfig,
  type WebSearchParams,
} from '../../container/src/web-search.js';

const ORIGINAL_ENV = { ...process.env };

const DUCKDUCKGO_HTML = `
  <div class="result">
    <a class="result__a" href="https://example.com/alpha">Alpha Result</a>
    <div class="result__snippet">Alpha snippet</div>
  </div>
  <div class="result">
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta">Beta Result</a>
    <a class="result__snippet">Beta snippet</a>
  </div>
`;

function makeConfig(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return {
    provider: 'auto',
    fallbackProviders: [],
    defaultCount: 5,
    cacheTtlMinutes: 5,
    searxngBaseUrl: '',
    tavilySearchDepth: 'advanced',
    ...overrides,
  };
}

afterEach(() => {
  clearWebSearchCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe('web search params', () => {
  it('rejects a missing query', async () => {
    await expect(searchWeb({} as unknown as WebSearchParams)).rejects.toThrow(
      'Search query is required',
    );
  });

  it('rejects an empty query', async () => {
    await expect(searchWeb({ query: '   ' })).rejects.toThrow(
      'Search query cannot be empty',
    );
  });

  it('clamps count into the supported range', () => {
    expect(normalizeSearchParams({ query: 'x', count: 0 }).count).toBe(1);
    expect(normalizeSearchParams({ query: 'x', count: 100 }).count).toBe(10);
  });

  it('rejects an invalid provider name', () => {
    expect(() =>
      normalizeSearchParams({
        query: 'test',
        provider: 'invalid-provider' as never,
      }),
    ).toThrow('Invalid web search provider: invalid-provider');
  });

  it('accepts auto as an explicit per-call provider override', () => {
    expect(
      normalizeSearchParams({ query: 'test', provider: 'auto' }).provider,
    ).toBe('auto');
  });
});

describe('provider chain', () => {
  it('builds the auto chain from configured providers and ends with duckduckgo', () => {
    const chain = buildProviderChain(
      makeConfig({
        provider: 'auto',
        braveApiKey: 'brave-key',
        tavilyApiKey: 'tavily-key',
      }),
    );

    expect(chain.map((provider) => provider.name)).toEqual([
      'brave',
      'tavily',
      'duckduckgo',
    ]);
  });

  it('allows runtime config overrides to replace env-derived defaults', () => {
    process.env.HYBRIDCLAW_WEB_SEARCH_PROVIDER = 'duckduckgo';
    process.env.HYBRIDCLAW_WEB_SEARCH_DEFAULT_COUNT = '2';

    const config = getWebSearchConfigFromEnv({
      provider: 'auto',
      defaultCount: 7,
      fallbackProviders: ['brave'],
      cacheTtlMinutes: 9,
      searxngBaseUrl: 'https://search.example.com',
      tavilySearchDepth: 'basic',
      braveApiKey: 'brave-override',
      perplexityApiKey: 'perplexity-override',
      tavilyApiKey: 'tavily-override',
    });

    expect(config.provider).toBe('auto');
    expect(config.defaultCount).toBe(7);
    expect(config.fallbackProviders).toEqual(['brave']);
    expect(config.cacheTtlMinutes).toBe(9);
    expect(config.searxngBaseUrl).toBe('https://search.example.com');
    expect(config.tavilySearchDepth).toBe('basic');
    expect(config.braveApiKey).toBe('brave-override');
    expect(config.perplexityApiKey).toBe('perplexity-override');
    expect(config.tavilyApiKey).toBe('tavily-override');
  });
});

describe('provider parsers', () => {
  it('parses Brave JSON results', () => {
    const results = parseBraveSearchResponse({
      web: {
        results: [
          {
            title: 'Brave Result',
            url: 'https://example.com/brave',
            description: 'Brave snippet',
            age: '2 days ago',
          },
        ],
      },
    });

    expect(results).toEqual([
      {
        title: 'Brave Result',
        url: 'https://example.com/brave',
        snippet: 'Brave snippet',
        age: '2 days ago',
      },
    ]);
  });

  it('returns an empty list for Brave responses without results', () => {
    expect(parseBraveSearchResponse({ web: {} })).toEqual([]);
  });

  it('rejects malformed Brave responses', () => {
    expect(() => parseBraveSearchResponse('bad-payload')).toThrow(
      'Invalid Brave search response',
    );
  });

  it('parses DuckDuckGo HTML and unwraps uddg redirects', () => {
    const results = parseDuckDuckGoHtml(DUCKDUCKGO_HTML);

    expect(results).toEqual([
      {
        title: 'Alpha Result',
        url: 'https://example.com/alpha',
        snippet: 'Alpha snippet',
      },
      {
        title: 'Beta Result',
        url: 'https://example.com/beta',
        snippet: 'Beta snippet',
      },
    ]);
  });

  it('returns an empty list for DuckDuckGo HTML without result rows', () => {
    expect(parseDuckDuckGoHtml('<html><body>No hits</body></html>')).toEqual(
      [],
    );
  });

  it('builds SearXNG JSON search URLs with query options', () => {
    const url = new URL(
      buildSearxngSearchUrl({
        baseUrl: 'https://search.example.com/searxng/',
        query: 'sovereign search',
        categories: ['general', 'news', 'general'],
        engines: 'brave, duckduckgo, brave',
        language: 'de',
        page: 2,
        safeSearch: 1,
        timeRange: 'month',
      }),
    );

    expect(url.origin).toBe('https://search.example.com');
    expect(url.pathname).toBe('/searxng/search');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('q')).toBe('sovereign search');
    expect(url.searchParams.get('categories')).toBe('general,news');
    expect(url.searchParams.get('engines')).toBe('brave,duckduckgo');
    expect(url.searchParams.get('language')).toBe('de');
    expect(url.searchParams.get('pageno')).toBe('2');
    expect(url.searchParams.get('safesearch')).toBe('1');
    expect(url.searchParams.get('time_range')).toBe('month');
  });

  it('rejects SearXNG URLs without a query', () => {
    expect(() =>
      buildSearxngSearchUrl({
        baseUrl: 'https://search.example.com',
        query: '   ',
      }),
    ).toThrow('SearXNG query is required');
  });

  it('parses and normalizes SearXNG JSON results', () => {
    const results = parseSearxngSearchResponse({
      results: [
        {
          title: '<b>SearXNG Result</b>',
          url: 'https://example.com/search',
          content: 'Sovereign &amp; private',
          publishedDate: '2026-05-01',
          category: 'general',
          engine: 'brave',
          thumbnail: 'https://example.com/thumb.jpg',
        },
        {
          title: 'Duplicate Result',
          url: 'https://example.com/search',
          content: 'Duplicate URL should be dropped',
        },
        {
          title: 'Missing URL',
          content: 'ignored',
        },
      ],
    });

    expect(results).toEqual([
      {
        title: 'SearXNG Result',
        url: 'https://example.com/search',
        snippet: 'Sovereign & private',
        age: '2026-05-01',
        category: 'general',
        engine: 'brave',
        thumbnail: 'https://example.com/thumb.jpg',
      },
    ]);
  });

  it('rejects malformed SearXNG responses', () => {
    expect(() => parseSearxngSearchResponse('bad-payload')).toThrow(
      'Invalid SearXNG search response',
    );
  });
});

describe('SearXNG provider', () => {
  it('queries SearXNG JSON output with normalized options', async () => {
    process.env.HYBRIDCLAW_WEB_SEARCH_PROVIDER = 'searxng';
    process.env.SEARXNG_BASE_URL = 'https://search.example.com';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'SearXNG Result',
              url: 'https://example.com/searxng',
              content: 'SearXNG snippet',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchWeb({
      query: 'searxng adapter',
      count: 3,
      categories: 'images',
      engines: ['brave', 'duckduckgo'],
      freshness: 'year',
      language: 'en',
      provider: 'searxng',
    });

    expect(result.provider).toBe('searxng');
    expect(result.results).toEqual([
      {
        title: 'SearXNG Result',
        url: 'https://example.com/searxng',
        snippet: 'SearXNG snippet',
      },
    ]);

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe('/search');
    expect(requestUrl.searchParams.get('format')).toBe('json');
    expect(requestUrl.searchParams.get('q')).toBe('searxng adapter');
    expect(requestUrl.searchParams.get('categories')).toBe('images');
    expect(requestUrl.searchParams.get('engines')).toBe('brave,duckduckgo');
    expect(requestUrl.searchParams.get('language')).toBe('en');
    expect(requestUrl.searchParams.get('time_range')).toBe('year');
    expect(requestUrl.searchParams.has('results')).toBe(false);
  });

  it('uses canonical SearXNG category and engine lists for cache keys', async () => {
    process.env.HYBRIDCLAW_WEB_SEARCH_PROVIDER = 'searxng';
    process.env.SEARXNG_BASE_URL = 'https://search.example.com';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Cached Result',
              url: 'https://example.com/cached',
              content: 'Cached snippet',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await searchWeb({
      query: 'searxng cache',
      categories: ['general', 'news', 'general'],
      engines: 'brave, duckduckgo',
      provider: 'searxng',
    });
    const second = await searchWeb({
      query: 'searxng cache',
      categories: 'general,news',
      engines: ['brave', 'duckduckgo'],
      provider: 'searxng',
    });

    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('cache behavior', () => {
  it('uses the in-memory cache until the ttl expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T12:00:00.000Z'));
    process.env.HYBRIDCLAW_WEB_SEARCH_PROVIDER = 'duckduckgo';
    process.env.HYBRIDCLAW_WEB_SEARCH_CACHE_TTL_MINUTES = '5';

    const fetchMock = vi.fn(async () => {
      return new Response(DUCKDUCKGO_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await searchWeb({ query: 'cache me', count: 2 });
    const second = await searchWeb({ query: 'cache me', count: 2 });

    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-03-06T12:06:00.000Z'));
    const third = await searchWeb({ query: 'cache me', count: 2 });

    expect(third.cached).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('freshness normalization', () => {
  it('maps freshness values across providers', () => {
    expect(mapFreshnessForProvider('brave', 'day')).toBe('pd');
    expect(mapFreshnessForProvider('perplexity', 'week')).toBe('week');
    expect(mapFreshnessForProvider('tavily', 'month')).toBe(30);
    expect(mapFreshnessForProvider('searxng', 'year')).toBe('year');
    expect(mapFreshnessForProvider('duckduckgo', 'day')).toBeUndefined();
  });
});
