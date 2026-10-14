export {
  parseNonNegativeInteger,
  parsePositiveInteger,
} from '../../container/shared/primitive-values.js';

export function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function positiveNumberOrNull(value: unknown): number | null {
  const number = finiteNumberOrNull(value);
  return number != null && number > 0 ? number : null;
}

export function nonNegativeIntegerOrNull(value: unknown): number | null {
  const number = finiteNumberOrNull(value);
  return number != null && number >= 0 ? Math.floor(number) : null;
}

export function normalizeNonNegativeInteger(value: unknown): number {
  return nonNegativeIntegerOrNull(value) ?? 0;
}

export function normalizeNonNegativeNumber(value: unknown): number {
  const number = finiteNumberOrNull(value);
  return number != null ? Math.max(0, number) : 0;
}
