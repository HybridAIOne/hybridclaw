/**
 * Twilio request authentication: the X-Twilio-Signature HMAC over the exact
 * public URL Twilio called (plus sorted form params for HTTP webhooks), and
 * a short replay window keyed on Twilio's idempotency token.
 *
 * An empty auth token never validates — an HMAC keyed with nothing is
 * computable by anyone. NOT URL resolution: callers pass the public URL
 * (`urls.js` decides which origin Twilio reached).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function normalizeParamValues(params) {
  return Object.entries(params)
    .map(([name, value]) => [
      name,
      Array.isArray(value)
        ? value.map((entry) => String(entry))
        : [String(value)],
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function buildTwilioSignature({ authToken, url, values }) {
  let payload = String(url || '');
  for (const [name, entries] of normalizeParamValues(values || {})) {
    for (const value of entries) {
      payload += `${name}${value}`;
    }
  }
  // lgtm[js/insufficient-password-hash] HMAC-SHA1 is mandated by Twilio's
  // webhook signature protocol; this authenticates a request, not a password.
  return createHmac('sha1', String(authToken || ''))
    .update(payload, 'utf8')
    .digest('base64');
}

export function validateTwilioSignature({ authToken, signature, url, values }) {
  if (!String(authToken || '').trim()) return false;
  const expected = buildTwilioSignature({ authToken, url, values });
  const actual = String(signature || '').trim();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  return Boolean(expected) && timingSafeEqual(expectedDigest, actualDigest);
}

export function createReplayProtector(ttlMs) {
  const entries = new Map();
  return {
    /** False when the token was already seen inside the window. */
    observe(token) {
      const normalized = String(token || '').trim();
      if (!normalized) return true;
      const now = Date.now();
      for (const [seen, seenAt] of entries) {
        if (now - seenAt >= ttlMs) entries.delete(seen);
      }
      if (entries.has(normalized)) return false;
      entries.set(normalized, now);
      return true;
    },
    clear() {
      entries.clear();
    },
  };
}
