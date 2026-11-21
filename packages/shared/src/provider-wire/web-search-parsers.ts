/**
 * Web-search result codec: provider endpoints and payload → `SearchResult[]`
 * parsers shared by the container `web_search` tool and the gateway
 * second-opinion fact-check, so both read provider responses the same way.
 *
 * Every parser returns titled, http(s)-only, URL-deduplicated results and
 * throws on a payload that is not an object. Pure: no fetch, timeouts,
 * private-network guard, credentials, config or logging; those stay with
 * each caller's transport.
 */
import { isRecord } from '../primitive-values.ts';

export const BRAVE_SEARCH_ENDPOINT =
  'https://api.search.brave.com/res/v1/web/search';
export const PERPLEXITY_SEARCH_ENDPOINT = 'https://api.perplexity.ai/search';
export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
export const DUCKDUCKGO_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
  category?: string;
  engine?: string;
  thumbnail?: string;
  /** Tavily `raw_content`, present only when the request asked for it. */
  rawContent?: string;
}

export function decodeEntities(value: string): string {
  return value.replace(
    /&(nbsp|amp|quot|#39|lt|gt|#x([0-9a-f]+)|#(\d+));/gi,
    (
      entity,
      name: string,
      hex: string | undefined,
      dec: string | undefined,
    ) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (dec) return String.fromCharCode(Number.parseInt(dec, 10));
      switch (name.toLowerCase()) {
        case 'nbsp':
          return ' ';
        case 'amp':
          return '&';
        case 'quot':
          return '"';
        case '#39':
          return "'";
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        default:
          return entity;
      }
    },
  );
}

export function stripTags(value: string): string {
  let output = '';
  let inTag = false;
  let quote = '';
  for (const character of value) {
    if (!inTag) {
      if (character === '<') {
        inTag = true;
      } else {
        output += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      inTag = false;
    }
  }
  return decodeEntities(output);
}

export function normalizeWhitespace(value: string): string {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function validateHttpUrl(value: string): string | null {
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

export function normalizeResultUrl(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return validateHttpUrl(normalized);
}

export function dedupeResults<T extends { url: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const result of results) {
    const urlKey = result.url.toLowerCase();
    if (seen.has(urlKey)) continue;
    seen.add(urlKey);
    deduped.push(result);
  }
  return deduped;
}

function extractRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeSearchResults(
  results: Array<{
    title?: unknown;
    url?: unknown;
    snippet?: unknown;
    age?: unknown;
    rawContent?: unknown;
  }>,
): SearchResult[] {
  const normalized: SearchResult[] = [];
  for (const entry of results) {
    const title = normalizeWhitespace(String(entry.title || ''));
    const url = normalizeResultUrl(entry.url);
    if (!title || !url) continue;
    const snippet = normalizeWhitespace(String(entry.snippet || ''));
    const age = normalizeWhitespace(String(entry.age || ''));
    const rawContent = normalizeWhitespace(String(entry.rawContent || ''));
    normalized.push({
      title,
      url,
      snippet,
      ...(age ? { age } : {}),
      ...(rawContent ? { rawContent } : {}),
    });
  }
  return dedupeResults(normalized);
}

export function parseBraveSearchResponse(payload: unknown): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid Brave search response');
  const rawWeb = isRecord(payload.web) ? payload.web : {};
  return normalizeSearchResults(
    extractRecords(rawWeb.results).map((entry) => ({
      title: entry.title,
      url: entry.url,
      snippet: entry.description ?? entry.snippet,
      age: entry.age ?? entry.page_age ?? entry.pageAge,
    })),
  );
}

export function parsePerplexitySearchResponse(
  payload: unknown,
): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid Perplexity search response');
  return normalizeSearchResults(
    extractRecords(
      payload.results ?? payload.search_results ?? payload.data,
    ).map((entry) => ({
      title: entry.title ?? entry.name,
      url: entry.url,
      snippet: entry.snippet ?? entry.content ?? entry.description,
      age:
        entry.age ?? entry.date ?? entry.published_date ?? entry.last_updated,
    })),
  );
}

export function parseTavilySearchResponse(payload: unknown): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid Tavily search response');
  return normalizeSearchResults(
    extractRecords(payload.results).map((entry) => ({
      title: entry.title,
      url: entry.url,
      snippet: entry.content ?? entry.snippet ?? entry.description,
      age: entry.published_date,
      rawContent: entry.raw_content,
    })),
  );
}

function normalizeHtmlText(value: unknown): string {
  return normalizeWhitespace(stripTags(String(value || '')));
}

export function parseSearxngSearchResponse(payload: unknown): SearchResult[] {
  if (!isRecord(payload)) throw new Error('Invalid SearXNG search response');

  const results: SearchResult[] = [];
  for (const entry of extractRecords(payload.results)) {
    const title = normalizeHtmlText(entry.title);
    const url = normalizeResultUrl(entry.url);
    if (!title || !url) continue;

    const snippet = normalizeHtmlText(
      entry.content ?? entry.snippet ?? entry.description,
    );
    const age = normalizeHtmlText(
      entry.publishedDate ?? entry.published_date ?? entry.age,
    );
    const category = normalizeHtmlText(entry.category);
    const engine = normalizeHtmlText(entry.engine);
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
