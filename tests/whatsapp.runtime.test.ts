import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

async function importFreshRuntimeModule(options?: {
  isSelfChat?: boolean;
  ackReaction?: string;
  debounceInbound?: boolean;
}) {
  vi.resetModules();
  const isSelfChat = options?.isSelfChat ?? true;
  let currentAckReaction = options?.ackReaction ?? '';
  const debounceInbound = options?.debounceInbound ?? false;

  const upsertHandlers: Array<
    (payload: { messages?: unknown[]; type?: string }) => void | Promise<void>
  > = [];
  const socket = {
    ev: {
      on: vi.fn(
        (
          event: string,
          handler: (payload: {
            messages?: unknown[];
            type?: string;
          }) => void | Promise<void>,
        ) => {
          if (event === 'messages.upsert') {
            upsertHandlers.push(handler);
          }
        },
      ),
    },
    sendMessage: vi.fn(
      async (
        jid: string,
        content: Record<string, unknown>,
      ): Promise<{ key: { id: string; remoteJid: string; fromMe: true } }> => ({
        key: {
          id: `bot-${socket.sendMessage.mock.calls.length}`,
          remoteJid: jid,
          fromMe: true,
        },
        message: content,
      }),
    ),
    readMessages: vi.fn(async () => {}),
    sendPresenceUpdate: vi.fn(async () => {}),
    user: {
      id: '491703330161:1@s.whatsapp.net',
      jid: '491703330161@s.whatsapp.net',
      lid: '1061007917075:18@lid',
    },
  };

  let onSocketCreated: ((socket: typeof socket) => void) | undefined;
  const manager = {
    getSocket: vi.fn(() => socket),
    rememberSentMessage: vi.fn(async () => {}),
    start: vi.fn(async () => {
      onSocketCreated?.(socket);
    }),
    stop: vi.fn(async () => {}),
    waitForSocket: vi.fn(async () => socket),
  };

  const processInboundWhatsAppMessage = vi.fn(async ({ message }) => ({
    sessionId: 'wa:491703330161@s.whatsapp.net',
    guildId: null,
    channelId: '491703330161@s.whatsapp.net',
    userId: '+491703330161',
    username: '+491703330161',
    content: String(message?.message?.conversation || '').trim(),
    media: [],
    chatJid: '491703330161@s.whatsapp.net',
    senderJid: '491703330161@s.whatsapp.net',
    isGroup: false,
    isSelfChat,
    rawMessage: message,
  }));
  const cleanupWhatsAppInboundMedia = vi.fn(async () => {});
  const createWhatsAppConnectionManager = vi.fn(
    (params?: { onSocketCreated?: (socket: typeof socket) => void }) => {
      onSocketCreated = params?.onSocketCreated;
      return manager;
    },
  );

  vi.doMock('../src/config/config.ts', () => ({
    DATA_DIR: path.join(os.tmpdir(), 'hybridclaw-test-data'),
    WHATSAPP_TEXT_CHUNK_LIMIT: 4000,
    getConfigSnapshot: vi.fn(() => ({
      whatsapp: {
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        textChunkLimit: 4000,
        debounceMs: 2500,
        sendReadReceipts: false,
        ackReaction: currentAckReaction,
        mediaMaxMb: 20,
      },
    })),
  }));

  vi.doMock('../src/logger.ts', () => ({
    logger: {
      debug: vi.fn(),
    },
  }));

  vi.doMock('../src/channels/whatsapp/connection.ts', () => ({
    createWhatsAppConnectionManager,
  }));

  let pendingBatch: {
    item: unknown;
    onFlush: (item: unknown) => Promise<void>;
  } | null = null;
  const clearAllDebouncedWhatsApp = vi.fn(() => {
    pendingBatch = null;
  });
  const flushAllDebouncedWhatsApp = vi.fn(async () => {
    if (!pendingBatch) return;
    const batch = pendingBatch;
    pendingBatch = null;
    await batch.onFlush(batch.item);
  });
  vi.doMock('../src/channels/whatsapp/debounce.ts', () => ({
    createWhatsAppDebouncer: vi.fn(
      (onFlush: (item: unknown) => Promise<void>) => ({
        enqueue: vi.fn((item: unknown) => {
          pendingBatch = { item, onFlush };
        }),
        clearAll: clearAllDebouncedWhatsApp,
        flushAll: flushAllDebouncedWhatsApp,
      }),
    ),
    shouldDebounceWhatsAppInbound: vi.fn(() => debounceInbound),
  }));

  const sendWhatsAppReaction = vi.fn(async () => true);
  const clearWhatsAppReaction = vi.fn(async () => true);
  vi.doMock('../src/channels/whatsapp/delivery.ts', async () => {
    const actual = await vi.importActual(
      '../src/channels/whatsapp/delivery.ts',
    );
    return {
      ...actual,
      clearWhatsAppReaction,
      sendWhatsAppReaction,
      sendWhatsAppReadReceipt: vi.fn(async () => true),
    };
  });

  vi.doMock('../src/channels/whatsapp/inbound.ts', () => ({
    cleanupWhatsAppInboundMedia,
    processInboundWhatsAppMessage,
  }));

  const runtime = await import('../src/channels/whatsapp/runtime.ts');
  return {
    manager,
    cleanupWhatsAppInboundMedia,
    clearAllDebouncedWhatsApp,
    clearWhatsAppReaction,
    createWhatsAppConnectionManager,
    flushAllDebouncedWhatsApp,
    processInboundWhatsAppMessage,
    runtime,
    sendWhatsAppReaction,
    setAckReaction: (nextAckReaction: string) => {
      currentAckReaction = nextAckReaction;
    },
    socket,
    upsertHandlers,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

test('skips stale append catch-up messages', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T20:30:00.000Z'));

  const { processInboundWhatsAppMessage, runtime, upsertHandlers } =
    await importFreshRuntimeModule();
  const messageHandler = vi.fn(async () => {});

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'append',
    messages: [
      {
        key: {
          id: 'old-append-1',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        messageTimestamp: Math.floor(Date.now() / 1000) - 120,
        message: {
          conversation: 'old history message',
        },
      },
    ],
  });

  expect(processInboundWhatsAppMessage).not.toHaveBeenCalled();
  expect(messageHandler).not.toHaveBeenCalled();
});

