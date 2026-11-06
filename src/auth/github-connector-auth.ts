import {
  HYBRIDAI_BASE_URL,
  MissingRequiredEnvVarError,
} from '../config/config.js';
import { getHybridAIApiKey } from './hybridai-auth.js';

/**
 * Managed runtime secret backed by the HybridAI platform GitHub connector.
 * The gateway mints it on demand; it is never stored locally.
 */
export const GITHUB_ACCESS_TOKEN_SECRET = 'GITHUB_ACCESS_TOKEN';
export const GITHUB_CONNECTOR_TOKEN_PATH = '/api/v1/connectors/github/token';

export type GitHubConnectorTokenSource = 'github-connector';

const GITHUB_TOKEN_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'uploads.github.com',
  'codeload.github.com',
]);
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

type CachedToken = {
  cacheKey: string;
  accessToken: string;
  expiresAtMs: number;
};

let cachedToken: CachedToken | null = null;

export function isGitHubTokenHost(host?: string): boolean {
  return GITHUB_TOKEN_HOSTS.has(
    String(host || '')
      .trim()
      .toLowerCase(),
  );
}

export function clearGitHubConnectorTokenCache(): void {
  cachedToken = null;
}

function resolveBaseUrl(): string {
  return (HYBRIDAI_BASE_URL || 'https://hybridai.one').replace(/\/+$/g, '');
}

function readOptionalApiKey(): string {
  try {
    return getHybridAIApiKey();
  } catch (error) {
    if (error instanceof MissingRequiredEnvVarError) return '';
    throw error;
  }
}

function parseExpiresAtMs(payload: Record<string, unknown>, now: number) {
  const expiresAt = payload.expires_at;
  if (typeof expiresAt === 'string' && expiresAt.trim()) {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    // Accept epoch seconds or milliseconds.
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }
  const expiresIn = payload.expires_in;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    return now + expiresIn * 1000;
  }
  return now + DEFAULT_TOKEN_TTL_MS;
}

function errorMessageFromPayload(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  for (const key of ['message', 'error', 'detail']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

/**
 * Mints a short-lived GitHub access token from the HybridAI platform GitHub
 * connector. Returns null when HybridAI or the GitHub connector is not
 * connected; throws on unexpected platform errors.
 *
 * Platform contract:
 *   POST {HYBRIDAI_BASE_URL}/api/v1/connectors/github/token
 *   Authorization: Bearer <HybridAI API key>
 *   200 → { access_token: string, expires_at?: ISO-8601 | epoch,
 *           expires_in?: seconds }
 *   404 / 409 → GitHub connector not connected for this account.
 */
export async function resolveGitHubConnectorAccessToken(): Promise<{
  accessToken: string;
  source: GitHubConnectorTokenSource;
} | null> {
  const apiKey = readOptionalApiKey();
  if (!apiKey) return null;

  const baseUrl = resolveBaseUrl();
  const cacheKey = `${baseUrl}\n${apiKey}`;
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.cacheKey === cacheKey &&
    cachedToken.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > now
  ) {
    return { accessToken: cachedToken.accessToken, source: 'github-connector' };
  }
  cachedToken = null;

  const response = await fetch(`${baseUrl}${GITHUB_CONNECTOR_TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (response.status === 404 || response.status === 409) return null;

  let payload: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(
      `HybridAI GitHub connector token request failed: ${errorMessageFromPayload(
        payload,
        `HTTP ${response.status}`,
      )}`,
    );
  }

  const accessToken =
    typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) {
    throw new Error(
      'HybridAI GitHub connector token response did not include access_token.',
    );
  }
  cachedToken = {
    cacheKey,
    accessToken,
    expiresAtMs: parseExpiresAtMs(payload, now),
  };
  return { accessToken, source: 'github-connector' };
}
