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
import { captureSentryException } from './observability/sentry.js';
import { SlidingWindowRateLimiter } from './utils/rate-limiter.js';
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
const EXPECTED_TRANSPORT_PROCESS_WARN_WINDOW_MS = 60_000;
const EXPECTED_TRANSPORT_PROCESS_WARN_LIMIT = 2;
const expectedTransportProcessWarnLimiter = new SlidingWindowRateLimiter(
  EXPECTED_TRANSPORT_PROCESS_WARN_WINDOW_MS,
);

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
const stdoutMirrorsGatewayLog =
  String(process.env.HYBRIDCLAW_GATEWAY_STDIO_TO_LOG || '').trim() === '1';
const gatewayLogFile = stdoutMirrorsGatewayLog
  ? ''
  : String(process.env.HYBRIDCLAW_GATEWAY_LOG_FILE || '').trim();
let loggerOutput: ReturnType<typeof pino.multistream> | null = null;
let gatewayLogFileMirrorPath: string | null = null;

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

function createGatewayLogFileDestination(
  logFile: string,
): NodeJS.WritableStream {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fileStream = fs.createWriteStream(logFile, { flags: 'a' });
  return createPrettyDestination(
    {
      ...LOGGER_PRETTY_OPTIONS,
      colorize: false,
    },
    fileStream,
  );
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
      stream: createPrettyDestination(
        {
          ...LOGGER_PRETTY_OPTIONS,
          colorize: stdoutMirrorsGatewayLog
            ? false
            : LOGGER_PRETTY_OPTIONS.colorize,
        },
        process.stdout,
      ),
    },
  ];

  if (gatewayLogFile) {
    gatewayLogFileMirrorPath = path.resolve(gatewayLogFile);
    streams.push({
      level: 'trace',
      stream: createGatewayLogFileDestination(gatewayLogFile),
    });
  }

  loggerOutput = pino.multistream(streams);
  return pino(options, loggerOutput);
}

export const logger = createLogger();

export function enableGatewayLogFileMirror(logFile: string): void {
  const trimmed = logFile.trim();
  if (!trimmed) return;
  const normalized = path.resolve(trimmed);
  if (gatewayLogFileMirrorPath === normalized) return;
  if (gatewayLogFileMirrorPath) {
    logger.warn(
      { configuredPath: gatewayLogFileMirrorPath, requestedPath: normalized },
      'Gateway log file mirror already configured; ignoring new path',
    );
    return;
  }
  if (!loggerOutput) {
    throw new Error('Logger output stream is not initialized.');
  }

  loggerOutput.add({
    level: 'trace',
    stream: createGatewayLogFileDestination(normalized),
  });
  gatewayLogFileMirrorPath = normalized;
}

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

export function setLoggerStartupLevel(
  level: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'],
): void {
  if (!VALID_LOG_LEVELS.has(level)) {
    throw new Error(`Invalid log level: ${level}`);
  }
  if (forcedLevel) return;
  logger.level = level;
  logger.debug({ level }, 'Logger level set by startup flag');
}

export function syncLoggerLevelFromRuntimeConfig(reason: string): void {
  if (forcedLevel) {
    logger.debug(
      {
        configuredLevel: getRuntimeConfig().ops.logLevel,
        forcedLevel,
        reason,
      },
      'Ignoring runtime config log-level sync due to forced override',
    );
    return;
  }

  const level = getRuntimeConfig().ops.logLevel;
  if (logger.level === level) return;
  logger.level = level;
  logger.info({ level, reason }, 'Logger level updated from runtime config');
}

export function getLoggerRuntimeState(): {
  configuredLevel: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'];
  effectiveLevel: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'];
  forcedLevel: ReturnType<typeof getRuntimeConfig>['ops']['logLevel'] | null;
} {
  return {
    configuredLevel: getRuntimeConfig().ops.logLevel,
    effectiveLevel: logger.level as ReturnType<
      typeof getRuntimeConfig
    >['ops']['logLevel'],
    forcedLevel,
  };
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
    syncLoggerLevelFromRuntimeConfig('runtime-config-change');
  }
});

const PROCESS_HANDLER_REGISTRATION_KEY = Symbol.for(
  'hybridclaw.logger.process-handler-registration',
);
const UNCAUGHT_EXCEPTION_HANDLER_TAG = Symbol.for(
  'hybridclaw.logger.uncaught-exception-handler',
);
const UNHANDLED_REJECTION_HANDLER_TAG = Symbol.for(
  'hybridclaw.logger.unhandled-rejection-handler',
);

