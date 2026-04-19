import type { Client } from 'discord.js';

import { logger } from '../../logger.js';
import { isExpectedTransportError } from '../../utils/transport-errors.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

const EXPECTED_TRANSPORT_WARN_WINDOW_MS = 60_000;
const EXPECTED_TRANSPORT_WARN_LIMIT = 5;

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