test('skips append catch-up messages when timestamp is missing', async () => {
  const { processInboundWhatsAppMessage, runtime, upsertHandlers } =
    await importFreshRuntimeModule();
  const messageHandler = vi.fn(async () => {});

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'append',
    messages: [
      {
        key: {
          id: 'append-no-timestamp-1',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'history message without timestamp',
        },
      },
    ],
  });

  expect(processInboundWhatsAppMessage).not.toHaveBeenCalled();
  expect(messageHandler).not.toHaveBeenCalled();
});

test('createWhatsAppRuntime isolates runtime state per instance', async () => {
  const { createWhatsAppConnectionManager, runtime } =
    await importFreshRuntimeModule();
  const firstRuntime = runtime.createWhatsAppRuntime();
  const secondRuntime = runtime.createWhatsAppRuntime();
  const messageHandler = vi.fn(async () => {});

  await firstRuntime.initWhatsApp(messageHandler);
  await secondRuntime.initWhatsApp(messageHandler);

  expect(createWhatsAppConnectionManager).toHaveBeenCalledTimes(2);
});

test('ignores reflected self-chat messages sent by HybridClaw itself', async () => {
  const { processInboundWhatsAppMessage, runtime, upsertHandlers } =
    await importFreshRuntimeModule();
  const messageHandler = vi.fn(async () => {});

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await runtime.sendToWhatsAppChat(
    '491703330161@s.whatsapp.net',
    'bot outbound message',
  );

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'bot-1',
          fromMe: true,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'bot outbound message',
        },
      },
    ],
  });

  expect(processInboundWhatsAppMessage).not.toHaveBeenCalled();
  expect(messageHandler).not.toHaveBeenCalled();

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-1',
          fromMe: true,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello from my phone',
        },
      },
    ],
  });

  expect(processInboundWhatsAppMessage).toHaveBeenCalledTimes(1);
  expect(processInboundWhatsAppMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      selfJids: [
        '491703330161@s.whatsapp.net',
        '491703330161:1@s.whatsapp.net',
        '1061007917075:18@lid',
      ],
    }),
  );
  expect(messageHandler).toHaveBeenCalledTimes(1);
  expect(messageHandler).toHaveBeenCalledWith(
    'wa:491703330161@s.whatsapp.net',
    null,
    '491703330161@s.whatsapp.net',
    '+491703330161',
    '+491703330161',
    'hello from my phone',
    [],
    expect.any(Function),
    expect.objectContaining({
      chatJid: '491703330161@s.whatsapp.net',
      senderJid: '491703330161@s.whatsapp.net',
    }),
  );
});

test('shows WhatsApp composing presence while processing an inbound turn', async () => {
  const { runtime, socket, upsertHandlers } = await importFreshRuntimeModule();
  let resolveTurn: (() => void) | null = null;
  let resolveHandled: (() => void) | null = null;
  const handled = new Promise<void>((resolve) => {
    resolveHandled = resolve;
  });
  const messageHandler = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    resolveHandled?.();
  });

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-2',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello while thinking',
        },
      },
    ],
  });

  await Promise.resolve();
  expect(socket.sendPresenceUpdate).toHaveBeenCalledWith(
    'composing',
    '491703330161@s.whatsapp.net',
  );

  resolveTurn?.();
  await handled;
  await Promise.resolve();

  expect(socket.sendPresenceUpdate).toHaveBeenLastCalledWith(
    'paused',
    '491703330161@s.whatsapp.net',
  );
});

