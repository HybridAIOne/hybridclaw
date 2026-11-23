/**
 * Reasoning efforts a turn may carry to the worker. NOT the guard or discovery
 * lookup (`packages/shared/src/reasoning-effort.ts`,
 * `src/providers/hybridai-discovery.ts`).
 */
export const REASONING_EFFORTS: readonly [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
