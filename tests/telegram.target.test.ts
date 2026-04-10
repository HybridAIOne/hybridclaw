import { expect, test } from 'vitest';
import {
  buildTelegramChannelId,
  isTelegramChannelId,
  isTelegramSendTargetId,
  normalizeTelegramChannelId,
  normalizeTelegramSendTargetId,
  parseTelegramTarget,
  resolveTelegramTargetChatType,
} from '../src/channels/telegram/target.js';

test('normalizes Telegram chat ids, usernames, and topic targets', () => {
  expect(normalizeTelegramChannelId('telegram:123456789')).toBe(
    'telegram:123456789',
  );
  expect(normalizeTelegramChannelId('@HybridClawBot')).toBe(
    'telegram:@hybridclawbot',
  );
  expect(normalizeTelegramChannelId('telegram:-1001234567890:topic:42')).toBe(
    'telegram:-1001234567890:topic:42',
  );
});

test('builds and parses canonical Telegram channel ids', () => {
  const channelId = buildTelegramChannelId('-1001234567890', 42);

  expect(channelId).toBe('telegram:-1001234567890:topic:42');
  expect(parseTelegramTarget(channelId)).toEqual({
    chatId: '-1001234567890',
    topicId: 42,
  });
  expect(isTelegramChannelId(channelId)).toBe(true);
});

test('infers Telegram target chat type from direct, group, and username ids', () => {
  expect(resolveTelegramTargetChatType('telegram:123456789')).toBe('direct');
  expect(resolveTelegramTargetChatType('telegram:-1001234567890')).toBe(
    'group',
  );
  expect(resolveTelegramTargetChatType('telegram:@hybridclawbot')).toBe(
    'unknown',
  );
});

test('normalizes Telegram send targets only for canonical numeric telegram ids', () => {
  expect(normalizeTelegramSendTargetId('telegram:123456789')).toBe(
    'telegram:123456789',
  );
  expect(
    normalizeTelegramSendTargetId('telegram:-1001234567890:topic:42'),
  ).toBe('telegram:-1001234567890:topic:42');
  expect(normalizeTelegramSendTargetId('telegram:@hybridclawbot')).toBe(
    undefined,
  );
  expect(normalizeTelegramSendTargetId('@hybridclawbot')).toBe(undefined);
  expect(isTelegramSendTargetId('telegram:123456789')).toBe(true);
  expect(isTelegramSendTargetId('telegram:@hybridclawbot')).toBe(false);
});
