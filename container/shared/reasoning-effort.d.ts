export declare const REASONING_EFFORTS: readonly [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
];

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export declare function isReasoningEffort(
  value: unknown,
): value is ReasoningEffort;
