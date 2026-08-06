/**
 * Voice webhook path + public URL resolution shared by every voice provider.
 *
 * All provider endpoints hang off the single `voice.webhookPath` base:
 * Twilio uses /webhook, /relay, /action; Vonage uses /answer, /input, /event.
 * Public URLs prefer `ops.gatewayBaseUrl` and only fall back to forwarded
 * headers, so generated callback URLs stay stable behind proxies.
 *
 * NOT provider API clients — Twilio/Vonage REST calls live in their manager
 * modules; this module never performs network I/O.
 */
import type { IncomingMessage } from 'node:http';
import { GATEWAY_BASE_URL, getConfigSnapshot } from '../../config/config.js';
import { normalizeBaseUrl } from '../../providers/utils.js';

export interface VoiceWebhookPaths {
  basePath: string;
  webhookPath: string;
  relayPath: string;
  actionPath: string;
  answerPath: string;
  inputPath: string;
  eventPath: string;
}

function normalizePath(pathValue: string): string {
  const normalized = String(pathValue || '').trim() || '/voice';
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return prefixed.replace(/\/+$/, '') || '/voice';
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
    answerPath: `${normalizedBasePath}/answer`,
    inputPath: `${normalizedBasePath}/input`,
    eventPath: `${normalizedBasePath}/event`,
  };
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

export function resolvePublicBaseUrl(req: IncomingMessage): string {
  const configured = normalizeBaseUrl(GATEWAY_BASE_URL);
  if (configured) {
    return configured;
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
