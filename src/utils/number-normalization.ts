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

export function positiveIntegerOrNull(value: unknown): number | null {
  const number = positiveNumberOrNull(value);
  return number != null ? Math.floor(number) : null;
}

export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeNonNegativeInteger(value: unknown): number {
  return nonNegativeIntegerOrNull(value) ?? 0;
}

export function normalizeNonNegativeNumber(value: unknown): number {
  const number = finiteNumberOrNull(value);
  return number != null ? Math.max(0, number) : 0;
}
