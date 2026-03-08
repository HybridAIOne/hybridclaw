import pino from 'pino';

import {
  getRuntimeConfig,
  onRuntimeConfigChange,
} from './config/runtime-config.js';
import {
  LOGGER_ERROR_KEY,
  LOGGER_PRETTY_OPTIONS,
  LOGGER_SERIALIZERS,
} from './logger-format.js';

const VALID_LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

function resolveForcedLogLevel():
  | ReturnType<typeof getRuntimeConfig>['ops']['logLevel']
  | null {
  const raw = String(process.env.HYBRIDCLAW_FORCE_LOG_LEVEL || '')
    .trim()
    .toLowerCase();
  if (!raw || !VALID_LOG_LEVELS.has(raw)) return null;
  return raw as ReturnType<typeof getRuntimeConfig>['ops']['logLevel'];
}

const forcedLevel = resolveForcedLogLevel();
const initialLevel = forcedLevel || getRuntimeConfig().ops.logLevel;

export const logger = pino({
  errorKey: LOGGER_ERROR_KEY,
  level: initialLevel,
  serializers: LOGGER_SERIALIZERS,
  transport: { target: 'pino-pretty', options: LOGGER_PRETTY_OPTIONS },
});

if (forcedLevel) {
  logger.info(
    { level: forcedLevel },
    'Logger level forced by HYBRIDCLAW_FORCE_LOG_LEVEL',
  );
}

onRuntimeConfigChange((next, prev) => {
  if (forcedLevel) {
    if (next.ops.logLevel !== prev.ops.logLevel) {
      logger.debug(
        {
          configuredLevel: next.ops.logLevel,
          forcedLevel,
        },
        'Ignoring runtime config log-level change due to forced override',
      );
    }
    return;
  }
  if (next.ops.logLevel !== prev.ops.logLevel) {
    logger.level = next.ops.logLevel;
    logger.info(
      { level: next.ops.logLevel },
      'Logger level updated from runtime config',
    );
  }
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
