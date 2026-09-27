import { URL } from 'node:url';

import {
  fetchPublicHttpsBuffer,
  type PublicHttpsFetchOptions,
  type PublicHttpsFetchResult,
} from '../../security/public-https-fetch.js';

export const DISCORD_CDN_HOST_PATTERNS: RegExp[] = [
  /^cdn\.discordapp\.com$/i,
  /^media\.discordapp\.net$/i,
  /^cdn\.discordapp\.net$/i,
  /^images-ext-\d+\.discordapp\.net$/i,
];

export type DiscordCdnFetchResult = PublicHttpsFetchResult;

function parseDiscordCdnUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid_url:${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`blocked_url:${rawUrl}`);
  }
  if (
    !DISCORD_CDN_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))
  ) {
    throw new Error(`blocked_url:${rawUrl}`);
  }
  return parsed;
}

export function isSafeDiscordCdnUrl(raw: string): boolean {
  try {
    parseDiscordCdnUrl(raw);
    return true;
  } catch {
    return false;
  }
}

export async function fetchDiscordCdnBuffer(
  rawUrl: string,
  options: PublicHttpsFetchOptions = {},
): Promise<DiscordCdnFetchResult> {
  return fetchPublicHttpsBuffer(parseDiscordCdnUrl(rawUrl), options);
}

export async function fetchDiscordCdnText(
  rawUrl: string,
  options: {
    maxChars: number;
    maxBytes?: number;
    timeoutMs?: number;
    readIdleTimeoutMs?: number;
  },
): Promise<string> {
  const result = await fetchDiscordCdnBuffer(rawUrl, {
    maxBytes: options.maxBytes ?? Math.max(65_536, options.maxChars * 4),
    readIdleTimeoutMs: options.readIdleTimeoutMs,
    timeoutMs: options.timeoutMs,
  });
  const text = result.body.toString('utf8');
  if (text.length <= options.maxChars) return text;
  return `${text.slice(0, Math.max(1_000, options.maxChars - 32))}\n...[truncated]`;
}
