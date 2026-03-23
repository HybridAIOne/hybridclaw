export function normalizeTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeTrimmedStringArray(
  values: readonly unknown[] | undefined,
): string[] {
  return (values ?? [])
    .map((value) => normalizeTrimmedString(value))
    .filter(Boolean);
}

export function normalizeTrimmedStringSet(
  values: readonly unknown[] | undefined,
): Set<string> {
  return new Set(normalizeTrimmedStringArray(values));
}
