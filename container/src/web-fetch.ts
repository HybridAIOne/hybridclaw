/**
 * web-fetch tool — fetch a URL and extract readable content.
 *
 * Ported from OpenClaw's web-fetch but stripped down:
 * - No Firecrawl fallback
 * - No SSRF guard framework (container is sandboxed, basic URL validation suffices)
 * - No external-content wrapping
 * - No config system — sensible hardcoded defaults
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 50_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 15 * 60_000; // 15 min
const CACHE_MAX_ENTRIES = 100;
const READABILITY_MAX_HTML_CHARS = 1_000_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: WebFetchResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function readCache(key: string): WebFetchResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: WebFetchResult): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// HTML helpers (inlined from OpenClaw's web-fetch-utils)
// ---------------------------------------------------------------------------

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Links
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `[${label}](${href})` : href;
  });

  // Headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = '#'.repeat(Math.max(1, Math.min(6, parseInt(level, 10))));
    return `\n${prefix} ${normalizeWhitespace(stripTags(body))}\n`;
  });

  // List items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : '';
  });

  // Block breaks
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, '\n');

  text = stripTags(text);
  text = normalizeWhitespace(text);
  return { text, title };
}

function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '');
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1');
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''),
  );
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  return normalizeWhitespace(text);
}

// ---------------------------------------------------------------------------
// Readability extraction (lazy-loaded)
// ---------------------------------------------------------------------------

let readabilityDeps: Promise<{
  Readability: typeof import('@mozilla/readability').Readability;
  parseHTML: typeof import('linkedom').parseHTML;
}> | undefined;

function loadReadabilityDeps() {
  if (!readabilityDeps) {
    readabilityDeps = Promise.all([
      import('@mozilla/readability'),
      import('linkedom'),
    ]).then(([r, l]) => ({ Readability: r.Readability, parseHTML: l.parseHTML }));
  }
  return readabilityDeps;
}

async function extractReadableContent(
  html: string,
  url: string,
  extractMode: 'markdown' | 'text',
): Promise<{ text: string; title?: string }> {
  // Fallback: simple regex-based conversion
  const fallback = (): { text: string; title?: string } => {
    const rendered = htmlToMarkdown(html);
    if (extractMode === 'text') {
      return { text: markdownToText(rendered.text), title: rendered.title };
    }
    return rendered;
  };

  if (html.length > READABILITY_MAX_HTML_CHARS) {
    return fallback();
  }

  try {
    const { Readability, parseHTML } = await loadReadabilityDeps();
    const { document } = parseHTML(html);
    try {
      (document as { baseURI?: string }).baseURI = url;
    } catch { /* best-effort */ }

    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) return fallback();

    const title = parsed.title || undefined;
    if (extractMode === 'text') {
      const text = normalizeWhitespace(parsed.textContent ?? '');
      return text ? { text, title } : fallback();
    }
    const rendered = htmlToMarkdown(parsed.content);
    return { text: rendered.text, title: title ?? rendered.title };
  } catch {
    return fallback();
  }
}

// ---------------------------------------------------------------------------
// Streaming response reader with size limit
// ---------------------------------------------------------------------------

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
          if (remaining <= 0) { truncated = true; break; }
          chunk = chunk.subarray(0, remaining);
          truncated = true;
        }

        bytesRead += chunk.byteLength;
        parts.push(decoder.decode(chunk, { stream: true }));
        if (truncated || bytesRead >= maxBytes) { truncated = true; break; }
      }
    } catch { /* return what we have */ } finally {
      if (truncated) {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    }

    parts.push(decoder.decode());
    return { text: parts.join(''), truncated };
  }

  const text = await res.text();
  return { text, truncated: false };
}

// ---------------------------------------------------------------------------
// Manual redirect following (to track finalUrl)
// ---------------------------------------------------------------------------

async function fetchWithRedirects(
  url: string,
  maxRedirects: number,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        Accept: 'text/markdown, text/html;q=0.9, */*;q=0.1',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal,
    });

    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return { response: res, finalUrl: currentUrl };
  }
  throw new Error(`Too many redirects (max ${maxRedirects})`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;
  extractMode: string;
  extractor: string;
  truncated: boolean;
  length: number;
  fetchedAt: string;
  tookMs: number;
  text: string;
  cached?: boolean;
  warning?: string;
}

export async function webFetch(params: {
  url: string;
  extractMode?: 'markdown' | 'text';
  maxChars?: number;
}): Promise<WebFetchResult> {
  const extractMode = params.extractMode ?? 'markdown';
  const maxChars = Math.max(100, Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS));

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error('Invalid URL: must be http or https');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Invalid URL: must be http or https');
  }

  // Check cache
  const cacheKey = `fetch:${params.url}:${extractMode}:${maxChars}`.toLowerCase();
  const cached = readCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { response: res, finalUrl } = await fetchWithRedirects(
      params.url,
      MAX_REDIRECTS,
      controller.signal,
    );

    if (!res.ok) {
      throw new Error(`Web fetch failed (${res.status}): ${res.statusText}`);
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const normalizedContentType = contentType.split(';')[0]?.trim() || 'application/octet-stream';
    const bodyResult = await readResponseText(res, MAX_RESPONSE_BYTES);
    const body = bodyResult.text;

    let title: string | undefined;
    let extractor = 'raw';
    let text = body;

    if (contentType.includes('text/markdown')) {
      extractor = 'cf-markdown';
      if (extractMode === 'text') text = markdownToText(body);
    } else if (contentType.includes('text/html')) {
      const readable = await extractReadableContent(body, finalUrl, extractMode);
      text = readable.text;
      title = readable.title;
      extractor = 'readability';
    } else if (contentType.includes('application/json')) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
        extractor = 'json';
      } catch {
        extractor = 'raw';
      }
    }

    // Truncate
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);

    const warning = bodyResult.truncated
      ? `Response body truncated after ${MAX_RESPONSE_BYTES} bytes.`
      : undefined;

    const result: WebFetchResult = {
      url: params.url,
      finalUrl,
      status: res.status,
      contentType: normalizedContentType,
      title,
      extractMode,
      extractor,
      truncated: truncated || bodyResult.truncated,
      length: text.length,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      text,
      warning,
    };

    writeCache(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
