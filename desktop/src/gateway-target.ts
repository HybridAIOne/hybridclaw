export type DesktopRoute = 'chat' | 'agents' | 'admin';

export const DEFAULT_GATEWAY_BASE_URL = 'http://127.0.0.1:9090';

export function normalizeGatewayBaseUrl(
  raw = DEFAULT_GATEWAY_BASE_URL,
): string {
  const candidate = raw.trim() || DEFAULT_GATEWAY_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid HybridClaw gateway URL: ${candidate}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('HybridClaw gateway URL must use http:// or https://.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      'HybridClaw gateway URL must not include a path, query string, or hash.',
    );
  }

  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

export function routeUrl(baseUrl: string, route: DesktopRoute): string {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl);
  const pathname =
    route === 'chat' ? '/chat' : route === 'agents' ? '/agents' : '/admin';
  return new URL(pathname, `${normalizedBaseUrl}/`).toString();
}

export function routeForUrl(
  candidate: string,
  baseUrl: string,
): DesktopRoute | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(candidate);
    base = new URL(`${normalizeGatewayBaseUrl(baseUrl)}/`);
  } catch {
    return null;
  }

  if (url.origin !== base.origin) return null;
  if (url.pathname === '/chat' || url.pathname === '/chat.html') return 'chat';
  if (url.pathname === '/agents' || url.pathname === '/agents.html') {
    return 'agents';
  }
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    return 'admin';
  }
  return null;
}

export function isInAppUrl(candidate: string, baseUrl: string): boolean {
  return routeForUrl(candidate, baseUrl) !== null;
}

export function buildGatewayEnv(baseUrl: string): NodeJS.ProcessEnv {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl);
  const url = new URL(`${normalizedBaseUrl}/`);
  return {
    ...process.env,
    GATEWAY_BASE_URL: normalizedBaseUrl,
    HEALTH_HOST: url.hostname,
    HEALTH_PORT: url.port || (url.protocol === 'https:' ? '443' : '80'),
  };
}
