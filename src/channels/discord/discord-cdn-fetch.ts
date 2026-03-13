import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import net from 'node:net';
import { URL } from 'node:url';

export const DISCORD_CDN_HOST_PATTERNS: RegExp[] = [
  /^cdn\.discordapp\.com$/i,
  /^media\.discordapp\.net$/i,
  /^cdn\.discordapp\.net$/i,
  /^images-ext-\d+\.discordapp\.net$/i,
];

interface DiscordCdnFetchOptions {
  timeoutMs?: number;
  maxBytes?: number | null;
}

export interface DiscordCdnFetchResult {
  body: Buffer;
  contentLength: number | null;
  contentType: string | null;
  url: string;
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
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : false;
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateHostLabel(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  return net.isIP(normalized) > 0 ? isPrivateIp(normalized) : false;
}

function toHeaderString(
  headers: IncomingHttpHeaders,
  headerName: string,
): string | null {
  const value = headers[headerName.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] || null;
  return null;
}

function parseContentLength(headers: IncomingHttpHeaders): number | null {
  const raw = toHeaderString(headers, 'content-length');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function lookupPublicHostAddresses(
  hostname: string,
  family: 0 | 4 | 6 = 0,
): Promise<LookupAddress[]> {
  const normalized = hostname.trim().toLowerCase();
  if (isPrivateHostLabel(normalized)) {
    throw new Error(`ssrf_blocked_host:${normalized}`);
  }

  const resolved = await lookup(normalized, {
    all: true,
    verbatim: true,
    ...(family === 4 || family === 6 ? { family } : {}),
  });
  if (resolved.length === 0) {
    throw new Error(`dns_lookup_failed:${normalized}`);
  }
  if (resolved.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(`ssrf_blocked_host:${normalized}`);
  }
  return resolved;
}

function createSsrfGuardedLookup(): LookupFunction {
  return (hostname, options, callback) => {
    const family =
      options.family === 4 || options.family === 6 ? options.family : 0;
    void lookupPublicHostAddresses(hostname, family)
      .then((resolved) => {
        if (options.all) {
          callback(null, resolved, resolved[0]?.family);
          return;
        }
        const first = resolved[0];
        callback(null, first.address, first.family);
      })
      .catch((error) => {
        callback(
          error instanceof Error ? (error as NodeJS.ErrnoException) : null,
          '',
          undefined,
        );
      });
  };
}

function parseDiscordCdnUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid_url:${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`blocked_url:${rawUrl}`);
  }
  if (
    !DISCORD_CDN_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))
  ) {
    throw new Error(`blocked_url:${rawUrl}`);
  }
  return parsed;
}

export function isSafeDiscordCdnUrl(raw: string): boolean {
  try {
    parseDiscordCdnUrl(raw);
    return true;
  } catch {
    return false;
  }
}

export async function fetchDiscordCdnBuffer(
  rawUrl: string,
  options: DiscordCdnFetchOptions = {},
): Promise<DiscordCdnFetchResult> {
  const parsed = parseDiscordCdnUrl(rawUrl);
  await lookupPublicHostAddresses(parsed.hostname);

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 12_000));
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
      ? Math.max(1, Math.floor(options.maxBytes))
      : null;

  return await new Promise<DiscordCdnFetchResult>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (result: DiscordCdnFetchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const request = https.request(
      parsed,
      {
        lookup: createSsrfGuardedLookup(),
        method: 'GET',
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          rejectOnce(new Error(`http_${statusCode}`));
          return;
        }

        const contentLength = parseContentLength(response.headers);
        if (
          maxBytes !== null &&
          contentLength !== null &&
          contentLength > maxBytes
        ) {
          response.resume();
          rejectOnce(new Error(`too_large_header:${contentLength}`));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        response.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (maxBytes !== null && totalBytes > maxBytes) {
            response.destroy(new Error(`too_large_body:${totalBytes}`));
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', rejectOnce);
        response.on('end', () => {
          resolveOnce({
            body: Buffer.concat(chunks),
            contentLength,
            contentType: toHeaderString(response.headers, 'content-type'),
            url: parsed.toString(),
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', rejectOnce);
    request.end();
  });
}

export async function fetchDiscordCdnText(
  rawUrl: string,
  options: {
    maxChars: number;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<string> {
  const result = await fetchDiscordCdnBuffer(rawUrl, {
    maxBytes: options.maxBytes ?? Math.max(65_536, options.maxChars * 4),
    timeoutMs: options.timeoutMs,
  });
  const text = result.body.toString('utf8');
  if (text.length <= options.maxChars) return text;
  return `${text.slice(0, Math.max(1_000, options.maxChars - 32))}\n...[truncated]`;
}
