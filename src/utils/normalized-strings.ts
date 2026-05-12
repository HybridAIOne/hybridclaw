export function normalizeTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeOptionalTrimmedString(
  value: unknown,
): string | undefined {
  return normalizeTrimmedString(value) || undefined;
}

export function normalizeNullableTrimmedString(value: unknown): string | null {
  return normalizeTrimmedString(value) || null;
}

export function normalizeTrimmedStringArray(
  values: readonly unknown[] | undefined,
): string[] {
  return (values ?? [])
    .map((value) => normalizeTrimmedString(value))
    .filter(Boolean);
}

export function dedupeStrings(
  values: readonly unknown[] | undefined,
): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rawValue of values ?? []) {
    const value = String(rawValue || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

export function normalizeTrimmedUniqueStringArray(
  values: readonly unknown[] | undefined,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const entry = normalizeTrimmedString(value);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
  }
  return normalized;
}

export function normalizeOptionalTrimmedUniqueStringArray(
  value: unknown,
): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  return Array.isArray(value)
    ? normalizeTrimmedUniqueStringArray(value)
    : undefined;
}

export function normalizeTrimmedStringSet(
  values: readonly unknown[] | undefined,
): Set<string> {
  return new Set(normalizeTrimmedStringArray(values));
}
