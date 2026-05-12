import { isIP } from 'node:net';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
