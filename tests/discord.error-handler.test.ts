import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/logger.ts', () => ({
  logger: loggerMocks,
}));

import { attachDiscordTransportErrorHandlers } from '../src/channels/discord/transport-errors.ts';

/**
 * Regression tests for transport errors bubbling out of Discord websocket
 * setup/reconnect paths. These failures are expected during normal network
 * churn and must be handled locally instead of surfacing as fatal process
 * exceptions.
 */
class FakeDiscordClient extends EventEmitter {}

afterEach(() => {
  loggerMocks.error.mockReset();
  loggerMocks.warn.mockReset();
  vi.restoreAllMocks();
});

describe('Discord client transport error handlers', () => {
  test('EventEmitter without error listener throws on error event', () => {
    const emitter = new EventEmitter();
    // Without a listener, emitting 'error' throws
    expect(() => emitter.emit('error', new Error('handshake timeout'))).toThrow(
      'handshake timeout',
    );
  });

  test('expected Discord transport errors are handled locally', () => {
    const client = new FakeDiscordClient() as unknown as Client;

    attachDiscordTransportErrorHandlers(client);

    expect(() =>
      client.emit('error', new Error('Opening handshake has timed out')),
    ).not.toThrow();
    expect(() =>
      client.emit('shardError', new Error('Opening handshake has timed out'), 7),
    ).not.toThrow();

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'Discord client transport error (will reconnect automatically)',
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      { error: expect.any(Error), shardId: 7 },
      'Discord shard transport error (will reconnect automatically)',
    );
  });

  test('unexpected Discord client errors stay at error level', () => {
    const client = new FakeDiscordClient() as unknown as Client;

    attachDiscordTransportErrorHandlers(client);

    expect(() =>
      client.emit('error', new Error('Discord parser exploded')),
    ).not.toThrow();

    expect(loggerMocks.error).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'Discord client transport error (will reconnect automatically)',
    );
  });
});
