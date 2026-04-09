export function normalizeString(value) {
  return String(value || '').trim();
}

export function truncateText(value, maxChars) {
  const normalized = normalizeString(value);
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
