import {
  isRuntimeSecretName,
  readStoredRuntimeSecret,
} from './runtime-secrets.js';
import {
  createSecretHandle,
  type SecretHandle,
  type SecretSinkKind,
  unsafeEscapeSecretHandle,
} from './secret-handles.js';

const ENV_SECRET_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export type EnvSecretRef = {
  source: 'env';
  id: string;
};

export type StoreSecretRef = {
  source: 'store';
  id: string;
};

export type SecretRef = EnvSecretRef | StoreSecretRef;
export type SecretInput = string | SecretRef;

type ParsedSecretInput =
  | { kind: 'plain' }
  | { kind: 'ref'; ref: SecretRef }
  | { kind: 'invalid'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEnvSecretId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseSecretInput(value: unknown): ParsedSecretInput {
  if (typeof value === 'string') {
    const match = value.trim().match(ENV_SECRET_REF_PATTERN);
    if (!match) return { kind: 'plain' };
    return {
      kind: 'ref',
      ref: {
        source: 'env',
        id: match[1] || '',
      },
    };
  }

  if (!isRecord(value) || typeof value.source !== 'string') {
    return { kind: 'plain' };
  }

  if (value.source === 'env') {
    if (!isValidEnvSecretId(value.id)) {
      return {
        kind: 'invalid',
        reason:
          'must use `{ "source": "env", "id": "ENV_VAR_NAME" }` with a valid environment variable name',
      };
    }
    return {
      kind: 'ref',
      ref: {
        source: 'env',
        id: value.id,
      },
    };
  }

  if (value.source === 'store') {
    if (typeof value.id !== 'string' || !isRuntimeSecretName(value.id)) {
      return {
        kind: 'invalid',
        reason:
          'must use `{ "source": "store", "id": "SECRET_NAME" }` with an uppercase secret name',
      };
    }
    return {
      kind: 'ref',
      ref: {
        source: 'store',
        id: value.id,
      },
    };
  }

  return {
    kind: 'invalid',
    reason: `uses unsupported secret source "${value.source}"`,
  };
}

function describeSecretRef(ref: SecretRef): string {
  if (ref.source === 'env') {
    return `environment variable ${ref.id}`;
  }
  return `stored secret ${ref.id}`;
}

export function resolveSecretInput(
  value: unknown,
  opts: {
    path: string;
    required?: boolean;
    sinkKind?: SecretSinkKind;
  },
): string | SecretHandle | undefined {
  const parsed = parseSecretInput(value);
  if (parsed.kind === 'invalid') {
    throw new Error(`${opts.path} ${parsed.reason}`);
  }
  if (parsed.kind === 'plain') {
    return typeof value === 'string' ? value : undefined;
  }

  const resolved =
    parsed.ref.source === 'env'
      ? String(process.env[parsed.ref.id] || '').trim()
      : readStoredRuntimeSecret(parsed.ref.id) || '';

  if (!resolved && opts.required) {
    throw new Error(
      `${opts.path} references ${describeSecretRef(parsed.ref)} but it is not set`,
    );
  }

  return createSecretHandle(parsed.ref, resolved, opts.sinkKind || 'unsafe');
}

export function resolveSecretHandleInput(
  value: unknown,
  opts: {
    path: string;
    required?: boolean;
    sinkKind: SecretSinkKind;
  },
): SecretHandle | undefined {
  const resolved = resolveSecretInput(value, opts);
  return typeof resolved === 'string' ? undefined : resolved;
}

export function resolveSecretInputUnsafe(
  value: unknown,
  opts: {
    path: string;
    required?: boolean;
    reason: string;
    audit: (handle: SecretHandle, reason: string) => void;
  },
): string | undefined {
  const resolved = resolveSecretInput(value, {
    path: opts.path,
    required: opts.required,
    sinkKind: 'unsafe',
  });
  if (!resolved || typeof resolved === 'string') return resolved;
  return unsafeEscapeSecretHandle(resolved, {
    reason: opts.reason,
    audit: opts.audit,
  });
}

export function isSecretRefInput(value: unknown): value is SecretRef {
  return parseSecretInput(value).kind === 'ref';
}
