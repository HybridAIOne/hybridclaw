import { expect, test } from 'vitest';

import {
  DEFAULT_CHANNEL_INTERRUPTED_REPLY,
  DEFAULT_CHANNEL_TRANSIENT_FAILURE_REPLY,
  formatChannelGatewayFailure,
} from '../src/gateway/channel-gateway-failure.js';

test('formats interrupted channel gateway failures with the interrupted reply', () => {
  expect(
    formatChannelGatewayFailure(
      'timeout waiting for agent output',
      'Interrupted reply',
      'Transient reply',
    ),
  ).toBe('Interrupted reply');
  expect(formatChannelGatewayFailure('timeout waiting for agent output')).toBe(
    DEFAULT_CHANNEL_INTERRUPTED_REPLY,
  );
});

test('formats transient channel gateway failures with the transient reply', () => {
  expect(
    formatChannelGatewayFailure(
      'fetch failed with ECONNRESET',
      'Interrupted reply',
      'Transient reply',
    ),
  ).toBe('Transient reply');
  expect(formatChannelGatewayFailure('fetch failed with ECONNRESET')).toBe(
    DEFAULT_CHANNEL_TRANSIENT_FAILURE_REPLY,
  );
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
