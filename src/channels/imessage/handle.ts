import { normalizeEmailAddress } from '../email/allowlist.js';
import { normalizePhoneNumber } from '../whatsapp/phone.js';

const IMESSAGE_PREFIX_RE = /^imessage:/i;
const GROUP_PREFIX_RE = /^chat:/i;
const BLUEBUBBLES_GROUP_RE = /^any;\+;.+$/i;
const BLUEBUBBLES_DM_RE = /^any;-;(.+)$/i;

function normalizeGroupHandle(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (GROUP_PREFIX_RE.test(normalized)) {
    const rawId = normalized.replace(GROUP_PREFIX_RE, '').trim();
    return rawId ? `chat:${rawId}` : null;
  }
  if (BLUEBUBBLES_GROUP_RE.test(normalized)) {
    return `chat:${normalized}`;
  }
  return null;
}

export function normalizeIMessageHandle(raw: string): string | null {
  const trimmed = String(raw || '')
    .trim()
    .replace(IMESSAGE_PREFIX_RE, '')
    .trim();
  if (!trimmed) return null;

  const groupHandle = normalizeGroupHandle(trimmed);
  if (groupHandle) return groupHandle;

  const blueBubblesDm = trimmed.match(BLUEBUBBLES_DM_RE);
  if (blueBubblesDm) {
    return normalizeIMessageHandle(blueBubblesDm[1] || '');
  }

  const email = normalizeEmailAddress(trimmed);
  if (email) return email;

  const phone = normalizePhoneNumber(trimmed);
  if (phone) return phone;

  return null;
}

export function isIMessageHandle(raw: string): boolean {
  const trimmed = String(raw || '').trim();
  if (!IMESSAGE_PREFIX_RE.test(trimmed)) {
    return false;
  }
  return normalizeIMessageHandle(trimmed) !== null;
}

export function buildIMessageChannelId(handle: string): string {
  const normalized = normalizeIMessageHandle(handle);
  if (!normalized) {
    throw new Error(`Invalid iMessage handle: ${handle}`);
  }
  return `imessage:${normalized}`;
}

export function parseIMessageChannelId(channelId: string): string | null {
  return normalizeIMessageHandle(channelId);
}

export function isIMessageGroupHandle(handle: string): boolean {
  return normalizeIMessageHandle(handle)?.startsWith('chat:') === true;
}

export function toBlueBubblesChatGuid(handle: string): string | null {
  const normalized = normalizeIMessageHandle(handle);
  if (!normalized) return null;
  if (normalized.startsWith('chat:')) {
    return normalized.slice('chat:'.length).trim() || null;
  }
  return `any;-;${normalized}`;
}
