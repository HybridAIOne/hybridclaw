/**
 * web-fetch tool — fetch a URL and extract readable content.
 *
 * Ported from OpenClaw's web-fetch but stripped down:
 * - No Firecrawl fallback
 * - No external-content wrapping
 * - No config system — sensible hardcoded defaults
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';

const DEFAULT_MAX_CHARS = 50_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
// One timeout budget covers SSRF DNS checks and fetches across the redirect
// chain, so DNS latency can add up before a response body is read.
const TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 15 * 60_000; // 15 min
const CACHE_MAX_ENTRIES = 100;
const READABILITY_MAX_HTML_CHARS = 1_000_000;
const ESCALATION_MIN_TEXT_CHARS = 200;
const ESCALATION_MIN_HTML_CHARS = 5_000;
const BOT_BLOCKED_PATTERNS = [
  'access denied',
  'bot detected',
  'captcha',
  'cf-chl-',
  'checking your browser',
  'cloudflare',
  'just a moment',
  'attention required',
  'verification required',
];
const JAVASCRIPT_REQUIRED_PATTERNS = [
  'enable javascript',
  'javascript required',
  'requires javascript',
  'turn on javascript',
];
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
export const BOT_USER_AGENT =
  'hybridclaw/1.0 (+https://github.com/hybridaione/hybridclaw; AI assistant bot)';

interface CacheEntry {
  value: WebFetchResult;
  expiresAt: number;
}

type HostBlockReason = 'private' | 'dns_failure';

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

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
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
  const title = titleMatch
    ? normalizeWhitespace(stripTags(titleMatch[1]))
    : undefined;

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Links
  text = text.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, body) => {
      const label = normalizeWhitespace(stripTags(body));
      return label ? `[${label}](${href})` : href;
    },
  );

  // Headings
  text = text.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, body) => {
      const prefix = '#'.repeat(Math.max(1, Math.min(6, parseInt(level, 10))));
      return `\n${prefix} ${normalizeWhitespace(stripTags(body))}\n`;
    },
  );

  // List items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : '';
  });

  // Block breaks
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(
      /<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi,
      '\n',
    );

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

let readabilityDeps:
  | Promise<{
      Readability: typeof import('@mozilla/readability').Readability;
      parseHTML: typeof import('linkedom').parseHTML;
    }>
  | undefined;

function loadReadabilityDeps() {
  if (!readabilityDeps) {
    readabilityDeps = Promise.all([
      import('@mozilla/readability'),
      import('linkedom'),
    ]).then(([r, l]) => ({
      Readability: r.Readability,
      parseHTML: l.parseHTML,
    }));
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
    } catch {
      /* best-effort */
    }

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
    } catch {
      /* return what we have */
    } finally {
      if (truncated) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      }
    }

    parts.push(decoder.decode());
    return { text: parts.join(''), truncated };
  }

  const text = await res.text();
  return { text, truncated: false };
}

async function fetchWithRedirects(
  url: string,
  maxRedirects: number,
  signal: AbortSignal,
  userAgent: string,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = (await assertFetchUrl(url)).toString();
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        Accept: 'text/markdown, text/html;q=0.9, */*;q=0.1',
        'User-Agent': userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal,
    });

    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      currentUrl = (
        await assertFetchUrl(new URL(location, currentUrl))
      ).toString();
      continue;
    }
    return { response: res, finalUrl: currentUrl };
  }
  throw new Error(`Too many redirects (max ${maxRedirects})`);
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function decodeIpv4MappedIpv6Tail(value: string): string | null {
  if (net.isIP(value) === 4) return value;

  const parts = value.split(':');
  if (parts.length !== 2) return null;

  const words = parts.map((part) => Number.parseInt(part, 16));
  if (
    words.some(
      (word, index) =>
        !/^[0-9a-f]{1,4}$/i.test(parts[index] ?? '') ||
        Number.isNaN(word) ||
        word < 0 ||
        word > 0xffff,
    )
  ) {
    return null;
  }

  return [
    (words[0] >> 8) & 0xff,
    words[0] & 0xff,
    (words[1] >> 8) & 0xff,
    words[1] & 0xff,
  ].join('.');
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.split('%')[0] ?? '';
  if (lower === '::') return true;
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = decodeIpv4MappedIpv6Tail(lower.slice('::ffff:'.length));
    return mapped ? isPrivateIpv4(mapped) : false;
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  const normalized = normalizeHostname(ip);
  const version = net.isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) return isPrivateIpv6(normalized);
  return false;
}

async function getHostBlockReason(
  hostname: string,
): Promise<HostBlockReason | null> {
  const host = normalizeHostname(hostname);
  if (!host) return 'private';
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return 'private';
  }
  if (net.isIP(host) > 0) return isPrivateIp(host) ? 'private' : null;

  try {
    // This pre-connection DNS check blocks obvious private targets, but it is
    // not a complete DNS rebinding defense. Keep container/network egress
    // controls in place for defense in depth.
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0) return 'dns_failure';
    return resolved.some((entry) => isPrivateIp(entry.address))
      ? 'private'
      : null;
  } catch {
    return 'dns_failure';
  }
}

