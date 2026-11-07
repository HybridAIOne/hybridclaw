import { isRecord } from './primitive-values.js';

export interface ContextGuardConfigShape {
  enabled: boolean;
  compactionRatio: number;
  overflowRatio: number;
  maxRetries: number;
}

export const CONTEXT_GUARD_DEFAULTS: Readonly<ContextGuardConfigShape> =
  Object.freeze({
    enabled: true,
    compactionRatio: 0.75,
    overflowRatio: 0.9,
    maxRetries: 3,
  });

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeContextGuardConfig(
  value: unknown,
  fallback?: ContextGuardConfigShape,
): ContextGuardConfigShape {
  const base = isRecord(fallback) ? fallback : CONTEXT_GUARD_DEFAULTS;
  const raw = isRecord(value) ? value : {};

  const compactionRatio = clamp(
    readNumber(raw.compactionRatio, base.compactionRatio),
    0.2,
    0.98,
  );
  const overflowRatio = Math.max(
    compactionRatio,
    clamp(readNumber(raw.overflowRatio, base.overflowRatio), 0.3, 0.99),
  );

  return {
    enabled: readBoolean(raw.enabled, base.enabled),
    compactionRatio,
    overflowRatio,
    maxRetries: clamp(readInteger(raw.maxRetries, base.maxRetries), 0, 10),
  };
}
