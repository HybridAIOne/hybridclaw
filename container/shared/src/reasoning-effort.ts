export const REASONING_EFFORTS = ['none', 'low', 'medium', 'xhigh'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly unknown[]).includes(value);
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
