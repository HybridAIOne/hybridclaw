/**
 * Inbound caller gating for the Vonage voice channel.
 *
 * Mirrors the `dmPolicy` / `allowFrom` shape the messaging channels use:
 * `open` accepts every caller, `disabled` rejects every caller, and
 * `allowlist` accepts only numbers named in `allowFrom` — or any caller when
 * that list contains `*`.
 *
 * Numbers are compared in a normalized `+<digits>` form, so allowlist entries
 * written with spaces, dashes, or no leading `+` still match the E.164 value
 * Vonage puts in the answer webhook's `from` field. A caller who withholds
 * their number arrives with an empty `from` and is therefore never matched by
 * an allowlist, which is the intended behaviour.
 */
const CALLER_POLICIES = ['open', 'allowlist', 'disabled'];

export function isCallerPolicy(value) {
  return CALLER_POLICIES.includes(value);
}

export function normalizeCallerIdentity(value) {
  const candidate = String(value ?? '').replace(/[^\d+]/g, '');
  if (!candidate) return null;
  const digits = candidate.startsWith('+') ? candidate.slice(1) : candidate;
  return digits ? `+${digits}` : null;
}

export function normalizeCallerAllowList(values) {
  const list = [];
  for (const value of values || []) {
    if (String(value ?? '').trim() === '*') {
      list.push('*');
      continue;
    }
    const normalized = normalizeCallerIdentity(value);
    if (normalized) list.push(normalized);
  }
  return [...new Set(list)];
}

export function isCallerAllowed(params) {
  if (params.callerPolicy === 'disabled') return false;
  if (params.callerPolicy === 'open') return true;
  const allowFrom = normalizeCallerAllowList(params.allowFrom);
  if (allowFrom.includes('*')) return true;
  const caller = normalizeCallerIdentity(params.from);
  return Boolean(caller) && allowFrom.includes(caller);
}
