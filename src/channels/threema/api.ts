import type { ParsedThreemaTarget } from './target.js';

const DEFAULT_THREEMA_API_BASE_URL = 'https://msgapi.threema.ch';

export class ThreemaApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly statusCode: number,
    public readonly description: string,
  ) {
    super(`Threema Gateway ${endpoint} failed (${statusCode}): ${description}`);
    this.name = 'ThreemaApiError';
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function normalizeThreemaApiBaseUrl(value?: string | null): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return DEFAULT_THREEMA_API_BASE_URL;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimTrailingSlashes(trimmed);
  }
  return trimTrailingSlashes(`https://${trimmed}`);
}

function appendRecipient(
  body: URLSearchParams,
  target: ParsedThreemaTarget,
): void {
  if (target.kind === 'id') {
    body.set('to', target.recipient);
    return;
  }
  body.set(target.kind, target.recipient);
}

function describeThreemaStatus(status: number, fallback: string): string {
  switch (status) {
    case 400:
      return 'recipient is invalid or the account is not set up for Basic mode';
    case 401:
      return 'API identity or secret is incorrect';
    case 402:
      return 'no credits remain';
    case 404:
      return 'recipient could not be found';
    case 413:
      return 'message is too long';
    case 429:
      return 'rate limit exceeded';
    case 500:
      return 'temporary Threema Gateway server error';
    default:
      return fallback || 'unexpected Threema Gateway response';
  }
}

export async function sendThreemaSimpleText(params: {
  apiBaseUrl?: string | null;
  identity: string;
  secret: string;
  target: ParsedThreemaTarget;
  text: string;
  signal?: AbortSignal;
}): Promise<string> {
  const body = new URLSearchParams();
  body.set('from', params.identity);
  body.set('secret', params.secret);
  body.set('text', params.text);
  appendRecipient(body, params.target);

  const response = await fetch(
    `${normalizeThreemaApiBaseUrl(params.apiBaseUrl)}/send_simple`,
    {
      method: 'POST',
      headers: {
        Accept: 'text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body,
      signal: params.signal,
    },
  ).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Threema transport error';
    throw new ThreemaApiError('send_simple', 0, message);
  });

  const responseText = await response.text().catch(() => '');
  if (!response.ok) {
    throw new ThreemaApiError(
      'send_simple',
      response.status,
      describeThreemaStatus(response.status, responseText.trim()),
    );
  }
  return responseText.trim();
}
