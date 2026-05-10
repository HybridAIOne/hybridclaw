import { normalizeEmailAddress } from '../email/allowlist.js';
import { normalizePhoneNumber } from '../whatsapp/phone.js';

const THREEMA_PREFIX_RE = /^threema:/i;
const THREEMA_PHONE_PREFIX_RE = /^phone:/i;
const THREEMA_EMAIL_PREFIX_RE = /^email:/i;
const THREEMA_ID_RE = /^(?:[A-Z0-9]{8}|\*[A-Z0-9]{7})$/i;

export type ThreemaRecipientKind = 'id' | 'phone' | 'email';

export interface ParsedThreemaTarget {
  kind: ThreemaRecipientKind;
  recipient: string;
}

function stripThreemaPrefix(value: string): string {
  return value.replace(THREEMA_PREFIX_RE, '').trim();
}

export function normalizeThreemaId(value: string): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return THREEMA_ID_RE.test(normalized) ? normalized : undefined;
}

export function normalizeThreemaPhone(value: string): string | undefined {
  const normalized = normalizePhoneNumber(value);
  return normalized ? normalized.slice(1) : undefined;
}

export function parseThreemaTarget(value: string): ParsedThreemaTarget | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const hasThreemaPrefix = THREEMA_PREFIX_RE.test(trimmed);
  const stripped = stripThreemaPrefix(trimmed);
  if (!stripped) return null;

  if (hasThreemaPrefix) {
    const phoneCandidate = stripped.replace(THREEMA_PHONE_PREFIX_RE, '').trim();
    if (phoneCandidate !== stripped) {
      const phone = normalizeThreemaPhone(phoneCandidate);
      return phone ? { kind: 'phone', recipient: phone } : null;
    }

    const emailCandidate = stripped.replace(THREEMA_EMAIL_PREFIX_RE, '').trim();
    if (emailCandidate !== stripped) {
      const email = normalizeEmailAddress(emailCandidate);
      return email ? { kind: 'email', recipient: email } : null;
    }
  }

  const id = normalizeThreemaId(stripped);
  return id ? { kind: 'id', recipient: id } : null;
}

export function buildThreemaChannelId(params: {
  kind: ThreemaRecipientKind;
  recipient: string;
}): string {
  if (params.kind === 'id') {
    const id = normalizeThreemaId(params.recipient);
    if (!id) throw new Error(`Invalid Threema ID: ${params.recipient}`);
    return `threema:${id}`;
  }
  if (params.kind === 'phone') {
    const phone = normalizeThreemaPhone(params.recipient);
    if (!phone) {
      throw new Error(`Invalid Threema phone target: ${params.recipient}`);
    }
    return `threema:phone:${phone}`;
  }
  const email = normalizeEmailAddress(params.recipient);
  if (!email) {
    throw new Error(`Invalid Threema email target: ${params.recipient}`);
  }
  return `threema:email:${email}`;
}

export function normalizeThreemaChannelId(value: string): string | undefined {
  const parsed = parseThreemaTarget(value);
  if (!parsed) return undefined;
  return buildThreemaChannelId(parsed);
}

export function isThreemaChannelId(value: string): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed || !THREEMA_PREFIX_RE.test(trimmed)) return false;
  return Boolean(parseThreemaTarget(trimmed));
}
