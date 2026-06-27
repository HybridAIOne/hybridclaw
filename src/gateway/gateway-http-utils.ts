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

function jsonResponseReplacer(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey === 'stack' ||
    normalizedKey === 'stacktrace' ||
    normalizedKey === 'stack_trace'
  ) {
    return undefined;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  return value;
}

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload, jsonResponseReplacer, 2));
}