interface ProcessHandlerRegistrationState {
  uncaughtException: boolean;
  unhandledRejection: boolean;
}

function getProcessHandlerRegistrationState(): ProcessHandlerRegistrationState {
  const target = process as NodeJS.Process & {
    [PROCESS_HANDLER_REGISTRATION_KEY]?: ProcessHandlerRegistrationState;
  };
  if (target[PROCESS_HANDLER_REGISTRATION_KEY]) {
    return target[PROCESS_HANDLER_REGISTRATION_KEY];
  }
  const state: ProcessHandlerRegistrationState = {
    uncaughtException: false,
    unhandledRejection: false,
  };
  target[PROCESS_HANDLER_REGISTRATION_KEY] = state;
  return state;
}

function getExpectedTransportProcessWarningKey(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const candidate = error as {
    code?: unknown;
    message?: unknown;
  };
  const code =
    typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  const message =
    typeof candidate.message === 'string'
      ? candidate.message.slice(0, 200)
      : '';
  return [code, message].filter(Boolean).join(':') || 'transport-error';
}

function shouldLogExpectedTransportProcessWarning(error: unknown): boolean {
  return expectedTransportProcessWarnLimiter.check(
    getExpectedTransportProcessWarningKey(error),
    EXPECTED_TRANSPORT_PROCESS_WARN_LIMIT,
  ).allowed;
}

function uncaughtExceptionHandler(err: Error) {
  if (isExpectedTransportError(err)) {
    if (shouldLogExpectedTransportProcessWarning(err)) {
      logger.warn(
        { err },
        'Uncaught transport exception escaped local handler; keeping process alive',
      );
    }
    return;
  }

  logger.fatal({ err }, 'Uncaught exception');
  captureSentryException(err, {
    mechanism: 'process.uncaughtException',
  });
  process.exit(1);
}
(
  uncaughtExceptionHandler as typeof uncaughtExceptionHandler & {
    [UNCAUGHT_EXCEPTION_HANDLER_TAG]?: true;
  }
)[UNCAUGHT_EXCEPTION_HANDLER_TAG] = true;

function unhandledRejectionHandler(reason: unknown) {
  if (isExpectedTransportError(reason)) {
    if (shouldLogExpectedTransportProcessWarning(reason)) {
      logger.warn(
        { err: reason },
        'Unhandled transport rejection escaped local handler; keeping process alive',
      );
    }
    return;
  }

  logger.error({ err: reason }, 'Unhandled rejection');
  captureSentryException(reason, {
    mechanism: 'process.unhandledRejection',
  });
}
(
  unhandledRejectionHandler as typeof unhandledRejectionHandler & {
    [UNHANDLED_REJECTION_HANDLER_TAG]?: true;
  }
)[UNHANDLED_REJECTION_HANDLER_TAG] = true;

const processHandlerRegistrationState = getProcessHandlerRegistrationState();

if (!processHandlerRegistrationState.uncaughtException) {
  process.on('uncaughtException', uncaughtExceptionHandler);
  processHandlerRegistrationState.uncaughtException = true;
}

if (!processHandlerRegistrationState.unhandledRejection) {
  process.on('unhandledRejection', unhandledRejectionHandler);
  processHandlerRegistrationState.unhandledRejection = true;
}

export function removeLoggerProcessHandlersForTests(): void {
  for (const listener of process.listeners('uncaughtException')) {
    if (
      (listener as { [UNCAUGHT_EXCEPTION_HANDLER_TAG]?: true })[
        UNCAUGHT_EXCEPTION_HANDLER_TAG
      ]
    ) {
      process.removeListener(
        'uncaughtException',
        listener as (error: Error) => void,
      );
    }
  }

  for (const listener of process.listeners('unhandledRejection')) {
    if (
      (listener as { [UNHANDLED_REJECTION_HANDLER_TAG]?: true })[
        UNHANDLED_REJECTION_HANDLER_TAG
      ]
    ) {
      process.removeListener(
        'unhandledRejection',
        listener as (reason: unknown) => void,
      );
    }
  }

  const state = getProcessHandlerRegistrationState();
  state.uncaughtException = false;
  state.unhandledRejection = false;
}

export const handleUncaughtExceptionForTests = uncaughtExceptionHandler;
export const handleUnhandledRejectionForTests = unhandledRejectionHandler;
