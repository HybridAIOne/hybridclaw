const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off']);

export function parseOptionalBoolean(value) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
  if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

export function parseBooleanWithDefault(value, fallback) {
  return parseOptionalBoolean(value) ?? fallback;
}
