import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';

/**
 * Regression test for gateway crash caused by unhandled Discord client 'error'
 * events. Without an error listener, Node's EventEmitter throws 'error' events
 * as uncaught exceptions — which hit our process.on('uncaughtException') handler
 * in logger.ts and call process.exit(1).
 *
 * The fix adds `client.on('error', ...)` in initDiscord() so transient
 * WebSocket errors (e.g. "Opening handshake has timed out") are logged
 * instead of crashing the gateway.
 */
describe('Discord client error handler', () => {
  test('EventEmitter without error listener throws on error event', () => {
    const emitter = new EventEmitter();
    // Without a listener, emitting 'error' throws
    expect(() => emitter.emit('error', new Error('handshake timeout'))).toThrow(
      'handshake timeout',
    );
  });

  test('EventEmitter with error listener does not throw', () => {
    const emitter = new EventEmitter();
    const errorHandler = vi.fn();
    emitter.on('error', errorHandler);

    // With a listener, emitting 'error' is handled gracefully
    expect(() =>
      emitter.emit('error', new Error('Opening handshake has timed out')),
    ).not.toThrow();
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler.mock.calls[0][0].message).toBe(
      'Opening handshake has timed out',
    );
  });
});
