export type Validator<T> = (value: T) => string | null;

// Each `make*` holds the single copy of the validation logic. The
// default-message case is cached as a stateless singleton — by far the most
// common usage — sparing per-render allocation across pages that wire up
// dozens of validators.
function makeRequired(message: string): Validator<unknown> {
  return (value) => {
    if (value === null || value === undefined) return message;
    if (typeof value === 'string' && value.trim() === '') return message;
    return null;
  };
}

const requiredDefault = makeRequired('Required.');

export function required<T>(message?: string): Validator<T> {
  return (
    message === undefined ? requiredDefault : makeRequired(message)
  ) as Validator<T>;
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

function makeUrl(message: string): Validator<string> {
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

const urlDefault = makeUrl('Enter a valid URL.');

export function url(message?: string): Validator<string> {
  return message === undefined ? urlDefault : makeUrl(message);
}

function makeLoopbackUrl(message: string): Validator<string> {
  return (value) => {
    if (value.trim() === '') return null;
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1'
        ? null
        : message;
    } catch {
      // A value that doesn't parse is reported as a malformed URL regardless
      // of the (loopback-specific) override message.
      return 'Enter a valid URL.';
    }
  };
}

const loopbackUrlDefault = makeLoopbackUrl('Must be a loopback URL.');

export function loopbackUrl(message?: string): Validator<string> {
  return message === undefined ? loopbackUrlDefault : makeLoopbackUrl(message);
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
