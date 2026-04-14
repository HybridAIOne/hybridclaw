import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

async function importFreshTelegramRuntime() {
  vi.resetModules();

  const dataDir = makeTempDir('hybridclaw-telegram-runtime-');
  const registerChannel = vi.fn();
  const sendChunkedTelegramText = vi.fn(async () => []);
  const sendTelegramMedia = vi.fn(async () => null);
  const sendTelegramTyping = vi.fn(async () => true);
  const typingStart = vi.fn();
  const typingStop = vi.fn();
  const createTelegramTypingController = vi.fn(() => ({
    start: typingStart,
    stop: typingStop,
  }));
  const processInboundTelegramMessage = vi.fn(async () => ({
    sessionId: 'agent:main:channel:telegram:chat:dm:peer:telegram%3A7727645677',
    guildId: null,
    channelId: 'telegram:7727645677',
    userId: '7727645677',
    username: 'Ben',
    content: 'hello',
    media: [],
    topicId: undefined,
  }));
  const callTelegramApi = vi.fn(async (_token: string, method: string) => {
    if (method === 'getMe') {
      return {
        id: 999001,
        is_bot: true,
        first_name: 'HybridClaw',
        username: 'hybridclawbot',
      };
    }
    if (method === 'getUpdates') {
      return [
        {
          update_id: 1,
          message: {
            message_id: 42,
            date: 1_744_279_600,
            chat: {
              id: 7727645677,
              type: 'private',
            },
            from: {
              id: 7727645677,
              is_bot: false,
              first_name: 'Ben',
              username: 'benkoehler',
            },
            text: 'hello',
          },
        },
      ];
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });

  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: dataDir,
    TELEGRAM_BOT_TOKEN: 'telegram-bot-token',
    getConfigSnapshot: vi.fn(() => ({
      telegram: {
        enabled: true,
        botToken: '',
        pollIntervalMs: 0,
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        requireMention: true,
        textChunkLimit: 4_000,
        mediaMaxMb: 20,
      },
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/channels/channel-registry.js', () => ({
    registerChannel,
  }));
  vi.doMock('../src/channels/telegram/api.js', () => ({
    callTelegramApi,
  }));
  vi.doMock('../src/channels/telegram/delivery.js', () => ({
    sendChunkedTelegramText,
    sendTelegramMedia,
    sendTelegramTyping,
  }));
  vi.doMock('../src/channels/telegram/inbound.js', () => ({
    processInboundTelegramMessage,
  }));
  vi.doMock('../src/channels/telegram/typing.js', () => ({
    createTelegramTypingController,
  }));

  const runtime = await import('../src/channels/telegram/runtime.js');
  return {
    callTelegramApi,
    createTelegramTypingController,
    processInboundTelegramMessage,
    registerChannel,
    runtime,
    sendChunkedTelegramText,
    sendTelegramMedia,
    sendTelegramTyping,
    typingStart,
    typingStop,
  };
}

useCleanMocks({
  resetModules: true,
  unmock: [
    '../src/config/config.js',
    '../src/logger.js',
    '../src/channels/channel-registry.js',
    '../src/channels/telegram/api.js',
    '../src/channels/telegram/delivery.js',
    '../src/channels/telegram/inbound.js',
    '../src/channels/telegram/typing.js',
  ],
});

test('aborts in-flight Telegram handlers during shutdown', async () => {
  const { registerChannel, runtime, typingStart, typingStop } =
    await importFreshTelegramRuntime();
  let aborted = false;
  let resolveHandlerStarted: (() => void) | null = null;
  const handlerStarted = new Promise<void>((resolve) => {
    resolveHandlerStarted = resolve;
  });
  const handlerCompleted = vi.fn();

  await runtime.initTelegram(async (...args) => {
    const context = args[8];
    resolveHandlerStarted?.();
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        aborted = true;
        resolve();
      };
      if (context.abortSignal.aborted) {
        onAbort();
        return;
      }
      context.abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    handlerCompleted();
  });

  await handlerStarted;
  await runtime.shutdownTelegram();

  expect(aborted).toBe(true);
  expect(handlerCompleted).toHaveBeenCalledTimes(1);
  expect(registerChannel).toHaveBeenCalledTimes(1);
  expect(typingStart).toHaveBeenCalledTimes(1);
  expect(typingStop).toHaveBeenCalledTimes(1);
});
