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

const urlDefault: Validator<string> = (value) => {
  if (value.trim() === '') return null;
  try {
    new URL(value);
    return null;
  } catch {
    return 'Enter a valid URL.';
  }
};

export function url(message?: string): Validator<string> {
  if (message === undefined) return urlDefault;
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

const loopbackUrlDefault: Validator<string> = (value) => {
  if (value.trim() === '') return null;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
      ? null
      : 'Must be a loopback URL.';
  } catch {
    return 'Enter a valid URL.';
  }
};

export function loopbackUrl(message?: string): Validator<string> {
  if (message === undefined) return loopbackUrlDefault;
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
