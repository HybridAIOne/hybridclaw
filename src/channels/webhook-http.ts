import type { IncomingMessage, ServerResponse } from 'node:http';

export class WebhookHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'WebhookHttpError';
    this.statusCode = statusCode;
  }
}

interface ReadWebhookJsonBodyOptions {
  maxBytes: number;
  tooLargeMessage: string;
  invalidJsonMessage: string;
  requireObject?: boolean;
  invalidShapeMessage?: string;
  parsedBody?: unknown;
  tooLargeStatusCode?: number;
  invalidJsonStatusCode?: number;
  invalidShapeStatusCode?: number;
}

function validateWebhookJsonBody(
  body: unknown,
  options: ReadWebhookJsonBodyOptions,
): unknown {
  if (
    options.requireObject &&
    (!body || typeof body !== 'object' || Array.isArray(body))
  ) {
    throw new WebhookHttpError(
      options.invalidShapeStatusCode ?? 400,
      options.invalidShapeMessage || 'Webhook body must be a JSON object.',
    );
  }
  return body;
}

export async function readWebhookJsonBody(
  req: IncomingMessage,
  options: ReadWebhookJsonBodyOptions,
): Promise<unknown> {
  if (typeof options.parsedBody !== 'undefined') {
    return validateWebhookJsonBody(options.parsedBody, options);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > options.maxBytes) {
      throw new WebhookHttpError(
        options.tooLargeStatusCode ?? 413,
        options.tooLargeMessage,
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return validateWebhookJsonBody({}, options);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return validateWebhookJsonBody({}, options);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new WebhookHttpError(
      options.invalidJsonStatusCode ?? 400,
      options.invalidJsonMessage,
    );
  }

  return validateWebhookJsonBody(parsed, options);
}

export function sendWebhookJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!res.writableEnded) {
    res.end(JSON.stringify(body));
  }
}
