export const REASONING_EFFORTS: readonly ['none', 'low', 'medium', 'xhigh'];

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort;

export function getSupportedReasoningEfforts(
  provider: string | null | undefined,
  model: string,
): ReasoningEffort[];
