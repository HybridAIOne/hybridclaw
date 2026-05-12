const WHATSAPP_PREFIX_RE = /^whatsapp:/i;
const WHATSAPP_USER_JID_RE =
  /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid|hosted|hosted\.lid)$/i;
const WHATSAPP_PHONE_USER_JID_RE =
  /^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/i;
const WHATSAPP_LID_USER_JID_RE = /^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i;
const WHATSAPP_GROUP_JID_RE = /^[0-9]+(?:-[0-9]+)*@g\.us$/i;
const E164_DIGITS_RE = /^[1-9]\d{6,14}$/;

function stripWhatsAppPrefix(value: string): string {
  return String(value || '')
    .trim()
    .replace(WHATSAPP_PREFIX_RE, '')
    .trim();
}

export function normalizePhoneNumber(raw: string): string | null {
  const candidate = stripWhatsAppPrefix(raw);
  if (!candidate || candidate.includes('@')) return null;

  const digits = candidate.replace(/[^\d+]/g, '');
  if (!digits) return null;

  const normalizedDigits = digits.startsWith('+') ? digits.slice(1) : digits;
  if (!E164_DIGITS_RE.test(normalizedDigits)) return null;
  return `+${normalizedDigits}`;
}

export function phoneToJid(phone: string): string | null {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return null;
  return `${normalized.slice(1)}@s.whatsapp.net`;
}

export function jidToPhone(jid: string): string | null {
  const candidate = stripWhatsAppPrefix(jid);
  const match = candidate.match(WHATSAPP_USER_JID_RE);
  if (!match) return null;
  const digits = match[1]!;
  if (!E164_DIGITS_RE.test(digits)) return null;
  return `+${digits}`;
}

export function normalizeWhatsAppUserIdentity(jid: string): string | null {
  const candidate = stripWhatsAppPrefix(jid);
  const phoneMatch = candidate.match(WHATSAPP_PHONE_USER_JID_RE);
  if (phoneMatch) {
    return `phone:${phoneMatch[1]}`;
  }

  const lidMatch = candidate.match(WHATSAPP_LID_USER_JID_RE);
  if (lidMatch) {
    return `lid:${lidMatch[1]}`;
  }

  return null;
}

export function canonicalizeWhatsAppUserJid(jid: string): string | null {
  const candidate = stripWhatsAppPrefix(jid);
  const phoneMatch = candidate.match(WHATSAPP_PHONE_USER_JID_RE);
  if (phoneMatch) {
    return `${phoneMatch[1]}@s.whatsapp.net`;
  }

  const lidMatch = candidate.match(WHATSAPP_LID_USER_JID_RE);
  if (lidMatch) {
    return `${lidMatch[1]}@lid`;
  }

  return null;
}

export function isWhatsAppJid(channelId: string): boolean {
  const candidate = stripWhatsAppPrefix(channelId);
  return (
    WHATSAPP_USER_JID_RE.test(candidate) ||
    WHATSAPP_GROUP_JID_RE.test(candidate)
  );
}

export function isGroupJid(jid: string): boolean {
  return WHATSAPP_GROUP_JID_RE.test(stripWhatsAppPrefix(jid));
}