test('clears WhatsApp ack reactions after the turn completes', async () => {
  const {
    clearWhatsAppReaction,
    runtime,
    sendWhatsAppReaction,
    upsertHandlers,
  } = await importFreshRuntimeModule({
    ackReaction: '👀',
  });
  const messageHandler = vi.fn(async () => {});

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-ack-1',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello',
        },
      },
    ],
  });

  await flushAsyncWork();

  expect(sendWhatsAppReaction).toHaveBeenCalledWith(
    expect.objectContaining({
      jid: '491703330161@s.whatsapp.net',
      emoji: '👀',
      key: expect.objectContaining({
        id: 'phone-ack-1',
      }),
    }),
  );
  expect(clearWhatsAppReaction).toHaveBeenCalledWith(
    expect.objectContaining({
      jid: '491703330161@s.whatsapp.net',
      key: expect.objectContaining({
        id: 'phone-ack-1',
      }),
    }),
  );
});

test('cancels debounced WhatsApp batches during shutdown', async () => {
  const {
    clearAllDebouncedWhatsApp,
    clearWhatsAppReaction,
    flushAllDebouncedWhatsApp,
    manager,
    runtime,
    sendWhatsAppReaction,
    setAckReaction,
    upsertHandlers,
  } = await importFreshRuntimeModule({
    ackReaction: '👀',
    debounceInbound: true,
  });
  const messageHandler = vi.fn(async () => {});

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-debounce-ack-1',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello',
        },
      },
    ],
  });

  await flushAsyncWork();
  setAckReaction('');
  await runtime.shutdownWhatsApp();

  expect(sendWhatsAppReaction).toHaveBeenCalledWith(
    expect.objectContaining({
      emoji: '👀',
      key: expect.objectContaining({
        id: 'phone-debounce-ack-1',
      }),
    }),
  );
  expect(clearAllDebouncedWhatsApp).toHaveBeenCalledTimes(1);
  expect(flushAllDebouncedWhatsApp).not.toHaveBeenCalled();
  expect(messageHandler).not.toHaveBeenCalled();
  expect(clearWhatsAppReaction).not.toHaveBeenCalled();
  expect(manager.stop).toHaveBeenCalledTimes(1);
});

test('aborts in-flight WhatsApp handlers during shutdown', async () => {
  const { runtime, socket, upsertHandlers } = await importFreshRuntimeModule();
  let aborted = false;
  let resolveHandlerStarted: (() => void) | null = null;
  const handlerStarted = new Promise<void>((resolve) => {
    resolveHandlerStarted = resolve;
  });
  const handlerCompleted = vi.fn();

  const messageHandler = vi.fn(async (...args: unknown[]) => {
    const context = args[8] as { abortSignal: AbortSignal };
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

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-shutdown-1',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello while shutting down',
        },
      },
    ],
  });

  await handlerStarted;
  await runtime.shutdownWhatsApp();
  await flushAsyncWork();

  expect(aborted).toBe(true);
  expect(handlerCompleted).toHaveBeenCalledTimes(1);
  expect(socket.sendPresenceUpdate).toHaveBeenCalledWith(
    'paused',
    '491703330161@s.whatsapp.net',
  );
});

test('does not start WhatsApp typing after shutdown begins', async () => {
  const { processInboundWhatsAppMessage, runtime, socket, upsertHandlers } =
    await importFreshRuntimeModule();
  let releaseInbound!: () => void;
  const inboundGate = new Promise<void>((resolve) => {
    releaseInbound = resolve;
  });
  processInboundWhatsAppMessage.mockImplementation(async () => {
    await inboundGate;
    return {
      sessionId: 'wa:491703330161@s.whatsapp.net',
      guildId: null,
      channelId: '491703330161@s.whatsapp.net',
      userId: '+491703330161',
      username: '+491703330161',
      content: 'hello while shutting down',
      media: [],
      chatJid: '491703330161@s.whatsapp.net',
      senderJid: '491703330161@s.whatsapp.net',
      isGroup: false,
      isSelfChat: true,
      rawMessage: {},
    };
  });
  const messageHandler = vi.fn(async () => {});

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-shutdown-typing-1',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello while shutting down',
        },
      },
    ],
  });
  await flushAsyncWork();
  expect(processInboundWhatsAppMessage).toHaveBeenCalledTimes(1);

  await runtime.shutdownWhatsApp();
  releaseInbound();
  await flushAsyncWork();

  expect(messageHandler).not.toHaveBeenCalled();
  expect(socket.sendPresenceUpdate).not.toHaveBeenCalledWith(
    'composing',
    '491703330161@s.whatsapp.net',
  );
});

