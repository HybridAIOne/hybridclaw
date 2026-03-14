import type { BrowserTab } from './types.js';

type JsonVersionResponse = {
  webSocketDebuggerUrl?: unknown;
};

type JsonListEntry = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  type?: unknown;
  webSocketDebuggerUrl?: unknown;
};

const DISCOVERY_TIMEOUT_MS = 5_000;

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeCdpWsUrl(
  rawWsUrl: string,
  discoveryOrigin: string,
): string {
  const parsedWs = new URL(rawWsUrl);
  const parsedOrigin = new URL(discoveryOrigin);
  if (
    parsedWs.hostname === '0.0.0.0' ||
    parsedWs.hostname === '::' ||
    parsedWs.hostname === '[::]'
  ) {
    parsedWs.hostname = parsedOrigin.hostname;
  }
  return parsedWs.toString();
}

export async function discoverCdpWsUrl(
  port: number,
  host = '127.0.0.1',
): Promise<string> {
  const origin = `http://${host}:${port}`;
  const response = await fetchJson<JsonVersionResponse>(`${origin}/json/version`);
  const rawWsUrl =
    typeof response.webSocketDebuggerUrl === 'string'
      ? response.webSocketDebuggerUrl.trim()
      : '';
  if (!rawWsUrl) {
    throw new Error(`No webSocketDebuggerUrl found at ${origin}/json/version`);
  }
  return normalizeCdpWsUrl(rawWsUrl, origin);
}

export async function listTargets(
  port: number,
  host = '127.0.0.1',
): Promise<BrowserTab[]> {
  const origin = `http://${host}:${port}`;
  const response = await fetchJson<JsonListEntry[]>(`${origin}/json/list`);
  const tabs = response
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : '';
      const title = typeof entry.title === 'string' ? entry.title : '';
      const url = typeof entry.url === 'string' ? entry.url : '';
      const type = typeof entry.type === 'string' ? entry.type : '';
      const rawWsUrl =
        typeof entry.webSocketDebuggerUrl === 'string'
          ? entry.webSocketDebuggerUrl
          : '';
      if (!id || !type) return null;
      return {
        id,
        title,
        url,
        type,
        wsUrl: rawWsUrl ? normalizeCdpWsUrl(rawWsUrl, origin) : undefined,
      };
    })
    .filter((entry) => entry !== null);
  return tabs as BrowserTab[];
}

export async function closeTarget(
  port: number,
  targetId: string,
  host = '127.0.0.1',
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${host}:${port}/json/close/${targetId}`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
