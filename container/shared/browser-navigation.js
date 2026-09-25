import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { isPrivateNetworkAddress } from './private-network.js';

export async function isPrivateBrowserHost(hostname) {
  // URL.hostname keeps IPv6 literals bracketed; unbracket them so they are
  // classified below instead of falling through to a DNS lookup.
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, '$1');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  if (net.isIP(host) > 0) return isPrivateNetworkAddress(host);
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0) return false;
    return resolved.some((entry) => isPrivateNetworkAddress(entry.address));
  } catch {
    return false;
  }
}

export function browserPrivateNetworkAllowed(env = process.env) {
  return (
    String(env.BROWSER_ALLOW_PRIVATE_NETWORK || '').toLowerCase() === 'true'
  );
}

export function isAllowedHostlessBrowserNavigationUrl(parsed) {
  return parsed.protocol === 'about:' && parsed.href === 'about:blank';
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

  if (isAllowedHostlessBrowserNavigationUrl(parsed)) {
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
        'Enable browser.allowPrivateNetwork in /admin/config or run /config set browser.allowPrivateNetwork true, then retry.',
    );
  }
  return parsed;
}
