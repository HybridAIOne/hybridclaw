import { describe, expect, test } from 'vitest';

import {
  describeExpectedTransportError,
  isExpectedTransportError,
} from '../src/utils/transport-errors.ts';

describe('isExpectedTransportError', () => {
  test('matches websocket handshake timeouts', () => {
    expect(
      isExpectedTransportError(new Error('Opening handshake has timed out')),
    ).toBe(true);
  });

  test('matches known transport error codes', () => {
    const error = Object.assign(new Error('connect failed'), {
      code: 'ETIMEDOUT',
    });
    expect(isExpectedTransportError(error)).toBe(true);
  });

  test('matches IMAP socket timeout errors', () => {
    const error = Object.assign(new Error('Socket timeout'), {
      code: 'ETIMEOUT',
    });
    expect(isExpectedTransportError(error)).toBe(true);
    expect(describeExpectedTransportError(error, 'Email IMAP')).toBe(
      'Email IMAP connection timed out.',
    );
  });

  test('matches nested transport causes', () => {
    const error = new Error('Discord shard error', {
      cause: new Error('socket hang up'),
    });
    expect(isExpectedTransportError(error)).toBe(true);
  });

  test('matches deeply nested transport causes', () => {
    const error = new Error('Discord shard error', {
      cause: new Error('Gateway reconnect failed', {
        cause: Object.assign(new Error('connect failed'), {
          code: 'ECONNRESET',
        }),
      }),
    });
    expect(isExpectedTransportError(error)).toBe(true);
  });

  test('matches transport errors nested inside errors arrays', () => {
    const error = {
      errors: [new Error('validation failed'), new Error('socket hang up')],
    };
    expect(isExpectedTransportError(error)).toBe(true);
  });

  test('ignores unrelated application errors', () => {
    expect(
      isExpectedTransportError(
        new Error('Cannot read properties of undefined'),
      ),
    ).toBe(false);
  });
});

describe('describeExpectedTransportError', () => {
  test('uses nested cause codes and hosts when the top-level error is generic', () => {
    const error = new Error('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND discord.com'), {
        code: 'ENOTFOUND',
        hostname: 'discord.com',
      }),
    });

    expect(describeExpectedTransportError(error, 'Discord API')).toBe(
      'Discord API DNS lookup failed for discord.com.',
    );
  });

  test('falls back to the provided host for generic transient fetch failures', () => {
    expect(
      describeExpectedTransportError(
        new Error('fetch failed'),
        'Observability ingest',
        'hybridai.one',
      ),
    ).toBe('Observability ingest is temporarily unavailable at hybridai.one.');
  });
});
