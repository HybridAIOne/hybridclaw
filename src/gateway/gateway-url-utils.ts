import type { IncomingMessage } from 'node:http';

export function normalizeHttpBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

export function normalizeHttpOrigin(value: unknown): string | undefined {
  const baseUrl = normalizeHttpBaseUrl(value);
  if (!baseUrl) return undefined;
  return new URL(baseUrl).origin;
}

/**
 * Whether the request reached us over HTTPS, honoring the `X-Forwarded-Proto`
 * header set by TLS-terminating proxies/tunnels (e.g. ngrok) before falling
 * back to the socket's own encryption state.
 */
export function requestUsesHttps(req: IncomingMessage): boolean {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto) return forwardedProto === 'https';
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

/**
 * Reconstruct the public origin a request arrived on, honoring the
 * `X-Forwarded-Host`/`X-Forwarded-Proto` headers a TLS-terminating tunnel adds.
 * This mirrors how the Agent Card advertises its own origin so that inbound
 * audience checks agree with the URL senders sign against.
 */
export function resolveForwardedRequestOrigin(
  req: IncomingMessage,
  fallbackHost = '127.0.0.1',
): string {
  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    ?.trim();
  const proto = requestUsesHttps(req) ? 'https' : 'http';
  const host = forwardedHost || req.headers.host || fallbackHost;
  return `${proto}://${host}`;
}

export function isPrivateHttpBaseUrl(value: string): boolean {
  let hostname = '';
  try {
    hostname = normalizeHostname(new URL(value).hostname);
  } catch {
    return true;
  }

  if (hostname === 'localhost') return true;
  if (hostname.includes(':')) return isPrivateIpv6Hostname(hostname);

  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        String(octet) !== parts[index] ||
        octet < 0 ||
        octet > 255,
    )
  ) {
    return false;
  }
  return isPrivateIpv4Octets(octets);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isPrivateIpv6Hostname(hostname: string): boolean {
  if (hostname === '::1') return true;

  const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) {
    return isPrivateHttpBaseUrl(`http://${mappedIpv4[1]}`);
  }

  const firstSegment = Number.parseInt(hostname.split(':')[0] || '0', 16);
  if (!Number.isInteger(firstSegment)) return false;

  return (
    (firstSegment & 0xfe00) === 0xfc00 || (firstSegment & 0xffc0) === 0xfe80
  );
}

function isPrivateIpv4Octets(octets: number[]): boolean {
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}
