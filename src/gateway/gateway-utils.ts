import type { StructuredAuditEntry } from '../types/audit.js';

export function numberFromUnknown(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  ) {
    return null;
  }
  return value;
}

export function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberFromUnknown(value);
    if (parsed != null) return parsed;
  }
  return null;
}

export function parseAuditPayload(
  entry: StructuredAuditEntry,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
