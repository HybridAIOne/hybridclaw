/**
 * Schema builders for contract data: one definition yields the runtime check
 * and, through `Infer`, the TypeScript type, so the two cannot drift apart.
 *
 * A check only accepts or rejects. It never coerces, defaults, or strips
 * fields, unknown keys pass (a newer peer may send more), and it reports no
 * reason, so a rejected payload is never echoed into logs. NOT a normalizer for
 * config files with lenient migration rules; those keep their own readers.
 */

export interface Schema<T> {
  readonly check: (value: unknown) => value is T;
}

export interface OptionalSchema<T> extends Schema<T> {
  readonly optional: true;
}

export interface ObjectSchema<P extends Shape> extends Schema<InferObject<P>> {
  readonly shape: P;
}

export type Shape = Record<string, Schema<unknown>>;

export type Infer<S> = S extends Schema<infer T> ? T : never;

type OptionalKeys<P extends Shape> = {
  [K in keyof P]: P[K] extends OptionalSchema<unknown> ? K : never;
}[keyof P];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferObject<P extends Shape> = Simplify<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> } & {
    [K in OptionalKeys<P>]?: Infer<P[K]>;
  }
>;

function schema<T>(check: (value: unknown) => boolean): Schema<T> {
  return { check: check as (value: unknown) => value is T };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function string(): Schema<string> {
  return schema((value) => typeof value === 'string');
}

/** Finite numbers only: JSON cannot carry NaN or Infinity. */
export function number(): Schema<number> {
  return schema((value) => typeof value === 'number' && Number.isFinite(value));
}

export function boolean(): Schema<boolean> {
  return schema((value) => typeof value === 'boolean');
}

export function literal<const V extends readonly (string | number | boolean)[]>(
  ...values: V
): Schema<V[number]> {
  return schema((value) => values.includes(value as V[number]));
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return schema((value) => value === null || inner.check(value));
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return schema((value) => Array.isArray(value) && value.every(item.check));
}

export function record<T>(item: Schema<T>): Schema<Record<string, T>> {
  return schema(
    (value) => isPlainObject(value) && Object.values(value).every(item.check),
  );
}

export function union<const S extends readonly Schema<unknown>[]>(
  ...members: S
): Schema<Infer<S[number]>> {
  return schema((value) => members.some((member) => member.check(value)));
}

/** A field that may be absent; `undefined` counts as absent, as in JSON. */
export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return { check: inner.check, optional: true };
}

export function object<P extends Shape>(shape: P): ObjectSchema<P> {
  const fields = Object.entries(shape);
  return {
    shape,
    check: ((value: unknown) =>
      isPlainObject(value) &&
      fields.every(([key, field]) =>
        value[key] === undefined
          ? 'optional' in field
          : field.check(value[key]),
      )) as (value: unknown) => value is InferObject<P>,
  };
}

/** Narrows an accepted value further, e.g. with a validator from elsewhere. */
export function refine<T>(
  inner: Schema<T>,
  accept: (value: T) => boolean,
): Schema<T> {
  return schema((value) => inner.check(value) && accept(value));
}

/**
 * Accepts any value as `T`: for data whose shape another module owns and
 * checks, such as tool history. Pair it with `refine` where a check exists.
 */
export function unchecked<T>(): Schema<T> {
  return schema(() => true);
}
