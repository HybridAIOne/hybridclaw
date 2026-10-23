/**
 * Primitive-value readers for untrusted JSON, YAML, env and CLI input — the
 * one copy of each contract for the gateway and the container.
 *
 * A record is a non-null, non-array object; `asRecord` returns `null` for
 * anything else, never `{}`. Integer parsers never round: `0.5`, `1.5` and
 * `'12abc'` are rejected, not floored or truncated to a prefix.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

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

export function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parsePositiveInteger(value: unknown): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
