import type { IncomingMessage } from 'node:http';
import { GATEWAY_BASE_URL, getConfigSnapshot } from '../../config/config.js';

export interface VoiceWebhookPaths {
  basePath: string;
  webhookPath: string;
  relayPath: string;
  actionPath: string;
}

function normalizePath(pathValue: string): string {
  const normalized = String(pathValue || '').trim() || '/voice';
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return prefixed.replace(/\/+$/, '') || '/voice';
}

function firstForwardedHeader(
  req: IncomingMessage,
  name: 'x-forwarded-host' | 'x-forwarded-proto',
): string {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '')
    .split(',')[0]
    .trim();
}

export function resolveVoiceWebhookPaths(
  basePath = getConfigSnapshot().voice.webhookPath,
): VoiceWebhookPaths {
  const normalizedBasePath = normalizePath(basePath);
  return {
    basePath: normalizedBasePath,
    webhookPath: `${normalizedBasePath}/webhook`,
    relayPath: `${normalizedBasePath}/relay`,
    actionPath: `${normalizedBasePath}/action`,
  };
}

export function resolvePublicBaseUrl(req: IncomingMessage): string {
  const configured = String(GATEWAY_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const host =
    firstForwardedHeader(req, 'x-forwarded-host') ||
    String(req.headers.host || 'localhost').trim();
  const protocol =
    firstForwardedHeader(req, 'x-forwarded-proto') ||
    (req.socket && 'encrypted' in req.socket && req.socket.encrypted
      ? 'https'
      : 'http');
  return `${protocol}://${host}`;
}

export function buildPublicHttpUrl(
  req: IncomingMessage,
  pathValue: string,
): string {
  const base = resolvePublicBaseUrl(req);
  const normalizedPath = normalizePath(pathValue);
  return `${base}${normalizedPath}`;
}

export function buildPublicWsUrl(
  req: IncomingMessage,
  pathValue: string,
): string {
  const httpUrl = buildPublicHttpUrl(req, pathValue);
  return httpUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}
