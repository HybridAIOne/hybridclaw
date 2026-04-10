import { expect, test, vi } from 'vitest';
import { DEFAULT_AGENT_ID } from '../src/agents/agent-types.js';
import {
  evaluateTelegramAccessPolicy,
  processInboundTelegramMessage,
} from '../src/channels/telegram/inbound.js';
import { buildSessionKey } from '../src/session/session-key.js';

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

test('skips empty Telegram messages before attempting media download', async () => {
  vi.resetModules();
  const callTelegramApi = vi.fn();
  const fetchTelegramFile = vi.fn();
  vi.doMock('../src/channels/telegram/api.js', async () => {
    const actual = await vi.importActual('../src/channels/telegram/api.js');
    return {
      ...actual,
      callTelegramApi,
      fetchTelegramFile,
    };
  });

  try {
    const { processInboundTelegramMessage: processInboundWithMock } =
      await import('../src/channels/telegram/inbound.js');

    const result = await processInboundWithMock({
      botToken: 'test-token',
      config: {
        ...BASE_TELEGRAM_CONFIG,
        dmPolicy: 'open',
      },
      botUser: {
        id: 999,
        is_bot: true,
        first_name: 'HybridClaw',
        username: 'hybridclawbot',
      },
      message: {
        message_id: 202,
        date: 1_744_290_001,
        chat: {
          id: 12345,
          type: 'private',
          first_name: 'Allowed',
        },
        from: {
          id: 12345,
          is_bot: false,
          first_name: 'Allowed',
          username: 'allowed_user',
        },
      },
    });

    expect(result).toBeNull();
    expect(callTelegramApi).not.toHaveBeenCalled();
    expect(fetchTelegramFile).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock('../src/channels/telegram/api.js');
    vi.resetModules();
  }
});

test('drops Telegram media whose downloaded size exceeds the configured limit', async () => {
  vi.resetModules();
  const callTelegramApi = vi.fn(async () => ({
    file_id: 'doc-1',
    file_path: 'documents/doc-1.bin',
  }));
  const fetchTelegramFile = vi.fn(async () =>
    Buffer.alloc(2 * 1024 * 1024, 1),
  );
  const createUploadedMediaContextItem = vi.fn();
  vi.doMock('../src/channels/telegram/api.js', async () => {
    const actual = await vi.importActual('../src/channels/telegram/api.js');
    return {
      ...actual,
      callTelegramApi,
      fetchTelegramFile,
    };
  });
  vi.doMock('../src/media/uploaded-media-cache.js', () => ({
    createUploadedMediaContextItem,
  }));

  try {
    const { processInboundTelegramMessage: processInboundWithMock } =
      await import('../src/channels/telegram/inbound.js');

    const result = await processInboundWithMock({
      botToken: 'test-token',
      config: {
        ...BASE_TELEGRAM_CONFIG,
        dmPolicy: 'open',
        mediaMaxMb: 1,
      },
      botUser: {
        id: 999,
        is_bot: true,
        first_name: 'HybridClaw',
        username: 'hybridclawbot',
      },
      message: {
        message_id: 203,
        date: 1_744_290_002,
        chat: {
          id: 12345,
          type: 'private',
          first_name: 'Allowed',
        },
        from: {
          id: 12345,
          is_bot: false,
          first_name: 'Allowed',
          username: 'allowed_user',
        },
        document: {
          file_id: 'doc-1',
          file_name: 'large.bin',
          file_size: 0,
        },
      },
    });

    expect(result).toBeNull();
    expect(callTelegramApi).toHaveBeenCalledWith('test-token', 'getFile', {
      file_id: 'doc-1',
    });
    expect(fetchTelegramFile).toHaveBeenCalledWith(
      'test-token',
      'documents/doc-1.bin',
    );
    expect(createUploadedMediaContextItem).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock('../src/channels/telegram/api.js');
    vi.doUnmock('../src/media/uploaded-media-cache.js');
    vi.resetModules();
  }
});
