import { compose, type Validator } from './validators';

/**
 * Returns the first validation error for `value`, or `null` if every rule
 * passes. Recomputed on each render — cheap because validation is just a
 * couple of comparisons, and skipping `useMemo` avoids the deps-array
 * fragility from a spread of rule references that change every render.
 */
export function useFieldError<T>(
  value: T,
  rules: ReadonlyArray<Validator<T> | undefined | false | null>,
): string | null {
  return compose(...rules)(value);
}
