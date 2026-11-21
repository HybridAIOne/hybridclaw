import {
  decodeEntities,
  parseBraveSearchResponse,
  parseDuckDuckGoHtml,
  parsePerplexitySearchResponse,
  parseSearxngSearchResponse,
  parseTavilySearchResponse,
  type SearchResult,
  stripTags,
} from '@hybridclaw/shared/provider-wire/web-search-parsers';
import { describe, expect, it } from 'vitest';

type JsonParser = (payload: unknown) => SearchResult[];

const JSON_PARSERS: Array<[string, JsonParser]> = [
  ['Brave', parseBraveSearchResponse],
  ['Perplexity', parsePerplexitySearchResponse],
  ['Tavily', parseTavilySearchResponse],
  ['SearXNG', parseSearxngSearchResponse],
];

describe('JSON search response parsers', () => {
  it.each<[string, JsonParser, unknown, SearchResult[]]>([
    [
      'Brave',
      parseBraveSearchResponse,
      {
        web: {
          results: [
            {
              title: 'Brave Result',
              url: 'https://example.com/brave',
              description: 'Brave snippet',
              page_age: '2 days ago',
            },
          ],
        },
      },
      [
        {
          title: 'Brave Result',
          url: 'https://example.com/brave',
          snippet: 'Brave snippet',
          age: '2 days ago',
        },
      ],
    ],
    [
      'Perplexity',
      parsePerplexitySearchResponse,
      {
        search_results: [
          {
            name: 'Perplexity Result',
            url: 'https://example.com/perplexity',
            content: 'Perplexity snippet',
            last_updated: '2026-01-02',
          },
        ],
      },
      [
        {
          title: 'Perplexity Result',
          url: 'https://example.com/perplexity',
          snippet: 'Perplexity snippet',
          age: '2026-01-02',
        },
      ],
    ],
    [
      'Tavily',
      parseTavilySearchResponse,
      {
        results: [
          {
            title: 'Tavily Result',
            url: 'https://example.com/tavily',
            content: 'Tavily snippet',
            published_date: '2026-03-04',
            raw_content: '  Full   page\n\n\n\nbody  ',
          },
          {
            title: 'Tavily Without Raw',
            url: 'https://example.com/tavily-2',
            description: 'Description fallback',
          },
        ],
      },
      [
        {
          title: 'Tavily Result',
          url: 'https://example.com/tavily',
          snippet: 'Tavily snippet',
          age: '2026-03-04',
          rawContent: 'Full page\n\nbody',
        },
        {
          title: 'Tavily Without Raw',
          url: 'https://example.com/tavily-2',
          snippet: 'Description fallback',
        },
      ],
    ],
    [
      'SearXNG',
      parseSearxngSearchResponse,
      {
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
        ],
      },
      [
        {
          title: 'SearXNG Result',
          url: 'https://example.com/search',
          snippet: 'Sovereign & private',
          age: '2026-05-01',
          category: 'general',
          engine: 'brave',
          thumbnail: 'https://example.com/thumb.jpg',
        },
      ],
    ],
  ])('parses %s results', (_name, parse, payload, expected) => {
    expect(parse(payload)).toEqual(expected);
  });

  it.each<[string, JsonParser, unknown]>([
    ['Brave', parseBraveSearchResponse, { web: {} }],
    ['Brave', parseBraveSearchResponse, { web: { results: 'nope' } }],
    ['Perplexity', parsePerplexitySearchResponse, {}],
    ['Tavily', parseTavilySearchResponse, { results: null }],
    ['SearXNG', parseSearxngSearchResponse, { results: {} }],
  ])('returns [] for a %s payload without a result list', (_n, parse, p) => {
    expect(parse(p)).toEqual([]);
  });

  it.each(
    JSON_PARSERS.flatMap(([name, parse]) =>
      ['bad-payload', null, 42, ['array']].map(
        (payload) => [name, parse, payload] as const,
      ),
    ),
  )('rejects a non-object %s payload (%#)', (name, parse, payload) => {
    expect(() => parse(payload)).toThrow(`Invalid ${name} search response`);
  });

  it.each(JSON_PARSERS)(
    'drops %s entries without a title, with a non-http URL, or with a duplicate URL',
    (_name, parse) => {
      const entries = [
        { title: 'Kept', url: 'https://example.com/a', content: 'x' },
        { title: 'Duplicate', url: 'https://EXAMPLE.com/a', content: 'x' },
        { title: '', url: 'https://example.com/b' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Missing URL' },
        'not-an-entry',
        7,
      ];
      const payload =
        parse === parseBraveSearchResponse
          ? { web: { results: entries } }
          : { results: entries };
      expect(parse(payload).map((result) => result.title)).toEqual(['Kept']);
    },
  );
});

describe('parseDuckDuckGoHtml', () => {
  it.each<[string, string, SearchResult[]]>([
    [
      'direct and uddg-redirect links',
      `
        <div class="result">
          <a class="result__a" href="https://example.com/alpha">Alpha Result</a>
          <div class="result__snippet">Alpha snippet</div>
        </div>
        <div class="result">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta">Beta <b>Result</b></a>
          <a class="result__snippet">Beta &amp; snippet</a>
        </div>
      `,
      [
        {
          title: 'Alpha Result',
          url: 'https://example.com/alpha',
          snippet: 'Alpha snippet',
        },
        {
          title: 'Beta Result',
          url: 'https://example.com/beta',
          snippet: 'Beta & snippet',
        },
      ],
    ],
    [
      'protocol-relative and root-relative redirect links',
      `
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=x">One</a>
        <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Two</a>
      `,
      [
        { title: 'One', url: 'https://example.com/one', snippet: '' },
        { title: 'Two', url: 'https://example.com/two', snippet: '' },
      ],
    ],
    [
      'duplicate, untitled and non-http links',
      `
        <a class="result__a" href="https://example.com/x">Kept</a>
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">Duplicate</a>
        <a class="result__a" href="https://example.com/y">   </a>
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Script</a>
      `,
      [{ title: 'Kept', url: 'https://example.com/x', snippet: '' }],
    ],
    ['a page without result rows', '<html><body>No hits</body></html>', []],
    ['an empty document', '', []],
  ])('handles %s', (_name, html, expected) => {
    expect(parseDuckDuckGoHtml(html)).toEqual(expected);
  });
});

describe('HTML text helpers', () => {
  it.each([
    ['&amp;lt;script&amp;gt;', '&lt;script&gt;'],
    ['A&nbsp;B &quot;C&quot; &#x41; &#65; &#39;', `A B "C" A A '`],
    ['&unknown; stays', '&unknown; stays'],
  ])('decodes %j in exactly one pass', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it('strips nested tag-like input without leaving an active tag', () => {
    const stripped = stripTags('<script<script>>alert(1)</script >safe');
    expect(stripped).not.toContain('<script');
    expect(stripped).toContain('safe');
  });
});
