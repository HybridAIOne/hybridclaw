import type { Client } from 'discord.js';

import { logger } from '../../logger.js';
import {
  describeExpectedTransportError,
  isExpectedTransportError,
} from '../../utils/transport-errors.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

const EXPECTED_TRANSPORT_WARN_WINDOW_MS = 60_000;
const EXPECTED_TRANSPORT_WARN_LIMIT = 2;
const EXPECTED_API_WARN_WINDOW_MS = 60_000;
const EXPECTED_API_WARN_LIMIT = 5;

const expectedApiWarnLimiter = new SlidingWindowRateLimiter(
  EXPECTED_API_WARN_WINDOW_MS,
);

type DiscordLogLevel = 'debug' | 'warn';

function logAtLevel(
  level: DiscordLogLevel,
  bindings: Record<string, unknown>,
  message: string,
): void {
  if (level === 'debug') {
    logger.debug(bindings, message);
    return;
  }
  logger.warn(bindings, message);
}

function createDiscordTransportErrorLogger(): (
  error: unknown,
  expectedMessage: string,
  unexpectedMessage: string,
  metadata?: Record<string, unknown>,
) => void {
  const expectedTransportWarnLimiter = new SlidingWindowRateLimiter(
    EXPECTED_TRANSPORT_WARN_WINDOW_MS,
  );

  return (error, expectedMessage, unexpectedMessage, metadata) => {
    const bindings = metadata ? { ...metadata, err: error } : { err: error };
    if (isExpectedTransportError(error)) {
      // Rate-limit by error path, not shard id, so reconnect storms across
      // shards still collapse to a few warnings per minute.
      if (
        expectedTransportWarnLimiter.check(
          expectedMessage,
          EXPECTED_TRANSPORT_WARN_LIMIT,
        ).allowed
      ) {
        logger.warn(bindings, expectedMessage);
      }
      return;
    }
    logger.error(bindings, unexpectedMessage);
  };
}

export function logDiscordApiError(params: {
  error: unknown;
  expectedAction: string;
  unexpectedMessage: string;
  metadata?: Record<string, unknown>;
  level?: DiscordLogLevel;
}): void {
  const level = params.level ?? 'warn';
  if (isExpectedTransportError(params.error)) {
    if (
      level === 'warn' &&
      !expectedApiWarnLimiter.check(
        params.expectedAction,
        EXPECTED_API_WARN_LIMIT,
      ).allowed
    ) {
      return;
    }

    logAtLevel(
      level,
      params.metadata ?? {},
      `${describeExpectedTransportError(params.error, 'Discord API', 'discord.com')} ${params.expectedAction}`,
    );
    return;
  }

  const bindings = params.metadata
    ? { ...params.metadata, err: params.error }
    : { err: params.error };
  if (level === 'debug') {
    logger.debug(bindings, params.unexpectedMessage);
    return;
  }
  logger.warn(bindings, params.unexpectedMessage);
}

export function attachDiscordTransportErrorHandlers(client: Client): void {
  const logDiscordTransportError = createDiscordTransportErrorLogger();

  client.on('error', (error) => {
    logDiscordTransportError(
      error,
      'Discord client transport error (will reconnect automatically)',
      'Unexpected Discord client error (reconnect may not recover automatically)',
    );
  });

  client.on('shardError', (error, shardId) => {
    logDiscordTransportError(
      error,
      'Discord shard transport error (will reconnect automatically)',
      'Unexpected Discord shard error (reconnect may not recover automatically)',
      { shardId },
    );
  });
}
