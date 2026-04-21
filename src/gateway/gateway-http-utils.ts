/**
 * Shared HTTP helpers used by both gateway-http-server and gateway-http-proxy.
 *
 * Extracted to avoid a circular dependency between those two modules.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { GatewayRequestError } from '../errors/gateway-request-error.js';

const MAX_REQUEST_BYTES = 1_000_000; // 1 MB

export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

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

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload, null, 2));
}