test('prefixes self-chat replies with [hybridclaw]', async () => {
  const { manager, runtime, socket, upsertHandlers } =
    await importFreshRuntimeModule({
      isSelfChat: true,
    });
  const messageHandler = vi.fn(async (...args: unknown[]) => {
    const reply = args[7] as (content: string) => Promise<void>;
    await reply('hello from the bot');
  });

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-3',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello from my phone',
        },
      },
    ],
  });

  await flushAsyncWork();

  expect(socket.sendMessage).toHaveBeenCalledWith(
    '491703330161@s.whatsapp.net',
    {
      text: '[hybridclaw] hello from the bot',
    },
  );
  expect(manager.rememberSentMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      key: expect.objectContaining({
        id: 'bot-1',
        remoteJid: '491703330161@s.whatsapp.net',
      }),
    }),
  );
});

test('routes self-chat replies to the inbound chat jid when inbound chat jid is lid', async () => {
  const { processInboundWhatsAppMessage, runtime, socket, upsertHandlers } =
    await importFreshRuntimeModule({
      isSelfChat: true,
    });
  processInboundWhatsAppMessage.mockResolvedValue({
    sessionId: 'wa:491703330161@s.whatsapp.net',
    guildId: null,
    channelId: '1061007917075@lid',
    userId: '+491703330161',
    username: '+491703330161',
    content: 'hello from my phone',
    media: [],
    chatJid: '1061007917075@lid',
    senderJid: '1061007917075:14@lid',
    isGroup: false,
    isSelfChat: true,
    rawMessage: {},
  });
  const messageHandler = vi.fn(async (...args: unknown[]) => {
    const reply = args[7] as (content: string) => Promise<void>;
    await reply('hello from the bot');
  });

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-lid-1',
          fromMe: true,
          remoteJid: '1061007917075@lid',
          participant: '1061007917075:14@lid',
        },
        message: {
          conversation: 'hello from my phone',
        },
      },
    ],
  });

  await flushAsyncWork();

  expect(socket.sendMessage).toHaveBeenCalledWith('1061007917075@lid', {
    text: '[hybridclaw] hello from the bot',
  });
});

test('does not prefix non-self WhatsApp replies', async () => {
  const { runtime, socket, upsertHandlers } = await importFreshRuntimeModule({
    isSelfChat: false,
  });
  const messageHandler = vi.fn(async (...args: unknown[]) => {
    const reply = args[7] as (content: string) => Promise<void>;
    await reply('hello from the bot');
  });

  await runtime.initWhatsApp(messageHandler);
  expect(upsertHandlers).toHaveLength(1);

  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-4',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'hello from another chat',
        },
      },
    ],
  });

  await flushAsyncWork();

  expect(socket.sendMessage).toHaveBeenCalledWith(
    '491703330161@s.whatsapp.net',
    {
      text: 'hello from the bot',
    },
  );
});

test('cleans up inbound WhatsApp media after the turn completes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-wa-'));
  const tempFile = path.join(tempDir, 'voice.ogg');
  fs.writeFileSync(tempFile, 'audio');

  const {
    cleanupWhatsAppInboundMedia,
    processInboundWhatsAppMessage,
    runtime,
    upsertHandlers,
  } = await importFreshRuntimeModule();
  processInboundWhatsAppMessage.mockResolvedValue({
    sessionId: 'wa:491703330161@s.whatsapp.net',
    guildId: null,
    channelId: '491703330161@s.whatsapp.net',
    userId: '+491703330161',
    username: '+491703330161',
    content: 'voice note',
    media: [
      {
        path: tempFile,
        url: `file://${tempFile}`,
        originalUrl: `file://${tempFile}`,
        mimeType: 'audio/ogg',
        sizeBytes: 5,
        filename: 'voice.ogg',
      },
    ],
    chatJid: '491703330161@s.whatsapp.net',
    senderJid: '491703330161@s.whatsapp.net',
    isGroup: false,
    isSelfChat: true,
    rawMessage: {},
  });
  const messageHandler = vi.fn(async () => {});

  await runtime.initWhatsApp(messageHandler);
  await upsertHandlers[0]?.({
    type: 'notify',
    messages: [
      {
        key: {
          id: 'phone-5',
          fromMe: false,
          remoteJid: '491703330161@s.whatsapp.net',
        },
        message: {
          conversation: 'voice note',
        },
      },
    ],
  });

  await flushAsyncWork();

  expect(messageHandler).toHaveBeenCalledTimes(1);
  expect(cleanupWhatsAppInboundMedia).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        path: tempFile,
      }),
    ]),
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});
