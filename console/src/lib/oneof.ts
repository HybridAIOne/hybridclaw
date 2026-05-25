/**
 * Narrow an untrusted string into one of the values from a literal-union
 * tuple, falling back when the input doesn't match. Lets callers carry a
 * typed union end-to-end without per-union helper functions.
 */
export function oneOfOr<T extends string>(
  allowed: ReadonlyArray<T>,
  value: string,
  fallback: T,
): T {
  return (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
}

export function isOneOf<T extends string>(
  allowed: ReadonlyArray<T>,
  value: string,
): value is T {
  return (allowed as ReadonlyArray<string>).includes(value);
}
