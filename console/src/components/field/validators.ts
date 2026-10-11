export type Validator<T> = (value: T) => string | null;

// Stateless singletons for the default-message case — these are by far the
// most common usage, and returning a cached function spares per-render
// allocation across pages that wire up dozens of validators.
const requiredDefault: Validator<unknown> = (value) => {
  if (value === null || value === undefined) return 'Required.';
  if (typeof value === 'string' && value.trim() === '') return 'Required.';
  return null;
};

export function required<T>(message?: string): Validator<T> {
  if (message === undefined) return requiredDefault as Validator<T>;
  return (value) => {
    if (value === null || value === undefined) return message;
    if (typeof value === 'string' && value.trim() === '') return message;
    return null;
  };
}

export function compose<T>(
  ...validators: ReadonlyArray<Validator<T> | undefined | false | null>
): Validator<T> {
  const active = validators.filter(
    (v): v is Validator<T> => typeof v === 'function',
  );
  return (value) => {
    for (const validate of active) {
      const error = validate(value);
      if (error) return error;
    }
    return null;
  };
}
