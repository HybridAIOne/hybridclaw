/**
 * Pino options shared by the gateway logger. The `err`/`error` serializers
 * drop `spawnargs` (the argv Node attaches to a failed spawn) from the logged
 * error. They do not scan messages or other fields for secrets; that is
 * `src/security/redact.ts`.
 */
import pino from 'pino';

export const LOGGER_ERROR_KEY = '_err';

export const LOGGER_PRETTY_OPTIONS = {
  colorize: true,
  colorizeObjects: false,
  errorLikeObjectKeys: [] as string[],
  singleLine: true,
  translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
};

function isDomException(value: Error): boolean {
  return value.constructor?.name === 'DOMException';
}

export function serializeErrorLike(value: unknown): unknown {
  if (value instanceof Error) {
    const serialized = pino.stdSerializers.err(value);
    // Child argv can carry credentials, e.g. `docker run -e NAME=value`.
    delete serialized.spawnargs;
    if (!isDomException(value)) return serialized;

    const code = (value as Error & { code?: unknown }).code;
    return {
      type: serialized.type,
      message: serialized.message,
      stack: serialized.stack,
      name: value.name,
      ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
    };
  }
  return value;
}

export const LOGGER_SERIALIZERS = {
  err: serializeErrorLike,
  error: serializeErrorLike,
};
