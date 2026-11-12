/**
 * Reasoning efforts a turn may carry to the worker. NOT the guard or the
 * table of which models support the control
 * (`packages/shared/src/reasoning-effort.ts`).
 */
export const REASONING_EFFORTS: readonly ['none', 'low', 'medium', 'xhigh'] = [
  'none',
  'low',
  'medium',
  'xhigh',
];

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
