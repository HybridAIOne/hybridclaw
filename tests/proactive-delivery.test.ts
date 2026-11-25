import { describe, expect, test } from 'vitest';

import {
  hasImmediateProactiveDeliveryPath,
  hasQueuedProactiveDeliveryPath,
  isA2ADeliveryTarget,
  isDiscordChannelId,
  isEmailAddress,
  isLocalProactivePullChannelId,
  isSupportedProactiveChannelId,
  isWebProactiveTarget,
  resolveHeartbeatDeliveryChannelId,
  shouldDropQueuedProactiveMessage,
  shouldSuppressProactiveMessage,
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

  test('recognizes supported WhatsApp, Telegram, and local delivery ids', () => {
    expect(isSupportedProactiveChannelId('491234567890@s.whatsapp.net')).toBe(
      true,
    );
    expect(isSupportedProactiveChannelId('telegram:123456789')).toBe(true);
    expect(isSupportedProactiveChannelId('ops@example.com')).toBe(true);
    expect(isSupportedProactiveChannelId('imessage:ops@example.com')).toBe(
      true,
    );
    expect(isSupportedProactiveChannelId('120363401234567890@g.us')).toBe(true);
    expect(isSupportedProactiveChannelId('19:conversation@thread.tacv2')).toBe(
      true,
    );
    // `web` is a dispatch-only target, never an escalation or message-tool queue.
    expect(isSupportedProactiveChannelId('web')).toBe(false);
    expect(hasQueuedProactiveDeliveryPath({ channel_id: 'web' })).toBe(true);
    expect(isSupportedProactiveChannelId('tui')).toBe(true);
    expect(isSupportedProactiveChannelId('a2a')).toBe(false);
    expect(isSupportedProactiveChannelId('a2a:peer-1')).toBe(false);
    expect(isSupportedProactiveChannelId('smoke')).toBe(false);
    expect(isWebProactiveTarget('  web  ')).toBe(true);
    expect(isWebProactiveTarget('tui')).toBe(false);
    expect(isA2ADeliveryTarget('a2a')).toBe(true);
    expect(isA2ADeliveryTarget(' A2A:peer-1 ')).toBe(true);
    expect(isA2ADeliveryTarget('web')).toBe(false);
  });

  test('distinguishes local pull queues from immediate delivery paths', () => {
    expect(isLocalProactivePullChannelId('tui')).toBe(true);
    expect(isLocalProactivePullChannelId('  tui  ')).toBe(true);
    expect(isLocalProactivePullChannelId('web')).toBe(false);
    expect(isLocalProactivePullChannelId('123456789012345678')).toBe(false);

    expect(
      hasImmediateProactiveDeliveryPath({
        channel_id: 'tui',
      }),
    ).toBe(false);

    expect(
      hasImmediateProactiveDeliveryPath({
        channel_id: 'web',
      }),
    ).toBe(true);

    expect(
      hasImmediateProactiveDeliveryPath({
        channel_id: '123456789012345678',
      }),
    ).toBe(true);

    expect(
      hasImmediateProactiveDeliveryPath({
        channel_id: 'ops@example.com',
      }),
    ).toBe(true);

    expect(
      hasImmediateProactiveDeliveryPath({
        channel_id: 'smoke',
      }),
    ).toBe(false);
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
        channel_id: 'telegram:-1001234567890:topic:42',
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
        channel_id: 'tui',
        source: 'heartbeat',
        text: 'HEARTBEAT_OK',
      }),
    ).toBe(true);

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

  test('suppresses heartbeat ok acknowledgements from proactive delivery', () => {
    expect(
      shouldSuppressProactiveMessage({
        source: 'heartbeat',
        text: 'HEARTBEAT_OK',
      }),
    ).toBe(true);

    expect(
      shouldSuppressProactiveMessage({
        source: 'heartbeat',
        text: 'heartbeat ok.',
      }),
    ).toBe(true);

    expect(
      shouldSuppressProactiveMessage({
        source: 'heartbeat',
        text: 'Review the queued tasks today.',
      }),
    ).toBe(false);

    expect(
      shouldSuppressProactiveMessage({
        source: 'delegate',
        text: 'HEARTBEAT_OK',
      }),
    ).toBe(false);
  });
});
