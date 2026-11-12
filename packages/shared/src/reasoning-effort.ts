/**
 * Reasoning-effort runtime: the membership guard and which provider/model
 * pairs support the control. The effort list is wire data
 * (`@hybridclaw/contracts/reasoning-effort`).
 */
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@hybridclaw/contracts/reasoning-effort';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function getSupportedReasoningEfforts(
  provider: string | null | undefined,
  model: string,
): ReasoningEffort[] {
  if (String(provider || '').toLowerCase() !== 'hybridai') return [];
  const normalized = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^hybridai\//, '');

  // HybridAI Qwen3.8 27B only (owner call, 2026-09-22): this is the model
  // verified for the requested control; dynamic provider metadata is deferred.
  return /^qwen\/qwen3\.8-27b(?:$|[-:.])/.test(normalized)
    ? [...REASONING_EFFORTS]
    : [];
}
