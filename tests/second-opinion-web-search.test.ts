import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
});

function mockWebSearchConfig(params: {
  provider?: string;
  fallbackProviders?: string[];
  braveApiKey?: string;
  tavilyApiKey?: string;
}) {
  vi.doMock('../src/config/config.js', () => ({
    BRAVE_API_KEY: params.braveApiKey ?? '',
    TAVILY_API_KEY: params.tavilyApiKey ?? '',
    WEB_SEARCH_PROVIDER: params.provider ?? 'auto',
    WEB_SEARCH_FALLBACK_PROVIDERS: params.fallbackProviders ?? [],
    WEB_SEARCH_TAVILY_SEARCH_DEPTH: 'advanced',
  }));
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

test('second-opinion web search uses Brave when configured without Tavily', async () => {
  mockWebSearchConfig({ braveApiKey: 'brave-key' });
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith('https://api.search.brave.com/')) {
        expect(init?.headers).toMatchObject({
          'X-Subscription-Token': 'brave-key',
        });
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: 'Brave Source',
                  url: 'https://example.com/brave',
                  description: 'Brave snippet',
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === 'https://example.com/brave') {
        return new Response(
          '<html><body><script >malicious()</script ><style >hidden</style ><main>Fetched Brave evidence body.</main></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { runSecondOpinionWebSearch } = await import(
    '../src/commands/second-opinion-web-search.ts'
  );
  const evidence = await runSecondOpinionWebSearch({
    queries: ['brave query'],
  });

  expect(evidence.provider).toBe('brave');
  expect(evidence.results).toEqual([
    {
      title: 'Brave Source',
      url: 'https://example.com/brave',
      snippet: 'Brave snippet',
      fetchedExcerpt: 'Fetched Brave evidence body.',
    },
  ]);
});

test('second-opinion web search falls back to DuckDuckGo with no search API keys', async () => {
  mockWebSearchConfig({});
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.startsWith('https://html.duckduckgo.com/html/')) {
      return new Response(
        `
        <html><body>
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fduck">Duck Source</a>
          <a class="result__snippet">Duck snippet</a>
        </body></html>
        `,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }
    if (url === 'https://example.com/duck') {
      return new Response(
        '<html><body><article>Fetched DuckDuckGo evidence body.</article></body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { runSecondOpinionWebSearch } = await import(
    '../src/commands/second-opinion-web-search.ts'
  );
  const evidence = await runSecondOpinionWebSearch({
    queries: ['duck query'],
  });

  expect(evidence.provider).toBe('duckduckgo');
  expect(evidence.results).toEqual([
    {
      title: 'Duck Source',
      url: 'https://example.com/duck',
      snippet: 'Duck snippet',
      fetchedExcerpt: 'Fetched DuckDuckGo evidence body.',
    },
  ]);
});

test('second-opinion web search uses Tavily raw content as the fetched excerpt', async () => {
  mockWebSearchConfig({ tavilyApiKey: 'tavily-key', provider: 'tavily' });
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === 'https://api.tavily.com/search') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          query: 'tavily query',
          include_raw_content: true,
        });
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Tavily Source',
                url: 'https://example.com/tavily',
                content: 'Tavily snippet',
                raw_content: 'Raw\n\nTavily   evidence body.',
              },
              {
                title: 'Long Tavily Source',
                url: 'https://example.com/tavily-long',
                content: 'Long snippet',
                raw_content: `Long\n\n${'x'.repeat(3000)}`,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { runSecondOpinionWebSearch } = await import(
    '../src/commands/second-opinion-web-search.ts'
  );
  const evidence = await runSecondOpinionWebSearch({
    queries: ['tavily query'],
  });

  expect(evidence.provider).toBe('tavily');
  expect(evidence.results).toEqual([
    {
      title: 'Tavily Source',
      url: 'https://example.com/tavily',
      snippet: 'Tavily snippet',
      fetchedExcerpt: 'Raw Tavily evidence body.',
    },
    {
      title: 'Long Tavily Source',
      url: 'https://example.com/tavily-long',
      snippet: 'Long snippet',
      fetchedExcerpt: `Long ${'x'.repeat(1195)}`,
    },
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
