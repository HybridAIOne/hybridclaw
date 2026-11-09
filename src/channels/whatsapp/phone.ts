/**
 * WhatsApp address syntax core keeps while the plugin is absent, so stored
 * JIDs and `whatsapp:`/phone message-tool targets fail with the install hint
 * instead of reaching email or Signal.
 *
 * Mirrors the plugin's `matchesTarget`/`normalizeTarget` for that fallback
 * only; once the plugin is registered, its own rules decide.
 */
import { normalizePhoneNumber } from '../../utils/phone-number.js';

const WHATSAPP_PREFIX_RE = /^whatsapp:/i;
const WHATSAPP_USER_JID_RE =
  /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid|hosted|hosted\.lid)$/i;
const WHATSAPP_PHONE_USER_JID_RE =
  /^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/i;
const WHATSAPP_LID_USER_JID_RE = /^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i;
const WHATSAPP_GROUP_JID_RE = /^[0-9]+(?:-[0-9]+)*@g\.us$/i;

function stripWhatsAppPrefix(value: string): string {
  return String(value || '')
    .trim()
    .replace(WHATSAPP_PREFIX_RE, '')
    .trim();
}

function canonicalizeWhatsAppUserJid(jid: string): string | null {
  const phoneMatch = jid.match(WHATSAPP_PHONE_USER_JID_RE);
  if (phoneMatch) return `${phoneMatch[1]}@s.whatsapp.net`;
  const lidMatch = jid.match(WHATSAPP_LID_USER_JID_RE);
  if (lidMatch) return `${lidMatch[1]}@lid`;
  return null;
}

export function isWhatsAppJid(channelId: string): boolean {
  const candidate = stripWhatsAppPrefix(channelId);
  return (
    WHATSAPP_USER_JID_RE.test(candidate) ||
    WHATSAPP_GROUP_JID_RE.test(candidate)
  );
}

/** A message-tool target (JID, `whatsapp:` prefix, or phone number) as a JID. */
export function normalizeWhatsAppTarget(rawTarget: string): string | null {
  const withoutPrefix = stripWhatsAppPrefix(rawTarget);
  if (!withoutPrefix) return null;
  const canonicalJid = canonicalizeWhatsAppUserJid(withoutPrefix);
  if (canonicalJid) return canonicalJid;
  if (isWhatsAppJid(withoutPrefix)) return withoutPrefix;
  if (/[a-z]/i.test(withoutPrefix)) return null;
  const phone = normalizePhoneNumber(withoutPrefix);
  return phone ? `${phone.slice(1)}@s.whatsapp.net` : null;
}
