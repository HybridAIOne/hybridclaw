import type { SecretRef } from './secret-refs.js';

const SECRET_HANDLE_BRAND: unique symbol = Symbol('SecretHandle');

export type SecretSinkKind = 'dom' | 'http' | 'unsafe';

export interface SecretHandle {
  readonly [SECRET_HANDLE_BRAND]: true;
  readonly ref: SecretRef;
  readonly id: string;
  readonly sinkKind: SecretSinkKind;
  dispose(): void;
}

type Assert<T extends true> = T;
export type SecretHandleCompileTimeGuards = {
  readonly notAssignableToString: Assert<
    SecretHandle extends string ? false : true
  >;
};

type SecretHandleInternal = SecretHandle & {
  unsafeRead(): string;
};

class RuntimeSecretHandle implements SecretHandleInternal {
  readonly [SECRET_HANDLE_BRAND] = true as const;
  readonly id: string;
  #buffer: Buffer | null;

  constructor(
    readonly ref: SecretRef,
    value: string,
    readonly sinkKind: SecretSinkKind,
  ) {
    this.id = ref.id;
    this.#buffer = Buffer.from(value, 'utf-8');
  }

  unsafeRead(): string {
    if (!this.#buffer) {
      throw new Error(
        `Secret handle ${this.ref.source}:${this.ref.id} was already disposed.`,
      );
    }
    return this.#buffer.toString('utf-8');
  }

  dispose(): void {
    this.#buffer?.fill(0);
    this.#buffer = null;
  }

  toString(): never {
    throw new Error(
      'SecretHandle cannot be string-coerced; use an audited injection API.',
    );
  }

  toJSON(): never {
    throw new Error(
      'SecretHandle cannot be JSON-stringified; use an audited injection API.',
    );
  }

  [Symbol.toPrimitive](): never {
    throw new Error(
      'SecretHandle cannot be coerced; use an audited injection API.',
    );
  }
}

export function createSecretHandle(
  ref: SecretRef,
  value: string,
  sinkKind: SecretSinkKind,
): SecretHandle {
  return new RuntimeSecretHandle(ref, value, sinkKind);
}

export function unsafeEscapeSecretHandle(
  handle: SecretHandle,
  opts: {
    reason: string;
    audit: (handle: SecretHandle, reason: string) => void;
  },
): string {
  opts.audit(handle, opts.reason);
  return (handle as SecretHandleInternal).unsafeRead();
}

export function withSecretHeader(
  handle: SecretHandle,
  headerName: string,
  opts: {
    prefix?: string;
    audit: (handle: SecretHandle, reason: string) => void;
    onCleartext?: (value: string) => void;
  },
): { name: string; value: string } {
  try {
    const secret = unsafeEscapeSecretHandle(handle, {
      reason: `inject secret into HTTP header ${headerName}`,
      audit: opts.audit,
    });
    opts.onCleartext?.(secret);
    const prefix = opts.prefix || '';
    return {
      name: headerName,
      value: prefix ? `${prefix} ${secret}` : secret,
    };
  } finally {
    handle.dispose();
  }
}
