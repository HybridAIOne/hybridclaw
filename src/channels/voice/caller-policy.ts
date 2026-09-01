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
  const candidate = String(value ?? '').replace(/[^\d+]/g, '');
  if (!candidate) return null;
  const digits = candidate.startsWith('+') ? candidate.slice(1) : candidate;
  return digits ? `+${digits}` : null;
}

export function normalizeCallerAllowList(values: readonly string[]): string[] {
  const list: string[] = [];
  for (const value of values) {
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
  callerPolicy: VoiceCallerPolicy;
  allowFrom: readonly string[];
  from: string | null | undefined;
}): boolean {
  if (params.callerPolicy === 'disabled') return false;
  if (params.callerPolicy === 'open') return true;
  const allowFrom = normalizeCallerAllowList(params.allowFrom);
  if (allowFrom.includes('*')) return true;
  const caller = normalizeCallerIdentity(params.from);
  if (!caller) return false;
  return allowFrom.includes(caller);
}
