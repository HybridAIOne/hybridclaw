export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readFiniteNumberOr(value: unknown, fallback: number): number {
  return readFiniteNumber(value) ?? fallback;
}
