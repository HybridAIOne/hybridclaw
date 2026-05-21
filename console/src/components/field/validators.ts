export type Validator<T> = (value: T) => string | null;

export function required<T>(message = 'Required.'): Validator<T> {
  return (value) => {
    if (value === null || value === undefined) return message;
    if (typeof value === 'string' && value.trim() === '') return message;
    return null;
  };
}

export function pattern(re: RegExp, message: string): Validator<string> {
  return (value) => (re.test(value) ? null : message);
}

export function minLength(n: number, message?: string): Validator<string> {
  return (value) =>
    value.length >= n
      ? null
      : (message ?? `Must be at least ${n} character${n === 1 ? '' : 's'}.`);
}

export function maxLength(n: number, message?: string): Validator<string> {
  return (value) =>
    value.length <= n
      ? null
      : (message ?? `Must be at most ${n} character${n === 1 ? '' : 's'}.`);
}

export function oneOf<T>(
  allowed: readonly T[],
  message = 'Invalid value.',
): Validator<T> {
  return (value) => (allowed.includes(value) ? null : message);
}

export function url(message = 'Enter a valid URL.'): Validator<string> {
  return (value) => {
    if (value.trim() === '') return null;
    try {
      new URL(value);
      return null;
    } catch {
      return message;
    }
  };
}

export function loopbackUrl(
  message = 'Must be a loopback URL.',
): Validator<string> {
  return (value) => {
    if (value.trim() === '') return null;
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1'
        ? null
        : message;
    } catch {
      return 'Enter a valid URL.';
    }
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
