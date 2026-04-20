import type { RuntimeProvider } from './providers/shared.js';
import {
  isPremiumModelPermissionError,
  ProviderRequestError,
} from './providers/shared.js';

const TRANSIENT_NETWORK_ERROR_RE =
  /fetch failed|network|socket|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|terminated/i;
const TRANSIENT_CODEX_STREAM_ERROR_RE =
  /an error occurred while processing your request|request id [0-9a-f-]{8}-[0-9a-f-]{27}|streaming response ended without payload|stream ended without payload|response\.incomplete|response\.failed/i;
const MAX_ERROR_DETAIL_DEPTH = 3;

interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  errors?: unknown;
  hostname?: unknown;
  message?: unknown;
}

interface ErrorDetails {
  code: string;
  host: string;
  message: string;
}

function getOwnErrorDetails(error: unknown): ErrorDetails {
  if (typeof error === 'string') {
    return {
      code: '',
      host: '',
      message: error,
    };
  }
  if (!error || typeof error !== 'object') {
    return {
      code: '',
      host: '',
      message: '',
    };
  }

  const candidate = error as ErrorLike;
  return {
    code: typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '',
    host:
      typeof candidate.hostname === 'string' ? candidate.hostname.trim() : '',
    message:
      typeof candidate.message === 'string' ? candidate.message : '',
  };
}

function findErrorDetails(error: unknown, depth = 0): ErrorDetails {
  if (depth > MAX_ERROR_DETAIL_DEPTH || error == null) {
    return {
      code: '',
      host: '',
      message: '',
    };
  }

  const details = getOwnErrorDetails(error);
  if (details.code || details.host) {
    return details;
  }

  if (error && typeof error === 'object') {
    const candidate = error as ErrorLike;
    if (Array.isArray(candidate.errors)) {
      for (const nested of candidate.errors) {
        const nestedDetails = findErrorDetails(nested, depth + 1);
        if (nestedDetails.code || nestedDetails.host || nestedDetails.message) {
          return nestedDetails;
        }
      }
    }

    const causeDetails = findErrorDetails(candidate.cause, depth + 1);
    if (causeDetails.code || causeDetails.host || causeDetails.message) {
      return causeDetails;
    }
  }

  return details;
}

function resolveHost(baseUrl?: string): string {
  try {
    return baseUrl ? new URL(baseUrl).hostname || '' : '';
  } catch {
    return '';
  }
}

function formatConnectionTarget(host: string): string {
  return host ? `connection to ${host}` : 'connection';
}

export function formatModelErrorForLog(
  error: unknown,
  baseUrl?: string,
): string {
  if (error instanceof ProviderRequestError) {
    return error.message;
  }

  const details = findErrorDetails(error);
  const code = details.code;
  const host = details.host || resolveHost(baseUrl);
  const message = details.message || String(error);

  switch (code) {
    case 'ENOTFOUND':
      return host
        ? `DNS lookup failed for ${host}`
        : 'DNS lookup failed';
    case 'EAI_AGAIN':
      return host
        ? `DNS lookup for ${host} is temporarily unavailable`
        : 'DNS lookup is temporarily unavailable';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return `${formatConnectionTarget(host)} timed out`;
    case 'ECONNREFUSED':
      return `${formatConnectionTarget(host)} was refused`;
    case 'ECONNRESET':
      return `${formatConnectionTarget(host)} was reset`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return host ? `Host ${host} is unreachable` : 'Network is unreachable';
    case 'ERR_SOCKET_CLOSED':
    case 'UND_ERR_SOCKET':
    case 'EPIPE':
      return 'Socket closed unexpectedly';
    default:
      if (TRANSIENT_NETWORK_ERROR_RE.test(message)) {
        return host
          ? `Model API at ${host} is temporarily unavailable`
          : 'Model API is temporarily unavailable';
      }
      return message;
  }
}

export function shouldFallbackFromStreamError(error: unknown): boolean {
  if (error instanceof ProviderRequestError) {
    // Keep 429 on retry/backoff path; fallback does not help throttling.
    if (error.status === 429) return false;
    if (isPremiumModelPermissionError(error)) return false;
    return error.status >= 400 && error.status <= 599;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) return false;
  // Keep 429 on retry/backoff path; fallback does not help throttling.
  if (/429|rate.?limit/i.test(message)) return false;
  return (
    TRANSIENT_NETWORK_ERROR_RE.test(message) ||
    TRANSIENT_CODEX_STREAM_ERROR_RE.test(message)
  );
}

export function shouldDowngradeStreamToNonStreaming(
  provider: RuntimeProvider | undefined,
  error: unknown,
): boolean {
  if (provider === 'openai-codex') return false;
  return shouldFallbackFromStreamError(error);
}

export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ProviderRequestError) {
    return error.status === 429 || (error.status >= 500 && error.status <= 504);
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    TRANSIENT_NETWORK_ERROR_RE.test(message) ||
    TRANSIENT_CODEX_STREAM_ERROR_RE.test(message)
  );
}
