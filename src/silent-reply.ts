export const SILENT_REPLY_TOKEN = '__MESSAGE_SEND_HANDLED__';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const escapedToken = escapeRegExp(SILENT_REPLY_TOKEN);
const EXACT_SILENT_REPLY_RE = new RegExp(`^\\s*${escapedToken}\\s*$`);
const TRAILING_SILENT_REPLY_RE = new RegExp(
  `(?:^|\\s+|\\*+)${escapedToken}(?:\\*+)?\\s*$`,
);
const UPPERCASE_PREFIX_RE = /^[_A-Z]+$/;

export function isSilentReply(text: string | null | undefined): boolean {
  const normalized = String(text || '');
  if (!normalized) return false;
  return EXACT_SILENT_REPLY_RE.test(normalized);
}

export function stripSilentToken(text: string): string {
  const normalized = String(text || '');
  if (!normalized) return '';
  if (isSilentReply(normalized)) return '';
  return normalized.replace(TRAILING_SILENT_REPLY_RE, '').trimEnd();
}

export function isSilentReplyPrefix(text: string | null | undefined): boolean {
  const normalized = String(text || '').trim();
  if (!normalized || normalized.length < 3) return false;
  if (!UPPERCASE_PREFIX_RE.test(normalized)) return false;
  return SILENT_REPLY_TOKEN.startsWith(normalized);
}
