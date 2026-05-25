import { compose, type Validator } from './validators';

/**
 * Returns the first validation error for `value`, or `null` if every rule
 * passes. Not a hook — no React state or refs are involved; it's a pure
 * function kept here for convenience at call sites that already import
 * from `field/`.
 */
export function validateField<T>(
  value: T,
  rules: ReadonlyArray<Validator<T> | undefined | false | null>,
): string | null {
  return compose(...rules)(value);
}
