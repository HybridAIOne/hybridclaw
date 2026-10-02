/**
 * Twilio voice URLs and REST calls — the one place that decides which public
 * base URL Twilio reaches this gateway on.
 *
 * Webhook signature checks, generated TwiML stream/relay URLs, and the
 * outbound `voice call` webhook all derive from `resolveConfiguredVoiceBaseUrl`;
 * if they disagree, Twilio's signatures never verify. Does not serve webhooks
 * (`runtime.ts` does).
 */
import type { IncomingMessage } from 'node:http';
import { GATEWAY_BASE_URL, getConfigSnapshot } from '../../config/config.js';
import {
  isPrivateHttpBaseUrl,
  normalizeHttpBaseUrl,
} from '../../gateway/gateway-url-utils.js';
import { normalizeBaseUrl } from '../../providers/utils.js';
import { isRecord } from '../../utils/type-guards.js';

export interface VoiceWebhookPaths {
  basePath: string;
  webhookPath: string;
  relayPath: string;
  streamPath: string;
  actionPath: string;
}

export interface TwilioOutboundCall {
  sid: string;
  status: string;
  to: string;
  from: string;
}

const E164_DIGITS_RE = /^[1-9]\d{6,14}$/;

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
    streamPath: `${normalizedBasePath}/stream`,
    actionPath: `${normalizedBasePath}/action`,
  };
}

// `ops.gatewayBaseUrl` defaults to loopback, which Twilio cannot reach; a cloud
// deployment already knows its public origin, so prefer that over a private
// or unset base. Cloud mode only (#1446); local-mode tunnel URLs are not
// consulted.
function resolveConfiguredVoiceBaseUrl(): string {
  const configured = normalizeBaseUrl(GATEWAY_BASE_URL);
  if (configured && !isPrivateHttpBaseUrl(configured)) return configured;
  const { deployment } = getConfigSnapshot();
  const publicUrl =
    deployment.mode === 'cloud'
      ? normalizeHttpBaseUrl(deployment.public_url)
      : undefined;
  return publicUrl || configured;
}

export function resolveVoiceCallWebhookUrl(webhookBasePath: string): {
  url?: string;
  error?: string;
} {
  const baseUrl = resolveConfiguredVoiceBaseUrl();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {
      error: `Configured \`ops.gatewayBaseUrl\` is invalid: ${baseUrl}`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      error: 'Configured `ops.gatewayBaseUrl` must use `http` or `https`.',
    };
  }

  if (isPrivateHttpBaseUrl(baseUrl)) {
    return {
      error:
        'Set `ops.gatewayBaseUrl` (or `deployment.public_url` in cloud mode) to a public URL before using `voice call`; Twilio cannot reach localhost or private-network webhooks.',
    };
  }

  const paths = resolveVoiceWebhookPaths(webhookBasePath);
  return { url: `${baseUrl}${paths.webhookPath}` };
}

export function resolvePublicBaseUrl(req: IncomingMessage): string {
  const configured = resolveConfiguredVoiceBaseUrl();
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

export function normalizeTwilioPhoneNumber(raw: string): string | null {
  const candidate = String(raw || '').trim();
  if (!candidate) return null;

  const digits = candidate.replace(/[^\d+]/g, '');
  if (!digits) return null;

  const normalizedDigits = digits.startsWith('+') ? digits.slice(1) : digits;
  if (!E164_DIGITS_RE.test(normalizedDigits)) return null;
  return `+${normalizedDigits}`;
}

function buildTwilioAuthHeader(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

function extractTwilioErrorMessage(
  payload: unknown,
  fallbackText: string,
): string {
  if (isRecord(payload)) {
    const message = payload.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }
  return fallbackText;
}

export async function createTwilioOutboundCall(params: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  url: string;
}): Promise<TwilioOutboundCall> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Calls.json`;
  const body = new URLSearchParams({
    To: params.to,
    From: params.from,
    Url: params.url,
    Method: 'POST',
  });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: buildTwilioAuthHeader(params.accountSid, params.authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const rawText = await response.text();
  let payload: unknown = null;
  if (rawText.trim()) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const detail = extractTwilioErrorMessage(
      payload,
      rawText.trim() || response.statusText || 'Request failed',
    );
    throw new Error(`Twilio call failed (${response.status}): ${detail}`);
  }

  if (
    !isRecord(payload) ||
    typeof payload.sid !== 'string' ||
    typeof payload.status !== 'string' ||
    typeof payload.to !== 'string' ||
    typeof payload.from !== 'string'
  ) {
    throw new Error('Twilio call failed: invalid response payload');
  }

  return {
    sid: payload.sid,
    status: payload.status,
    to: payload.to,
    from: payload.from,
  };
}
