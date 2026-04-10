import { expect, test } from 'vitest';

import { formatChannelGatewayFailure } from '../src/gateway/channel-gateway-failure.js';

test('formats interrupted channel gateway failures with the interrupted reply', () => {
  expect(
    formatChannelGatewayFailure(
      'timeout waiting for agent output',
      'Interrupted reply',
      'Transient reply',
    ),
  ).toBe('Interrupted reply');
});

test('formats transient channel gateway failures with the transient reply', () => {
  expect(
    formatChannelGatewayFailure(
      'fetch failed with ECONNRESET',
      'Interrupted reply',
      'Transient reply',
    ),
  ).toBe('Transient reply');
});

test('formats other channel gateway failures as a generic agent error', () => {
  expect(
    formatChannelGatewayFailure(
      'Permission denied',
      'Interrupted reply',
      'Transient reply',
    ),
  ).toBe('**Agent Error:** Permission denied');
  expect(
    formatChannelGatewayFailure('', 'Interrupted reply', 'Transient reply'),
  ).toBe('**Agent Error:** Unknown error');
});
