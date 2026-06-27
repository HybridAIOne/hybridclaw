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

function quoteJsonString(value: string): string {
  let quoted = '"';
  for (const char of value) {
    switch (char) {
      case '"':
        quoted += '\\"';
        break;
      case '\\':
        quoted += '\\\\';
        break;
      case '\b':
        quoted += '\\b';
        break;
      case '\f':
        quoted += '\\f';
        break;
      case '\n':
        quoted += '\\n';
        break;
      case '\r':
        quoted += '\\r';
        break;
      case '\t':
        quoted += '\\t';
        break;
      default:
        quoted +=
          char.charCodeAt(0) < 0x20
            ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
            : char;
    }
  }
  quoted += '"';
  return quoted;
}

function stringifyJsonResponseValue(
  value: JsonResponseValue,
  indent = 0,
): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteJsonString(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  const padding = ' '.repeat(indent);
  const childPadding = ' '.repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(
      (entry) =>
        `${childPadding}${stringifyJsonResponseValue(entry, indent + 2)}`,
    );
    return `[\n${items.join(',\n')}\n${padding}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const items = entries.map(
    ([key, entry]) =>
      `${childPadding}${quoteJsonString(key)}: ${stringifyJsonResponseValue(
        entry,
        indent + 2,
      )}`,
  );
  return `{\n${items.join(',\n')}\n${padding}}`;
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
    stringifyJsonResponseValue(sanitizeJsonResponsePayload(payload) ?? null),
  );
}
