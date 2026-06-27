/**
 * Shared HTTP helpers used by both gateway-http-server and gateway-http-proxy.
 *
 * Extracted to avoid a circular dependency between those two modules.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { parsePositiveInteger } from '../utils/number-normalization.js';

const MAX_REQUEST_BYTES = 1_000_000; // 1 MB

export { parsePositiveInteger };

export async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new GatewayRequestError(413, 'Request body too large.');
    }
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const rawBuffer = await readRequestBody(req, MAX_REQUEST_BYTES);
  if (rawBuffer.length === 0) return {};
  const raw = rawBuffer.toString('utf-8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new GatewayRequestError(400, 'Invalid JSON body');
  }
}

type JsonResponseValue =
  | null
  | string
  | number
  | boolean
  | JsonResponseValue[]
  | { [key: string]: JsonResponseValue };

const STACK_TRACE_FIELD_NAMES = new Set(['stack', 'stacktrace', 'stack_trace']);

function sanitizeJsonResponsePayload(
  value: unknown,
  seen = new WeakSet<object>(),
): JsonResponseValue | undefined {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (value instanceof Date) return value.toISOString();

  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(
        (item) => sanitizeJsonResponsePayload(item, seen) ?? null,
      );
    }

    const sanitized: { [key: string]: JsonResponseValue } = {};
    for (const [key, rawValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (STACK_TRACE_FIELD_NAMES.has(key.toLowerCase())) continue;
      const sanitizedValue = sanitizeJsonResponsePayload(rawValue, seen);
      if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(
    JSON.stringify(sanitizeJsonResponsePayload(payload) ?? null, null, 2),
  );
}
