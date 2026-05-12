import { lookup } from 'node:dns/promises';
import net from 'node:net';

function isPrivateIpv4(ip) {
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

function isPrivateIpv6(ip) {
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

export function isPrivateBrowserIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

export async function isPrivateBrowserHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  if (net.isIP(host) > 0) return isPrivateBrowserIp(host);
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0) return false;
    return resolved.some((entry) => isPrivateBrowserIp(entry.address));
  } catch {
    return false;
  }
}

export function browserPrivateNetworkAllowed(env = process.env) {
  return (
    String(env.BROWSER_ALLOW_PRIVATE_NETWORK || '').toLowerCase() === 'true'
  );
}

export async function assertBrowserNavigationUrl(raw, options = {}) {
  const input = String(raw || '').trim();
  if (!input) {
    throw new Error('url is required');
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol === 'about:' && parsed.href === 'about:blank') {
    return parsed;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const allowPrivate =
    options.allowPrivateNetwork ?? browserPrivateNetworkAllowed(options.env);
  if (!allowPrivate && (await isPrivateBrowserHost(parsed.hostname))) {
    throw new Error(
      `Navigation blocked by SSRF guard: private or loopback host (${parsed.hostname}). ` +
        'Set BROWSER_ALLOW_PRIVATE_NETWORK=true to override.',
    );
  }
  return parsed;
}
