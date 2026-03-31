import { describe, expect, test } from 'vitest';

import {
  hasQueuedProactiveDeliveryPath,
  isDiscordChannelId,
  isEmailAddress,
  isSupportedProactiveChannelId,
  resolveHeartbeatDeliveryChannelId,
  shouldDropQueuedProactiveMessage,
} from '../src/gateway/proactive-delivery.js';

describe('proactive delivery helpers', () => {
  test('recognizes Discord snowflake channel ids', () => {
    expect(isDiscordChannelId('123456789012345678')).toBe(true);
    expect(isDiscordChannelId('tui')).toBe(false);
    expect(isDiscordChannelId('heartbeat')).toBe(false);
  });

  test('heartbeat prefers explicit channel and otherwise uses the last delivery channel', () => {
    expect(
      resolveHeartbeatDeliveryChannelId({
        explicitChannelId: '123456789012345678',
        lastUsedChannelId: '987654321098765432',
      }),
    ).toBe('123456789012345678');

    expect(
      resolveHeartbeatDeliveryChannelId({
        explicitChannelId: '   ',
        lastUsedChannelId: '987654321098765432',
      }),
    ).toBe('987654321098765432');

    expect(
      resolveHeartbeatDeliveryChannelId({
        explicitChannelId: '',
        lastUsedChannelId: null,
      }),
    ).toBeNull();
  });

  test('recognizes supported WhatsApp and local delivery ids', () => {
    expect(isSupportedProactiveChannelId('491234567890@s.whatsapp.net')).toBe(
      true,
    );
    expect(isSupportedProactiveChannelId('ops@example.com')).toBe(true);
    expect(isSupportedProactiveChannelId('imessage:ops@example.com')).toBe(
      true,
    );
    expect(isSupportedProactiveChannelId('120363401234567890@g.us')).toBe(true);
    expect(isSupportedProactiveChannelId('tui')).toBe(true);
    expect(isSupportedProactiveChannelId('smoke')).toBe(false);
  });

  test('recognizes email proactive delivery ids', () => {
    expect(isEmailAddress('ops@example.com')).toBe(true);
    expect(isEmailAddress('not-an-email')).toBe(false);
  });

  test('recognizes supported queued proactive delivery paths', () => {
    expect(
      hasQueuedProactiveDeliveryPath({
        channel_id: '123456789012345678',
      }),
    ).toBe(true);

    expect(
      hasQueuedProactiveDeliveryPath({
        channel_id: 'tui',
      }),
    ).toBe(true);

    expect(
      hasQueuedProactiveDeliveryPath({
        channel_id: '491234567890@s.whatsapp.net',
      }),
    ).toBe(true);

    expect(
      hasQueuedProactiveDeliveryPath({
        channel_id: 'ops@example.com',
      }),
    ).toBe(true);

    expect(
      hasQueuedProactiveDeliveryPath({
        channel_id: 'imessage:ops@example.com',
      }),
    ).toBe(true);

    expect(
      hasQueuedProactiveDeliveryPath({
        channel_id: 'smoke',
      }),
    ).toBe(false);
  });

  test('drops undeliverable queue rows but keeps valid local queue entries', () => {
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
    ).toBe(true);

    expect(
      shouldDropQueuedProactiveMessage({
        channel_id: 'smoke',
        source: 'fullauto',
      }),
    ).toBe(true);
  });
});
