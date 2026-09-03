/**
 * Inbound caller gating for the phone channel.
 *
 * Mirrors the `dmPolicy` / `allowFrom` gate the messaging channels use:
 * `open` accepts every caller, `disabled` rejects every caller, and
 * `allowlist` accepts only numbers named in `allowFrom` — or any caller when
 * that list contains `*`.
 *
 * Numbers are compared in a canonical `+<digits>` form, so allowlist entries
 * written with spaces, dashes, or no leading `+` still match the E.164 value
 * the carrier sends. A caller who withholds their number arrives with an
 * empty `from` and is therefore never matched by an allowlist, which is the
 * intended behaviour.
 */
import type { VoiceCallerPolicy } from '../../config/runtime-config.js';

export function normalizeCallerIdentity(
  value: string | null | undefined,
): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

export function normalizeCallerAllowList(
  values: readonly string[] | null | undefined,
): string[] {
  const list: string[] = [];
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

export function isCallerAllowed(params: {
  callerPolicy: VoiceCallerPolicy | null | undefined;
  allowFrom: readonly string[] | null | undefined;
  from: string | null | undefined;
}): boolean {
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

/**
 * Allowlist entries that look like a national dialling format — no `+` and a
 * trunk prefix `0` — which can never match the E.164 value a carrier sends.
 * `0171 9727750` normalizes to `+01719727750`, not `+491719727750`, so the
 * entry silently never matches; surfacing it beats a dead allowlist.
 */
export function findNationalFormatAllowEntries(
  values: readonly string[] | null | undefined,
): string[] {
  const suspicious: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value ?? '').trim();
    if (!raw || raw === '*' || raw.startsWith('+')) continue;
    if (raw.replace(/[^\d]/g, '').startsWith('0')) suspicious.push(raw);
  }
  return suspicious;
}
