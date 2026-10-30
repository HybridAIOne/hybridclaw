/**
 * Deterministic JSON for content fingerprints: object key order is immaterial,
 * while array order and ordinary JSON value semantics are preserved.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry as Record<string, unknown>)
            .sort((left, right) => left.localeCompare(right))
            .map((key) => [key, (entry as Record<string, unknown>)[key]]),
        )
      : entry,
  );
}
