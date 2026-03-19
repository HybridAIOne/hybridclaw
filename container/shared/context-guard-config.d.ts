export interface ContextGuardConfigShape {
  enabled: boolean;
  perResultShare: number;
  compactionRatio: number;
  overflowRatio: number;
  maxRetries: number;
}

export declare const CONTEXT_GUARD_DEFAULTS: Readonly<ContextGuardConfigShape>;

export declare function normalizeContextGuardConfig(
  value: unknown,
  fallback?: ContextGuardConfigShape,
): ContextGuardConfigShape;
