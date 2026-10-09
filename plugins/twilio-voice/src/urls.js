/**
 * The one place that decides which public URLs Twilio uses for this plugin.
 *
 * Signature checks, the stream/relay URLs written into TwiML, and the
 * outbound-call webhook all derive from `resolveBaseUrl`; if they disagree,
 * Twilio's signatures never verify. The gateway's public origin wins
 * (`api.getPublicBaseUrl()`); without one, the origin the request arrived on
 * (honouring a TLS-terminating tunnel's forwarded headers) is used.
 */

const WEBHOOK_BASE_PATH = '/api/plugin-webhooks/twilio-voice';

export const TWILIO_VOICE_PATHS = Object.freeze({
  webhook: `${WEBHOOK_BASE_PATH}/webhook`,
  action: `${WEBHOOK_BASE_PATH}/action`,
  relay: `${WEBHOOK_BASE_PATH}/relay`,
  stream: `${WEBHOOK_BASE_PATH}/stream`,
});

function firstHeader(req, name) {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '')
    .split(',')[0]
    .trim();
}

function requestOrigin(req) {
  const host =
    firstHeader(req, 'x-forwarded-host') ||
    String(req.headers.host || 'localhost').trim();
  const forwardedProto = firstHeader(req, 'x-forwarded-proto').toLowerCase();
  const protocol =
    forwardedProto || (req.socket?.encrypted === true ? 'https' : 'http');
  return `${protocol}://${host}`;
}

export function resolveBaseUrl(api, req) {
  return api.getPublicBaseUrl() || requestOrigin(req);
}

export function toWebsocketUrl(httpUrl) {
  return httpUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

export function resolveRemoteIp(req) {
  return (
    firstHeader(req, 'x-forwarded-for') ||
    String(req.socket?.remoteAddress || 'unknown').trim()
  );
}
