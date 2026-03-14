import { lookup } from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal',
  '100.100.100.200',
]);

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
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : false;
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

async function resolveAllAddresses(hostname: string): Promise<string[]> {
  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    return resolved.map((entry) => entry.address);
  } catch {
    return [];
  }
}

async function assertPublicHost(hostname: string): Promise<void> {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Navigation blocked by SSRF guard: missing hostname');
  }
  if (
    BLOCKED_HOSTS.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    throw new Error(
      `Navigation blocked by SSRF guard: disallowed host (${normalized})`,
    );
  }
  if (net.isIP(normalized) > 0 && isPrivateIp(normalized)) {
    throw new Error(
      `Navigation blocked by SSRF guard: private host (${normalized})`,
    );
  }
  const addresses = await resolveAllAddresses(normalized);
  if (addresses.some((address) => isPrivateIp(address))) {
    throw new Error(
      `Navigation blocked by SSRF guard: ${normalized} resolved to a private address`,
    );
  }
}

export async function validateNavigationUrl(rawUrl: unknown): Promise<URL> {
  const value = String(rawUrl || '').trim();
  if (!value) throw new Error('url is required');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  await assertPublicHost(parsed.hostname);
  return parsed;
}

export async function validateRedirectTarget(rawUrl: string | URL): Promise<void> {
  const parsed = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Redirect blocked by SSRF guard: ${parsed.protocol}`);
  }
  await assertPublicHost(parsed.hostname);
}
