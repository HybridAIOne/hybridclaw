/**
 * Caller gating for Vonage calls, applying the core `voice.callerPolicy` and
 * `voice.allowFrom` settings so the phone channel behaves the same whichever
 * transport carries the call — the same way `speech.realtime.*` is shared.
 *
 * Kept as a local mirror of `src/channels/voice/caller-policy.ts` because
 * plugins load from the workspace plugin directory and cannot import gateway
 * internals, matching the existing per-channel duplication of these helpers.
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

export function isCallerAllowed(params) {
  if (params.callerPolicy === 'disabled') return false;
  // Anything that is not an explicit allowlist is open, which keeps an
  // unset or unrecognised policy on the documented default instead of
  // silently refusing every caller.
  if (params.callerPolicy !== 'allowlist') return true;
  const allowFrom = normalizeCallerAllowList(params.allowFrom);
  if (allowFrom.includes('*')) return true;
  const caller = normalizeCallerIdentity(params.from);
  if (!caller) return false;
  return allowFrom.includes(caller);
}
