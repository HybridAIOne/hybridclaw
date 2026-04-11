const INLINE_EMAIL_SUBJECT_RE = /^\[subject:\s*([^\]\n]+)\]\s*(?:\n+)?/i;

export function extractInlineEmailSubject(value: string): {
  subject: string | null;
  body: string;
} {
  const normalized = String(value || '').replace(/\r\n?/g, '\n');
  const match = normalized.match(INLINE_EMAIL_SUBJECT_RE);
  if (!match?.[1]) {
    return {
      subject: null,
      body: normalized.trim(),
    };
  }

  const subject = match[1].trim();
  return {
    subject: subject || null,
    body: normalized.slice(match[0].length).trim(),
  };
}
