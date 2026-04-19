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
  vi.useRealTimers();
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
      { err: expect.any(Error) },
      'Discord client transport error (will reconnect automatically)',
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), shardId: 7 },
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
      { err: expect.any(Error) },
      'Unexpected Discord client error (reconnect may not recover automatically)',
    );
  });

  test('rate-limits repeated expected transport warnings and resumes later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T17:00:00Z'));

    const client = new FakeDiscordClient() as unknown as Client;
    attachDiscordTransportErrorHandlers(client);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      client.emit('error', new Error('socket hang up'));
    }

    expect(loggerMocks.warn).toHaveBeenCalledTimes(5);

    vi.setSystemTime(new Date('2026-04-19T17:01:01Z'));
    client.emit('error', new Error('socket hang up'));

    expect(loggerMocks.warn).toHaveBeenCalledTimes(6);
  });
});
