/**
 * Required text payloads preserve exact strings, including intentional emptiness.
 * Unlike coercing readers, this rejects malformed values instead of implying
 * deletion; it grants no permission to write or overwrite a file.
 */
export function assertTextPayload(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string')
    throw new Error(
      `${field} must be a string; use an explicit empty string for an intentionally empty value`,
    );
}