async function assertFetchUrl(raw: string | URL): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new Error('Invalid URL: must be http or https');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Invalid URL: must be http or https');
  }
  const blockReason = await getHostBlockReason(parsedUrl.hostname);
  if (blockReason === 'dns_failure') {
    throw new Error(
      `Web fetch blocked by SSRF guard: DNS lookup failed for host (${parsedUrl.hostname}).`,
    );
  }
  if (blockReason === 'private') {
    throw new Error(
      `Web fetch blocked by SSRF guard: private or loopback host (${parsedUrl.hostname}).`,
    );
  }
  return parsedUrl;
}

function normalizeForDetection(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}

function isCloudflareChallenge(res: Response): boolean {
  return res.status === 403 && res.headers.get('cf-mitigated') === 'challenge';
}

function detectEscalationHint(params: {
  status: number;
  contentType: string;
  body: string;
  extractedText: string;
}): WebFetchEscalationHint | undefined {
  const normalizedBody = normalizeForDetection(params.body);
  if (
    params.status === 403 ||
    params.status === 429 ||
    includesAny(normalizedBody, BOT_BLOCKED_PATTERNS)
  ) {
    return 'bot_blocked';
  }

  const isHtml = params.contentType.toLowerCase().includes('text/html');
  if (!isHtml) return undefined;

  if (
    /<noscript[\s\S]{0,2000}javascript[\s\S]{0,2000}<\/noscript>/i.test(
      params.body,
    ) ||
    includesAny(normalizedBody, JAVASCRIPT_REQUIRED_PATTERNS)
  ) {
    return 'javascript_required';
  }

  if (
    /<div[^>]+id=["'](?:root|app|__next)["'][^>]*>\s*<\/div>/i.test(
      params.body,
    ) &&
    normalizeForDetection(params.extractedText).length <
      ESCALATION_MIN_TEXT_CHARS
  ) {
    return 'spa_shell_only';
  }

  const normalizedExtracted = normalizeForDetection(params.extractedText);
  if (normalizedExtracted.length === 0) {
    return 'empty_extraction';
  }

  if (
    normalizedExtracted.length < ESCALATION_MIN_TEXT_CHARS &&
    params.body.length > ESCALATION_MIN_HTML_CHARS
  ) {
    return 'boilerplate_only';
  }

  return undefined;
}

export type WebFetchEscalationHint =
  | 'javascript_required'
  | 'empty_extraction'
  | 'spa_shell_only'
  | 'bot_blocked'
  | 'boilerplate_only';

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
  escalationHint?: WebFetchEscalationHint;
}

export async function webFetch(params: {
  url: string;
  extractMode?: 'markdown' | 'text';
  maxChars?: number;
}): Promise<WebFetchResult> {
  const extractMode = params.extractMode ?? 'markdown';
  const maxChars = Math.max(
    100,
    Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS),
  );

  // Check cache
  const cacheKey =
    `fetch:${params.url}:${extractMode}:${maxChars}`.toLowerCase();
  const cached = readCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // The initial fetch and optional Cloudflare retry share one overall timeout
    // budget; we intentionally do not reset the timer per attempt.
    const doFetch = (userAgent: string) =>
      fetchWithRedirects(
        params.url,
        MAX_REDIRECTS,
        controller.signal,
        userAgent,
      );

    let { response: res, finalUrl } = await doFetch(BROWSER_USER_AGENT);
    if (isCloudflareChallenge(res)) {
      void res.body?.cancel().catch(() => {});
      ({ response: res, finalUrl } = await doFetch(BOT_USER_AGENT));
    }

    const contentType =
      res.headers.get('content-type') ?? 'application/octet-stream';
    const normalizedContentType =
      contentType.split(';')[0]?.trim() || 'application/octet-stream';
    const bodyResult = await readResponseText(res, MAX_RESPONSE_BYTES);
    const body = bodyResult.text;

    let title: string | undefined;
    let extractor = 'raw';
    let text = body;

    if (contentType.includes('text/markdown')) {
      extractor = 'cf-markdown';
      if (extractMode === 'text') text = markdownToText(body);
    } else if (contentType.includes('text/html')) {
      const readable = await extractReadableContent(
        body,
        finalUrl,
        extractMode,
      );
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

    const extractedText = extractMode === 'text' ? text : markdownToText(text);
    const escalationHint = detectEscalationHint({
      status: res.status,
      contentType: normalizedContentType,
      body,
      extractedText,
    });

    if (!res.ok && !escalationHint) {
      throw new Error(`Web fetch failed (${res.status}): ${res.statusText}`);
    }

    // Truncate
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);

    const warnings: string[] = [];
    if (!res.ok) warnings.push(`HTTP ${res.status} ${res.statusText}.`);
    if (bodyResult.truncated)
      warnings.push(
        `Response body truncated after ${MAX_RESPONSE_BYTES} bytes.`,
      );
    const warning = warnings.length > 0 ? warnings.join(' ') : undefined;

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
      escalationHint,
    };

    writeCache(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
