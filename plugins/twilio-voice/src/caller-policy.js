/**
 * Caller gating for Twilio calls, applying the core `voice.callerPolicy` and
 * `voice.allowFrom` settings: `open` accepts every caller, `disabled` none,
 * and `allowlist` only the numbers in `allowFrom` (or anyone when it holds
 * `*`). Numbers compare in canonical `+<digits>` form; a withheld number
 * never matches an allowlist.
 *
 * Mirrors `plugins/vonage-voice/src/caller-policy.js`: plugins are installed
 * as separate directories and cannot import each other or gateway internals.
 */
export function normalizeCallerIdentity(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

export function normalizeCallerAllowList(values) {
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (String(value ?? '').trim() === '*') {
      list.push('*');
      continue;
    }
    const normalized = normalizeCallerIdentity(value);
    if (normalized) list.push(normalized);
  }
  return [...new Set(list)];
}

export function isCallerAllowed({ callerPolicy, allowFrom, from }) {
  if (callerPolicy === 'disabled') return false;
  // Anything that is not an explicit allowlist is open, which keeps an
  // unset or unrecognised policy on the documented default instead of
  // silently refusing every caller.
  if (callerPolicy !== 'allowlist') return true;
  const allowed = normalizeCallerAllowList(allowFrom);
  if (allowed.includes('*')) return true;
  const caller = normalizeCallerIdentity(from);
  return Boolean(caller) && allowed.includes(caller);
}

/**
 * Allowlist entries in a national dialling format (no `+`, trunk prefix
 * `0`) can never match the E.164 value a carrier sends: `0171 9727750`
 * normalizes to `+01719727750`, not `+491719727750`.
 */
export function findNationalFormatAllowEntries(values) {
  const suspicious = [];
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value ?? '').trim();
    if (!raw || raw === '*' || raw.startsWith('+')) continue;
    if (raw.replace(/[^\d]/g, '').startsWith('0')) suspicious.push(raw);
  }
  return suspicious;
}
