/**
 * Twilio REST client for placing outbound calls. The created call fetches
 * TwiML from this plugin's incoming-call webhook, so an outbound call runs
 * the same relay or realtime flow as an inbound one.
 *
 * NOT webhook handling (`runtime.js`); NOT URL resolution (`urls.js`).
 */
import { isRecord } from './utils.js';

const E164_DIGITS_RE = /^[1-9]\d{6,14}$/;
const TWILIO_API_BASE_URL = 'https://api.twilio.com';

/** `+<digits>` in E.164 form, or null. */
export function normalizeTwilioPhoneNumber(raw) {
  const digits = String(raw || '')
    .trim()
    .replace(/[^\d+]/g, '');
  const normalized = digits.startsWith('+') ? digits.slice(1) : digits;
  return E164_DIGITS_RE.test(normalized) ? `+${normalized}` : null;
}

export async function createTwilioOutboundCall({
  accountSid,
  authToken,
  from,
  to,
  url,
}) {
  const response = await fetch(
    `${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: from,
        Url: url,
        Method: 'POST',
      }),
    },
  );
  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail =
      isRecord(payload) && typeof payload.message === 'string'
        ? payload.message.trim()
        : rawText.trim() || response.statusText || 'Request failed';
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
