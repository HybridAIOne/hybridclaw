import type { Client } from 'discord.js';

import { logger } from '../../logger.js';
import { isExpectedTransportError } from '../../utils/transport-errors.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

const EXPECTED_TRANSPORT_WARN_WINDOW_MS = 60_000;
const EXPECTED_TRANSPORT_WARN_LIMIT = 5;

function createDiscordTransportErrorLogger(): (
  error: unknown,
  message: string,
  metadata?: Record<string, unknown>,
) => void {
  const expectedTransportWarnLimiter = new SlidingWindowRateLimiter(
    EXPECTED_TRANSPORT_WARN_WINDOW_MS,
  );

  return (error, message, metadata) => {
    const bindings = metadata ? { ...metadata, err: error } : { err: error };
    if (isExpectedTransportError(error)) {
      // Rate-limit by error path, not shard id, so reconnect storms across
      // shards still collapse to a few warnings per minute.
      if (
        expectedTransportWarnLimiter.check(
          message,
          EXPECTED_TRANSPORT_WARN_LIMIT,
        ).allowed
      ) {
        logger.warn(bindings, message);
      }
      return;
    }
    logger.error(bindings, message);
  };
}

export function attachDiscordTransportErrorHandlers(client: Client): void {
  const logDiscordTransportError = createDiscordTransportErrorLogger();

  client.on('error', (error) => {
    logDiscordTransportError(
      error,
      'Discord client transport error (will reconnect automatically)',
    );
  });

  client.on('shardError', (error, shardId) => {
    logDiscordTransportError(
      error,
      'Discord shard transport error (will reconnect automatically)',
      { shardId },
    );
  });
}
