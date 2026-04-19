import type { Client } from 'discord.js';

import { logger } from '../../logger.js';
import { isExpectedTransportError } from '../../utils/transport-errors.js';

function logDiscordTransportError(
  error: unknown,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  const bindings = metadata ? { ...metadata, error } : { error };
  if (isExpectedTransportError(error)) {
    logger.warn(bindings, message);
    return;
  }
  logger.error(bindings, message);
}

export function attachDiscordTransportErrorHandlers(client: Client): void {
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
