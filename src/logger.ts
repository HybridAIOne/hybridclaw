import pino from 'pino';

import { getRuntimeConfig, onRuntimeConfigChange } from './runtime-config.js';

const initialLevel = getRuntimeConfig().ops.logLevel;

export const logger = pino({
  level: initialLevel,
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

onRuntimeConfigChange((next, prev) => {
  if (next.ops.logLevel !== prev.ops.logLevel) {
    logger.level = next.ops.logLevel;
    logger.info({ level: next.ops.logLevel }, 'Logger level updated from config.json');
  }
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
