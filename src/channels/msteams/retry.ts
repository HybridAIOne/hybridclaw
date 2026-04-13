import type { TurnContext } from 'botbuilder-core';
import type { Activity } from 'botframework-schema';
import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { withTransportRetry } from '../../utils/transport-retry.js';

const MSTEAMS_RETRY_MAX_ATTEMPTS = 3;
const MSTEAMS_RETRY_BASE_DELAY_MS = 500;
const MSTEAMS_RETRY_MAX_DELAY_MS = 4_000;

interface TeamsErrorLike {
  data?: {
    retry_after?: number | string;
  };
  headers?: Headers | Record<string, unknown>;
  httpStatus?: number;
  response?: {
    headers?: Headers | Record<string, unknown>;
    status?: number;
    statusCode?: number;
  };
  retryAfter?: number | string;
  status?: number;
  statusCode?: number;
}

function parseHeaderDelayMs(value: string, key: string): number | null {
  const normalizedValue = value.trim();
  if (!normalizedValue) return null;
  if (key === 'x-ms-retry-after-ms') {
    const milliseconds = Number(normalizedValue);
    return Number.isFinite(milliseconds) && milliseconds > 0
      ? Math.ceil(milliseconds)
      : null;
  }
  const seconds = Number(normalizedValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1_000);
  }
  const retryAt = Date.parse(normalizedValue);
  if (!Number.isNaN(retryAt)) {
    return Math.max(50, retryAt - Date.now());
  }
  return null;
}

function readHeader(
  headers: Headers | Record<string, unknown> | undefined,
  key: string,
): string {
  if (!headers) return '';
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(key) || '';
  }
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (name: string) => unknown }).get(key);
    return typeof value === 'string' ? value : '';
  }
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() !== key) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.find((entry) => typeof entry === 'string') || '';
    }
  }
  return '';
}

function getTeamsErrorStatus(error: unknown): number | null {
  const maybe = error as TeamsErrorLike;
  const status =
    maybe.status ??
    maybe.statusCode ??
    maybe.httpStatus ??
    maybe.response?.status ??
    maybe.response?.statusCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function isRetryableTeamsError(error: unknown): boolean {
  const status = getTeamsErrorStatus(error);
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return true;
  }
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return classifyGatewayError(text) === 'transient';
}

function extractRetryDelayMs(error: unknown, fallbackMs: number): number {
  const maybe = error as TeamsErrorLike;
  const clampDelayMs = (delayMs: number): number =>
    Math.min(delayMs, MSTEAMS_RETRY_MAX_DELAY_MS);
  const retryAfter = maybe.retryAfter ?? maybe.data?.retry_after;
  if (
    typeof retryAfter === 'number' &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
  ) {
    return clampDelayMs(Math.max(50, Math.ceil(retryAfter * 1_000)));
  }
  if (typeof retryAfter === 'string') {
    const delay = parseHeaderDelayMs(retryAfter, 'retry-after');
    if (delay !== null) return clampDelayMs(delay);
  }

  for (const key of ['x-ms-retry-after-ms', 'retry-after']) {
    const headerValue =
      readHeader(maybe.response?.headers, key) ||
      readHeader(maybe.headers, key);
    const delay = parseHeaderDelayMs(headerValue, key);
    if (delay !== null) return clampDelayMs(delay);
  }

  return fallbackMs;
}

async function withMSTeamsRetry<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  return withTransportRetry(label, run, {
    maxAttempts: MSTEAMS_RETRY_MAX_ATTEMPTS,
    baseDelayMs: MSTEAMS_RETRY_BASE_DELAY_MS,
    maxDelayMs: MSTEAMS_RETRY_MAX_DELAY_MS,
    isRetryable: isRetryableTeamsError,
    extractRetryAfter: extractRetryDelayMs,
    logMessage: 'Teams transport failed; retrying',
  });
}

export function sendMSTeamsActivityWithRetry(
  turnContext: TurnContext,
  activity: Partial<Activity>,
  label: string,
) {
  return withMSTeamsRetry(label, async () =>
    turnContext.sendActivity(activity),
  );
}

export function updateMSTeamsActivityWithRetry(
  turnContext: TurnContext,
  activity: Partial<Activity>,
  label: string,
) {
  return withMSTeamsRetry(label, async () =>
    turnContext.updateActivity(activity),
  );
}
