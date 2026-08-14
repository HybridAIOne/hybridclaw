export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
