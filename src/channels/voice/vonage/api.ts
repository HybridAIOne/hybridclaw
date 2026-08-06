/**
 * Vonage Voice REST client (outbound call creation, live-call NCCO transfer).
 *
 * In-call operations honor the per-call `region_url` Vonage reports in its
 * answer webhook — transfers against the wrong regional host fail, so
 * callers must thread that value through instead of assuming the global
 * host. Auth mints a fresh application JWT per request.
 *
 * NOT webhook handling — inbound validation and the turn loop live in
 * vonage-manager.ts; NCCO shapes come from ncco.ts.
 */
import { isRecord } from '../../../utils/type-guards.js';
import { mintVonageApplicationJwt } from './jwt.js';
import type { VonageNccoAction } from './ncco.js';

const VONAGE_DEFAULT_API_BASE_URL = 'https://api.nexmo.com';

export interface VonageOutboundCall {
  uuid: string;
  status: string;
  conversationUuid: string;
}

function toVonageNumber(e164: string): string {
  return String(e164 || '').replace(/^\+/, '');
}

function normalizeApiBaseUrl(regionUrl?: string): string {
  const trimmed = String(regionUrl || '').trim();
  if (!/^https:\/\//i.test(trimmed)) {
    return VONAGE_DEFAULT_API_BASE_URL;
  }
  return trimmed.replace(/\/+$/, '');
}

async function extractVonageErrorDetail(response: Response): Promise<string> {
  const rawText = await response.text().catch(() => '');
  if (rawText.trim()) {
    try {
      const payload: unknown = JSON.parse(rawText);
      if (isRecord(payload)) {
        const detail = payload.detail ?? payload.title ?? payload.error_title;
        if (typeof detail === 'string' && detail.trim()) {
          return detail.trim();
        }
      }
    } catch {
      // fall through to raw text
    }
    return rawText.trim().slice(0, 300);
  }
  return response.statusText || 'Request failed';
}

export async function createVonageOutboundCall(params: {
  applicationId: string;
  privateKey: string;
  from: string;
  to: string;
  answerUrl: string;
  eventUrl: string;
}): Promise<VonageOutboundCall> {
  const token = mintVonageApplicationJwt({
    applicationId: params.applicationId,
    privateKey: params.privateKey,
  });
  const response = await fetch(`${VONAGE_DEFAULT_API_BASE_URL}/v1/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: [{ type: 'phone', number: toVonageNumber(params.to) }],
      from: { type: 'phone', number: toVonageNumber(params.from) },
      answer_url: [params.answerUrl],
      answer_method: 'POST',
      event_url: [params.eventUrl],
      event_method: 'POST',
    }),
  });

  if (!response.ok) {
    const detail = await extractVonageErrorDetail(response);
    throw new Error(`Vonage call failed (${response.status}): ${detail}`);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (
    !isRecord(payload) ||
    typeof payload.uuid !== 'string' ||
    typeof payload.status !== 'string'
  ) {
    throw new Error('Vonage call failed: invalid response payload');
  }

  return {
    uuid: payload.uuid,
    status: payload.status,
    conversationUuid:
      typeof payload.conversation_uuid === 'string'
        ? payload.conversation_uuid
        : '',
  };
}

export async function transferVonageCallToNcco(params: {
  applicationId: string;
  privateKey: string;
  callUuid: string;
  ncco: VonageNccoAction[];
  regionUrl?: string;
}): Promise<void> {
  const token = mintVonageApplicationJwt({
    applicationId: params.applicationId,
    privateKey: params.privateKey,
  });
  const baseUrl = normalizeApiBaseUrl(params.regionUrl);
  const response = await fetch(
    `${baseUrl}/v1/calls/${encodeURIComponent(params.callUuid)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'transfer',
        destination: { type: 'ncco', ncco: params.ncco },
      }),
    },
  );

  if (!response.ok) {
    const detail = await extractVonageErrorDetail(response);
    throw new Error(`Vonage transfer failed (${response.status}): ${detail}`);
  }
}
