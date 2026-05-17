export function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function readFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readFiniteNumberOr(value, fallback) {
  return readFiniteNumber(value) ?? fallback;
}
