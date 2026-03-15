import type { ServerResponse } from 'node:http';
import { sendJson } from './gateway-http-common.js';
import { getGatewayStatus } from './gateway-service.js';

export function handleHealthEndpoint(
  pathname: string,
  method: string,
  res: ServerResponse,
): boolean {
  if (pathname !== '/health' || method !== 'GET') return false;
  sendJson(res, 200, getGatewayStatus());
  return true;
}
