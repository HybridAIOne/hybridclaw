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
