import { describe, expect, test } from 'vitest';

import {
  isDiscordChannelId,
  resolveHeartbeatDeliveryChannelId,
  shouldDropQueuedProactiveMessage,
} from '../src/gateway/proactive-delivery.js';

describe('proactive delivery helpers', () => {
  test('recognizes Discord snowflake channel ids', () => {
    expect(isDiscordChannelId('123456789012345678')).toBe(true);
    expect(isDiscordChannelId('tui')).toBe(false);
    expect(isDiscordChannelId('heartbeat')).toBe(false);
  });

  test('heartbeat prefers explicit channel and otherwise uses last Discord channel', () => {
    expect(
      resolveHeartbeatDeliveryChannelId({
        explicitChannelId: '123456789012345678',
        lastUsedDiscordChannelId: '987654321098765432',
      }),
    ).toBe('123456789012345678');

    expect(
      resolveHeartbeatDeliveryChannelId({
        explicitChannelId: '   ',
        lastUsedDiscordChannelId: '987654321098765432',
      }),
    ).toBe('987654321098765432');

    expect(
      resolveHeartbeatDeliveryChannelId({
        explicitChannelId: '',
        lastUsedDiscordChannelId: null,
      }),
    ).toBeNull();
  });

  test('drops orphaned heartbeat queue rows but keeps other local queue entries', () => {
    expect(
      shouldDropQueuedProactiveMessage({
        channel_id: 'heartbeat',
        source: 'heartbeat',
      }),
    ).toBe(true);

    expect(
      shouldDropQueuedProactiveMessage({
        channel_id: 'tui',
        source: 'heartbeat',
      }),
    ).toBe(false);

    expect(
      shouldDropQueuedProactiveMessage({
        channel_id: 'heartbeat',
        source: 'delegate',
      }),
    ).toBe(false);
  });
});
