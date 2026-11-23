/**
 * Reasoning-effort runtime: the membership guard and canonical list normalizer
 * for provider-advertised efforts. The effort list is wire data
 * (`@hybridclaw/contracts/reasoning-effort`); per-model support comes from
 * provider discovery (`src/providers/hybridai-discovery.ts`), never a static
 * model table here.
 */
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@hybridclaw/contracts/reasoning-effort';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function normalizeReasoningEfforts(values: unknown): ReasoningEffort[] {
  if (!Array.isArray(values)) return [];
  const accepted = new Set<ReasoningEffort>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase();
    if (isReasoningEffort(normalized)) {
      accepted.add(normalized);
    }
  }
  return REASONING_EFFORTS.filter((effort) => accepted.has(effort));
}
