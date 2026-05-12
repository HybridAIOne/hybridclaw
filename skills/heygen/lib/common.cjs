'use strict';

const DEFAULT_TIMEOUT_MS = 60_000;
const RATE_LIMIT_BODY_RE =
  /rate.?limit|too many requests|quota exceeded|exceed rate limit|daily rate limit/i;
const INSUFFICIENT_CREDITS_RE = /insufficient credits/i;

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.max(0, Math.ceil(Number(raw) * 1_000));
  }
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

function isRateLimitBody(body) {
  return RATE_LIMIT_BODY_RE.test(String(body || ''));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  INSUFFICIENT_CREDITS_RE,
  RATE_LIMIT_BODY_RE,
  isRateLimitBody,
  parseRetryAfterMs,
};
