import { describe, expect, test } from 'vitest';

import { isExpectedTransportError } from '../src/utils/transport-errors.ts';

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

  test('matches nested transport causes', () => {
    const error = new Error('Discord shard error', {
      cause: new Error('socket hang up'),
    });
    expect(isExpectedTransportError(error)).toBe(true);
  });

  test('ignores unrelated application errors', () => {
    expect(
      isExpectedTransportError(new Error("Cannot read properties of undefined")),
    ).toBe(false);
  });
});
