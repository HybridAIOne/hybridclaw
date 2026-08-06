/**
 * Twilio REST helpers for the voice channel.
 *
 * Owns outbound call creation against the Twilio Calls API and E.164 phone
 * normalization. Auth is Basic (account SID + auth token) per Twilio's API;
 * callers must pass credentials — nothing is read from config here.
 *
 * NOT webhook routing — path and public-URL resolution for all voice
 * providers lives in webhook-paths.ts.
 */
import { isRecord } from '../../utils/type-guards.js';

export interface TwilioOutboundCall {
  sid: string;
  status: string;
  to: string;
  from: string;
}

const E164_DIGITS_RE = /^[1-9]\d{6,14}$/;

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
