import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

test('sendChunkedTelegramText retries transient Telegram transport failures', async () => {
  vi.useFakeTimers();

  const warn = vi.fn();
  const callTelegramApi = vi
    .fn()
    .mockRejectedValueOnce(new Error('fetch failed: Connect Timeout Error'))
    .mockResolvedValueOnce({ message_id: 42 });

  class MockTelegramApiError extends Error {
    statusCode: number;
    errorCode: number | null;

    constructor(
      statusCode: number,
      errorCode: number | null,
      description: string,
    ) {
      super(description);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }

  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      telegram: {
        textChunkLimit: 4_000,
      },
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock('../src/channels/telegram/api.js', () => ({
    callTelegramApi,
    callTelegramMultipartApi: vi.fn(),
    createTelegramUploadForm: vi.fn(),
    TelegramApiError: MockTelegramApiError,
  }));

  const { sendChunkedTelegramText } = await import(
    '../src/channels/telegram/delivery.js'
  );

  const sendPromise = sendChunkedTelegramText({
    botToken: 'token',
    target: 'telegram:123456789',
    text: 'Hello',
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(callTelegramApi).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(499);
  expect(callTelegramApi).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  const refs = await sendPromise;

  expect(callTelegramApi).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'telegram.sendChunkedText',
      attempt: 1,
      waitMs: 500,
    }),
    'Telegram transport failed; retrying',
  );
  expect(refs).toEqual([
    {
      chatId: '123456789',
      messageId: 42,
    },
  ]);
});

test('sendChunkedTelegramText queues outbound sends per Telegram target', async () => {
  let resolveFirstSend: ((value: { message_id: number }) => void) | null = null;
  const callTelegramApi = vi
    .fn()
    .mockImplementationOnce(
      async () =>
        await new Promise<{ message_id: number }>((resolve) => {
          resolveFirstSend = resolve;
        }),
    )
    .mockResolvedValueOnce({ message_id: 2 });

  class MockTelegramApiError extends Error {
    statusCode: number;
    errorCode: number | null;

    constructor(
      statusCode: number,
      errorCode: number | null,
      description: string,
    ) {
      super(description);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }

  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      telegram: {
        textChunkLimit: 4_000,
      },
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock('../src/channels/telegram/api.js', () => ({
    callTelegramApi,
    callTelegramMultipartApi: vi.fn(),
    createTelegramUploadForm: vi.fn(),
    TelegramApiError: MockTelegramApiError,
  }));

  const { sendChunkedTelegramText } = await import(
    '../src/channels/telegram/delivery.js'
  );

  const firstSend = sendChunkedTelegramText({
    botToken: 'token',
    target: 'telegram:123456789',
    text: 'First',
  });
  await Promise.resolve();

  const secondSend = sendChunkedTelegramText({
    botToken: 'token',
    target: 'telegram:123456789',
    text: 'Second',
  });
  await Promise.resolve();

  expect(callTelegramApi).toHaveBeenCalledTimes(1);

  resolveFirstSend?.({ message_id: 1 });
  const [firstRefs, secondRefs] = await Promise.all([firstSend, secondSend]);

  expect(callTelegramApi).toHaveBeenCalledTimes(2);
  expect(callTelegramApi).toHaveBeenNthCalledWith(
    1,
    'token',
    'sendMessage',
    expect.objectContaining({ text: 'First' }),
  );
  expect(callTelegramApi).toHaveBeenNthCalledWith(
    2,
    'token',
    'sendMessage',
    expect.objectContaining({ text: 'Second' }),
  );
  expect(firstRefs).toEqual([
    {
      chatId: '123456789',
      messageId: 1,
    },
  ]);
  expect(secondRefs).toEqual([
    {
      chatId: '123456789',
      messageId: 2,
    },
  ]);
});

test('sendChunkedTelegramText reports the effective topic after topic fallback', async () => {
  const callTelegramApi = vi
    .fn()
    .mockRejectedValueOnce(new Error('message thread not found'))
    .mockResolvedValueOnce({ message_id: 77 });

  class MockTelegramApiError extends Error {
    statusCode: number;
    errorCode: number | null;

    constructor(
      statusCode: number,
      errorCode: number | null,
      description: string,
    ) {
      super(description);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }

  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      telegram: {
        textChunkLimit: 4_000,
      },
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock('../src/channels/telegram/api.js', () => ({
    callTelegramApi,
    callTelegramMultipartApi: vi.fn(),
    createTelegramUploadForm: vi.fn(),
    TelegramApiError: MockTelegramApiError,
  }));

  const { sendChunkedTelegramText } = await import(
    '../src/channels/telegram/delivery.js'
  );

  const refs = await sendChunkedTelegramText({
    botToken: 'token',
    target: 'telegram:-1001234567890:topic:42',
    text: 'Hello',
  });

  expect(callTelegramApi).toHaveBeenNthCalledWith(
    1,
    'token',
    'sendMessage',
    expect.objectContaining({
      chat_id: -1001234567890,
      message_thread_id: 42,
    }),
  );
  expect(callTelegramApi).toHaveBeenNthCalledWith(
    2,
    'token',
    'sendMessage',
    expect.not.objectContaining({
      message_thread_id: expect.anything(),
    }),
  );
  expect(refs).toEqual([
    {
      chatId: '-1001234567890',
      messageId: 77,
    },
  ]);
});

test('sendTelegramMedia reports the effective topic after topic fallback', async () => {
  const callTelegramMultipartApi = vi
    .fn()
    .mockRejectedValueOnce(new Error('topic not found'))
    .mockResolvedValueOnce({ message_id: 88 });
  const createTelegramUploadForm = vi.fn(
    async ({ topicId }: { topicId?: number }) =>
      ({ topicId }) as unknown as FormData,
  );

  class MockTelegramApiError extends Error {
    statusCode: number;
    errorCode: number | null;

    constructor(
      statusCode: number,
      errorCode: number | null,
      description: string,
    ) {
      super(description);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }

  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      telegram: {
        textChunkLimit: 4_000,
      },
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock('../src/channels/telegram/api.js', () => ({
    callTelegramApi: vi.fn(),
    callTelegramMultipartApi,
    createTelegramUploadForm,
    TelegramApiError: MockTelegramApiError,
  }));

  const { sendTelegramMedia } = await import(
    '../src/channels/telegram/delivery.js'
  );

  const ref = await sendTelegramMedia({
    botToken: 'token',
    target: 'telegram:-1001234567890:topic:42',
    filePath: '/tmp/file.txt',
    filename: 'file.txt',
    mimeType: 'text/plain',
  });

  expect(createTelegramUploadForm).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      chatId: '-1001234567890',
      topicId: 42,
    }),
  );
  expect(createTelegramUploadForm).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      chatId: '-1001234567890',
      topicId: undefined,
    }),
  );
  expect(ref).toEqual({
    chatId: '-1001234567890',
    messageId: 88,
  });
});
