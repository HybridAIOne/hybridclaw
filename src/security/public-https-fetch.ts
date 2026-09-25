/**
 * SSRF-guarded HTTPS GET for gateway fetches of URLs that came from a model,
 * a user, or a provider response. Every DNS answer, including the connect-time
 * lookup, must be public, so a rebinding host cannot slip through.
 *
 * NOT a host allowlist: callers that accept only certain hosts (Discord CDN)
 * check the URL first and then call this.
 */
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { URL } from 'node:url';

import { isPrivateNetworkAddress } from '../../container/shared/private-network.js';

export interface PublicHttpsFetchOptions {
  timeoutMs?: number;
  readIdleTimeoutMs?: number;
  maxBytes?: number | null;
}

export interface PublicHttpsFetchResult {
  body: Buffer;
  contentLength: number | null;
  contentType: string | null;
  url: string;
}

// URL.hostname keeps the brackets around IPv6 literals.
function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
}

function isPrivateHostLabel(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return true;
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  return isPrivateNetworkAddress(normalized);
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
  const normalized = normalizeHostname(hostname);
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
  if (resolved.some((entry) => isPrivateNetworkAddress(entry.address))) {
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

function parsePublicHttpsUrl(rawUrl: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error(`invalid_url:${String(rawUrl)}`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`blocked_url:${parsed.origin}`);
  }
  return parsed;
}

export async function fetchPublicHttpsBuffer(
  rawUrl: string | URL,
  options: PublicHttpsFetchOptions = {},
): Promise<PublicHttpsFetchResult> {
  const parsed = parsePublicHttpsUrl(rawUrl);
  await lookupPublicHostAddresses(parsed.hostname);

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 12_000));
  const readIdleTimeoutMs = Math.max(
    1,
    Math.floor(options.readIdleTimeoutMs ?? timeoutMs),
  );
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
      ? Math.max(1, Math.floor(options.maxBytes))
      : null;

  return await new Promise<PublicHttpsFetchResult>((resolve, reject) => {
    let settled = false;
    let readIdleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReadIdleTimeout = () => {
      if (readIdleTimer === null) return;
      clearTimeout(readIdleTimer);
      readIdleTimer = null;
    };

    const resolveOnce = (result: PublicHttpsFetchResult) => {
      if (settled) return;
      settled = true;
      clearReadIdleTimeout();
      resolve(result);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearReadIdleTimeout();
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
        const armReadIdleTimeout = () => {
          clearReadIdleTimeout();
          readIdleTimer = setTimeout(() => {
            readIdleTimer = null;
            response.destroy(new Error('read_idle_timeout'));
          }, readIdleTimeoutMs);
        };

        armReadIdleTimeout();
        response.on('data', (chunk) => {
          armReadIdleTimeout();
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (maxBytes !== null && totalBytes > maxBytes) {
            response.destroy(new Error(`too_large_body:${totalBytes}`));
            return;
          }
          chunks.push(buffer);
        });
        response.on('close', () => {
          clearReadIdleTimeout();
          rejectOnce(new Error('response_closed_prematurely'));
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
      clearReadIdleTimeout();
      request.destroy(new Error('timeout'));
    });
    request.on('close', clearReadIdleTimeout);
    request.on('error', rejectOnce);
    request.end();
  });
}
