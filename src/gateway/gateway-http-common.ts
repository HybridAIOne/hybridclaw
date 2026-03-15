import type { IncomingMessage, ServerResponse } from 'node:http';

import { GATEWAY_API_TOKEN, WEB_API_TOKEN } from '../config/config.js';

const MAX_REQUEST_BYTES = 1_000_000; // 1MB

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function hasQueryToken(url: URL): boolean {
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return false;
  if (WEB_API_TOKEN && token === WEB_API_TOKEN) return true;
  return token === GATEWAY_API_TOKEN;
}

export function hasApiAuth(
  req: IncomingMessage,
  url?: URL,
  opts?: { allowQueryToken?: boolean },
): boolean {
  const authHeader = req.headers.authorization || '';
  const gatewayTokenMatch =
    Boolean(GATEWAY_API_TOKEN) && authHeader === `Bearer ${GATEWAY_API_TOKEN}`;
  if (opts?.allowQueryToken && url && hasQueryToken(url)) return true;

  if (!WEB_API_TOKEN) {
    return gatewayTokenMatch || isLoopbackAddress(req.socket.remoteAddress);
  }
  if (authHeader === `Bearer ${WEB_API_TOKEN}`) return true;
  return gatewayTokenMatch;
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

export function sendText(
  res: ServerResponse,
  statusCode: number,
  text: string,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error('Request body too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}
