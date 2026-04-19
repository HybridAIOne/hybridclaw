import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import pretty from 'pino-pretty';

import {
  getRuntimeConfig,
  onRuntimeConfigChange,
} from './config/runtime-config.js';
import {
  LOGGER_ERROR_KEY,
  LOGGER_PRETTY_OPTIONS,
  LOGGER_SERIALIZERS,
} from './logger-format.js';
import { getTraceContext } from './observability/otel.js';
import { isExpectedTransportError } from './utils/transport-errors.js';

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

let forcedLevel = resolveForcedLogLevel();
const initialLevel = forcedLevel || getRuntimeConfig().ops.logLevel;
const gatewayLogFile = String(
  process.env.HYBRIDCLAW_GATEWAY_LOG_FILE || '',
).trim();

function createPrettyDestination(
  prettyOptions: typeof LOGGER_PRETTY_OPTIONS,
  destination: NodeJS.WritableStream,
): Writable {
  const render = pretty.prettyFactory(prettyOptions);
  return new Writable({
    write(chunk, _encoding, callback) {
      let formatted = '';
      try {
        formatted = render(chunk.toString('utf-8')) || '';
      } catch (error) {
        callback(error as Error);
        return;
      }

      if (!formatted) {
        callback();
        return;
      }

      if (destination.write(formatted)) {
        callback();
        return;
      }

      destination.once('drain', callback);
    },
  });
}

function createLogger() {
  const options = {
    errorKey: LOGGER_ERROR_KEY,
    level: initialLevel,
    serializers: LOGGER_SERIALIZERS,
    mixin() {
      const { traceId, spanId } = getTraceContext();
      if (traceId) return { traceId, spanId };
      return {};
    },
  };
  const streams: Array<{ level: 'trace'; stream: NodeJS.WritableStream }> = [
    {
      level: 'trace',
      stream: createPrettyDestination(LOGGER_PRETTY_OPTIONS, process.stdout),
    },
  ];

  if (gatewayLogFile) {
    fs.mkdirSync(path.dirname(gatewayLogFile), { recursive: true });
    const fileStream = fs.createWriteStream(gatewayLogFile, { flags: 'a' });
    streams.push({
      level: 'trace',
      stream: createPrettyDestination(
        {
          ...LOGGER_PRETTY_OPTIONS,
          colorize: false,
        },
        fileStream,
      ),
    });
  }

  return pino(options, pino.multistream(streams));
}

export const logger = createLogger();

if (forcedLevel) {
  logger.debug(
    { forcedLevel },
    'Logger level forced by HYBRIDCLAW_FORCE_LOG_LEVEL',
  );
}

export function forceLoggerLevel(
  level: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'],
): void {
  if (!VALID_LOG_LEVELS.has(level)) {
    throw new Error(`Invalid log level: ${level}`);
  }
  forcedLevel = level;
  logger.level = level;
  logger.debug({ forcedLevel: level }, 'Logger level forced programmatically');
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

// Keep registration state on `process` so module reloads in tests
// (vi.resetModules + dynamic import) do not append duplicate listeners.
const PROCESS_HANDLER_REGISTRATION_KEY = Symbol.for(
  'hybridclaw.logger.process-handler-registration',
);

interface ProcessHandlerRegistrationState {
  uncaughtExceptionHandler: ((err: Error) => void) | null;
  unhandledRejectionHandler: ((reason: unknown) => void) | null;
}

function getProcessHandlerRegistrationState(): ProcessHandlerRegistrationState {
  const target = process as NodeJS.Process & {
    [PROCESS_HANDLER_REGISTRATION_KEY]?: ProcessHandlerRegistrationState;
  };
  if (target[PROCESS_HANDLER_REGISTRATION_KEY]) {
    return target[PROCESS_HANDLER_REGISTRATION_KEY];
  }
  const state: ProcessHandlerRegistrationState = {
    uncaughtExceptionHandler: null,
    unhandledRejectionHandler: null,
  };
  target[PROCESS_HANDLER_REGISTRATION_KEY] = state;
  return state;
}

function uncaughtExceptionHandler(err: Error) {
  if (isExpectedTransportError(err)) {
    logger.warn(
      { err },
      'Handled expected transport exception without exiting',
    );
    return;
  }
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
}

function unhandledRejectionHandler(reason: unknown) {
  logger.error({ err: reason }, 'Unhandled rejection');
}

const processHandlerRegistrationState = getProcessHandlerRegistrationState();

if (!processHandlerRegistrationState.uncaughtExceptionHandler) {
  process.on('uncaughtException', uncaughtExceptionHandler);
  processHandlerRegistrationState.uncaughtExceptionHandler =
    uncaughtExceptionHandler;
}

if (!processHandlerRegistrationState.unhandledRejectionHandler) {
  process.on('unhandledRejection', unhandledRejectionHandler);
  processHandlerRegistrationState.unhandledRejectionHandler =
    unhandledRejectionHandler;
}
