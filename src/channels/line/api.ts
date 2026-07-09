export interface LineTextMessage {
  type: 'text';
  text: string;
}

interface LineApiErrorPayload {
  message?: string;
  details?: Array<{
    message?: string;
    property?: string;
  }>;
}

export class LineApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly statusCode: number,
    public readonly description: string,
  ) {
    super(`LINE API ${endpoint} failed (${statusCode}): ${description}`);
    this.name = 'LineApiError';
  }
}

function redactLineToken(value: string, token: string): string {
  const trimmedToken = String(token || '').trim();
  if (!trimmedToken) return value;
  return String(value || '')
    .split(trimmedToken)
    .join('<redacted>');
}

function sanitizeLineTransportError(error: unknown, token: string): Error {
  if (error instanceof LineApiError) {
    return error;
  }

  const sanitizedMessage = redactLineToken(
    error instanceof Error
      ? error.message
      : String(error || 'Unknown LINE transport error'),
    token,
  );
  const sanitized = new Error(sanitizedMessage);
  sanitized.name = error instanceof Error ? error.name : 'Error';
  if (error instanceof Error && error.stack) {
    sanitized.stack = redactLineToken(error.stack, token);
  }
  return sanitized;
}

function buildLineApiUrl(endpoint: string): string {
  return `https://api.line.me/v2/bot/${endpoint.replace(/^\/+/, '')}`;
}

async function parseLineResponse(
  response: Response,
  endpoint: string,
): Promise<void> {
  if (response.ok) return;

  const raw = await response.text().catch(() => '');
  let payload: LineApiErrorPayload | null = null;
  try {
    payload = raw ? (JSON.parse(raw) as LineApiErrorPayload) : null;
  } catch {
    payload = null;
  }

  const detailText = Array.isArray(payload?.details)
    ? payload.details
        .map((detail) =>
          [detail.property, detail.message].filter(Boolean).join(': '),
        )
        .filter(Boolean)
        .join('; ')
    : '';
  const description =
    [payload?.message, detailText].filter(Boolean).join(' - ') ||
    raw.trim() ||
    'Unknown LINE API error';
  throw new LineApiError(endpoint, response.status, description);
}

export async function callLineApi(
  channelAccessToken: string,
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch(buildLineApiUrl(endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${channelAccessToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal,
    });
    await parseLineResponse(response, endpoint);
  } catch (error) {
    throw sanitizeLineTransportError(error, channelAccessToken);
  }
}
