/**
 * Read-only operator inspection runs behind admin.sessions.read in the HTTP
 * server. Unlike chat recall, this route can inspect other audiences; it never
 * returns this inventory to a channel participant or modifies stored memory.
 */
import type { ServerResponse } from 'node:http';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  inspectMemoryRelationship,
  listMemoryRelationships,
} from '../memory/relationship-memory.js';
import { sendJson } from './gateway-http-utils.js';

function offset(url: URL, name: string): number {
  const raw = url.searchParams.get(name) ?? '0';
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new GatewayRequestError(400, `Invalid ${name}.`);
  }
  return value;
}

export function handleRelationshipMemoryRoute(
  res: ServerResponse,
  url: URL,
  method: string,
): void {
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  const audienceKey = url.searchParams.get('audienceKey');
  const agentId = url.searchParams.get('agentId');
  if (audienceKey === null && agentId === null) {
    sendJson(res, 200, listMemoryRelationships(offset(url, 'offset')));
    return;
  }
  if (
    !audienceKey?.trim() ||
    !agentId?.trim() ||
    audienceKey.length > 4096 ||
    agentId.length > 128
  ) {
    throw new GatewayRequestError(400, 'Provide both agentId and audienceKey.');
  }
  const detail = inspectMemoryRelationship({
    agentId,
    audienceKey,
    sessionOffset: offset(url, 'sessionOffset'),
    memoryOffset: offset(url, 'memoryOffset'),
  });
  sendJson(
    res,
    detail ? 200 : 404,
    detail ?? { error: 'Relationship not found.' },
  );
}
