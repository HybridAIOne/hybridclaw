export function normalizeLower(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}
