import { isIP } from 'node:net';

import { fetchPublicHttps } from '../security/public-https-fetch.js';

export { isRecord } from '../utils/type-guards.js';

export const A2A_TRANSPORT_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export function normalizeTransportString(transport: string): string {
  return transport.trim().toLowerCase();
}

export function normalizePositiveInteger(
  value: unknown,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  const [firstOctet] = normalized.split('.');
  return firstOctet === '127';
}

export function isA2AAllowedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
}

export function isA2ALoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

export interface A2APeerRequestInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

// Loopback peers (several local instances) are dialed directly; any other
// peer URL must resolve to a public address and never redirects.
export function fetchA2APeer(
  url: string,
  init: A2APeerRequestInit,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  if (fetchImpl || isA2ALoopbackHttpUrl(url)) {
    return (fetchImpl ?? fetch)(url, { ...init, redirect: 'error' });
  }
  return fetchPublicHttps(url, init);
}
