import { DEFAULT_AGENT_ID } from '../src/agents/agent-types.js';
import { expect, test } from 'vitest';
import { buildSessionKey } from '../src/session/session-key.js';
import {
  evaluateTelegramAccessPolicy,
  processInboundTelegramMessage,
} from '../src/channels/telegram/inbound.js';

const BASE_TELEGRAM_CONFIG = {
  enabled: true,
  botToken: '',
  pollIntervalMs: 1_500,
  dmPolicy: 'allowlist' as const,
  groupPolicy: 'allowlist' as const,
  allowFrom: ['12345'],
  groupAllowFrom: ['@allowed_user'],
  requireMention: true,
  textChunkLimit: 4_000,
  mediaMaxMb: 20,
};

test('blocks Telegram group messages without a mention when mention gating is enabled', () => {
  const result = evaluateTelegramAccessPolicy({
    dmPolicy: 'open',
    groupPolicy: 'allowlist',
    allowFrom: [],
    groupAllowFrom: ['@allowed_user'],
    chatType: 'supergroup',
    senderId: '12345',
    senderUsername: 'allowed_user',
    isBotMessage: false,
    requireMention: true,
    isMentioned: false,
  });

  expect(result).toEqual({
    allowed: false,
    isGroup: true,
  });
});

test('builds topic-aware inbound Telegram sessions for allowed group commands', async () => {
  const result = await processInboundTelegramMessage({
    botToken: 'test-token',
    config: BASE_TELEGRAM_CONFIG,
    botUser: {
      id: 999,
      is_bot: true,
      first_name: 'HybridClaw',
      username: 'hybridclawbot',
    },
    message: {
      message_id: 101,
      message_thread_id: 42,
      date: 1_744_290_000,
      text: '/status',
      chat: {
        id: -1001234567890,
        type: 'supergroup',
        title: 'Ops',
      },
      from: {
        id: 12345,
        is_bot: false,
        first_name: 'Allowed',
        username: 'allowed_user',
      },
      entities: [
        {
          type: 'bot_command',
          offset: 0,
          length: 7,
        },
      ],
    },
  });

  expect(result).toEqual({
    sessionId: buildSessionKey(
      DEFAULT_AGENT_ID,
      'telegram',
      'group',
      'telegram:-1001234567890:topic:42',
      { threadId: '42' },
    ),
    guildId: null,
    channelId: 'telegram:-1001234567890:topic:42',
    userId: '12345',
    username: 'Allowed',
    content: '/status',
    media: [],
    isGroup: true,
    topicId: 42,
  });
});
