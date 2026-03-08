import pino from 'pino';

export const LOGGER_ERROR_KEY = '_err';

export const LOGGER_PRETTY_OPTIONS = {
  colorize: true,
  colorizeObjects: false,
  errorLikeObjectKeys: [] as string[],
  singleLine: true,
};

export function serializeErrorLike(value: unknown): unknown {
  if (value instanceof Error) {
    return pino.stdSerializers.err(value);
  }
  return value;
}

export const LOGGER_SERIALIZERS = {
  err: serializeErrorLike,
  error: serializeErrorLike,
};
