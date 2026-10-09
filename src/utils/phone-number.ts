/**
 * E.164 phone-number normalization shared by every phone-addressed channel.
 * Returns `+<digits>` or null; it strips formatting but never guesses a
 * country code, and it knows no channel prefixes or address syntaxes.
 */
const E164_DIGITS_RE = /^[1-9]\d{6,14}$/;

export function normalizePhoneNumber(raw: string): string | null {
  const candidate = String(raw || '').trim();
  if (!candidate || candidate.includes('@')) return null;

  const digits = candidate.replace(/[^\d+]/g, '');
  if (!digits) return null;

  const normalizedDigits = digits.startsWith('+') ? digits.slice(1) : digits;
  if (!E164_DIGITS_RE.test(normalizedDigits)) return null;
  return `+${normalizedDigits}`;
}
