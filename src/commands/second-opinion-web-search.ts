import {
  TAVILY_API_KEY,
  WEB_SEARCH_TAVILY_SEARCH_DEPTH,
} from '../config/config.js';

export interface SecondOpinionWebSearchResult {
  title: string;
  url: string;
  snippet: string;
  fetchedExcerpt?: string;
}

export interface SecondOpinionWebSearchEvidence {
  provider: 'tavily';
  queries: string[];
  results: SecondOpinionWebSearchResult[];
}

const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const SECOND_OPINION_SEARCH_TIMEOUT_MS = 30_000;
const SECOND_OPINION_SEARCH_RESULT_LIMIT = 10;
const SECOND_OPINION_FETCH_EXCERPT_LIMIT = 1200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function normalizeTavilyResult(
  entry: unknown,
): SecondOpinionWebSearchResult | null {
  if (!isRecord(entry)) return null;
  const title = normalizeWhitespace(String(entry.title || ''));
  const url = normalizeUrl(entry.url);
  if (!title || !url) return null;
  const snippet = normalizeWhitespace(
    String(entry.content || entry.snippet || ''),
  );
  const rawContent = normalizeWhitespace(String(entry.raw_content || ''));
  return {
    title,
    url,
    snippet,
    ...(rawContent
      ? {
          fetchedExcerpt: rawContent.slice(
            0,
            SECOND_OPINION_FETCH_EXCERPT_LIMIT,
          ),
        }
      : {}),
  };
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

async function searchTavily(
  query: string,
): Promise<SecondOpinionWebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SECOND_OPINION_SEARCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTavilyBody(query)),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Tavily search failed with HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { results?: unknown[] };
    return (Array.isArray(payload.results) ? payload.results : [])
      .map(normalizeTavilyResult)
      .filter((entry): entry is SecondOpinionWebSearchResult => entry !== null);
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSecondOpinionWebSearch(params: {
  queries: string[];
}): Promise<SecondOpinionWebSearchEvidence> {
  if (!TAVILY_API_KEY.trim()) {
    throw new Error(
      'Second opinion web fact-check requires `TAVILY_API_KEY` so search/fetch evidence comes from a structured provider.',
    );
  }
  const queries = params.queries
    .map((query) => normalizeWhitespace(query).slice(0, 500))
    .filter(Boolean)
    .slice(0, 5);
  if (queries.length === 0) {
    throw new Error(
      'Second opinion web fact-check requires model-generated search queries.',
    );
  }

  const seenUrls = new Set<string>();
  const results: SecondOpinionWebSearchResult[] = [];
  for (const query of queries) {
    for (const result of await searchTavily(query)) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      results.push(result);
      if (results.length >= SECOND_OPINION_SEARCH_RESULT_LIMIT) {
        return { provider: 'tavily', queries, results };
      }
    }
  }
  return { provider: 'tavily', queries, results };
}
