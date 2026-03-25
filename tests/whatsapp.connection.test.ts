import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';

async function flushMicrotasks(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function importFreshConnectionModule(options?: {
  logLevel?: string;
  rootLevel?: string;
  deferAuthState?: boolean;
}) {
  vi.resetModules();
  const configModule = await import('../src/config/config.js');
  const APP_VERSION = configModule.APP_VERSION;

  const sockets: Array<{
    config: {
      browser?: unknown[];
      getMessage?: (key: unknown) => Promise<unknown>;
      logger: { info: (obj: unknown, msg?: string) => void };
    };
    evHandlers: Map<string, Array<(payload: unknown) => void>>;
    wsHandlers: Map<string, Array<(payload: unknown) => void>>;
    rawSocketEmitter: EventEmitter;
    socket: {
      ev: {
        on: (event: string, handler: (payload: unknown) => void) => void;
      };
      ws: {
        on: (event: string, handler: (payload: unknown) => void) => void;
        socket: EventEmitter;
      };
      user?: { id?: string };
      end: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const qrcodeGenerate = vi.fn();
  const whatsappLogger = {
    level: options?.logLevel ?? 'info',
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  whatsappLogger.child.mockImplementation(() => whatsappLogger);
  const rootLogger = {
    level: options?.rootLevel ?? options?.logLevel ?? 'info',
    child: vi.fn(() => whatsappLogger),
  };
  const authStateGate = createDeferred<void>();
  const saveCredsMock = vi.fn(async () => {});
  const messageStore = {
    getMessage: vi.fn(async () => undefined),
    rememberSentMessage: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const releaseAuthLock = vi.fn();
  const acquireWhatsAppAuthLock = vi.fn(async () => releaseAuthLock);

  vi.doMock('../src/channels/whatsapp/auth.ts', () => ({
    acquireWhatsAppAuthLock,
    loadWhatsAppAuthState: vi.fn(async () => {
      if (options?.deferAuthState) await authStateGate.promise;
      return {
        state: { creds: {}, keys: {} },
        saveCreds: saveCredsMock,
      };
    }),
  }));

  vi.doMock('../src/logger.ts', () => ({
    logger: rootLogger,
  }));

  vi.doMock('../src/channels/whatsapp/message-store.ts', () => ({
    createWhatsAppMessageStore: vi.fn(() => messageStore),
  }));

  vi.doMock('qrcode-terminal', () => ({
    default: { generate: qrcodeGenerate },
  }));

  vi.doMock('@whiskeysockets/baileys', () => {
    const DisconnectReason = {
      loggedOut: 401,
      restartRequired: 515,
    };

    return {
      DisconnectReason,
      fetchLatestBaileysVersion: vi.fn(async () => ({
        version: [2, 3000, 0],
      })),
      makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
      makeWASocket: vi.fn(
        (config: {
          getMessage?: (key: unknown) => Promise<unknown>;
          logger: { info: (obj: unknown, msg?: string) => void };
        }) => {
          config.logger.info(
            {
              browser: ['Ubuntu', 'Chrome', '22.04.4'],
              helloMsg: { clientHello: { ephemeral: 'secret' } },
            },
            'connected to WA',
          );
          const evHandlers = new Map<
            string,
            Array<(payload: unknown) => void>
          >();
          const wsHandlers = new Map<
            string,
            Array<(payload: unknown) => void>
          >();
          const rawSocketEmitter = new EventEmitter();
          const socket = {
            ev: {
              on(event: string, handler: (payload: unknown) => void) {
                const handlers = evHandlers.get(event) ?? [];
                handlers.push(handler);
                evHandlers.set(event, handlers);
              },
            },
            ws: {
              on(event: string, handler: (payload: unknown) => void) {
                const handlers = wsHandlers.get(event) ?? [];
                handlers.push(handler);
                wsHandlers.set(event, handlers);
              },
              socket: rawSocketEmitter,
            },
            user: undefined,
            end: vi.fn(),
          };
          sockets.push({
            evHandlers,
            wsHandlers,
            rawSocketEmitter,
            socket,
            config,
          });
          return socket;
        },
      ),
    };
  });

  const module = await import('../src/channels/whatsapp/connection.ts');
  return {
    APP_VERSION,
    ...module,
    qrcodeGenerate,
    sockets,
    whatsappLogger,
    messageStore,
    acquireWhatsAppAuthLock,
    releaseAuthLock,
    saveCredsMock,
    releaseAuthState: () => authStateGate.resolve(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

test('waitForSocket survives restartRequired and resolves after reconnect', async () => {
  vi.useFakeTimers();
  const { createWhatsAppConnectionManager, sockets } =
    await importFreshConnectionModule();

  const manager = createWhatsAppConnectionManager();
  const socketPromise = manager.waitForSocket();

  await flushMicrotasks();
  expect(sockets).toHaveLength(1);
  const firstUpdateHandlers = sockets[0]?.evHandlers.get('connection.update');
  expect(firstUpdateHandlers).toHaveLength(1);

  firstUpdateHandlers?.[0]?.({
    connection: 'close',
    lastDisconnect: {
      error: { statusCode: 515 },
      date: new Date(),
    },
  });

  await vi.advanceTimersByTimeAsync(1_000);

  expect(sockets).toHaveLength(2);
  const secondSocket = sockets[1]?.socket;
  secondSocket.user = { id: '491701234567:1@s.whatsapp.net' };
  const secondUpdateHandlers = sockets[1]?.evHandlers.get('connection.update');
  expect(secondUpdateHandlers).toHaveLength(1);

  secondUpdateHandlers?.[0]?.({
    connection: 'open',
  });

  await expect(socketPromise).resolves.toBe(secondSocket);
});

test('waitForSocket rejects immediately after the manager is stopped', async () => {
  const { createWhatsAppConnectionManager } =
    await importFreshConnectionModule();

  const manager = createWhatsAppConnectionManager();
  await manager.start();
  await manager.stop();

  await expect(manager.waitForSocket()).rejects.toThrow(
    'WhatsApp runtime stopped',
  );
});

test('start can restart the manager after stop', async () => {
  const { createWhatsAppConnectionManager, sockets } =
    await importFreshConnectionModule();

  const manager = createWhatsAppConnectionManager();
  await manager.start();
  expect(sockets).toHaveLength(1);

  await manager.stop();
  await manager.start();
  expect(sockets).toHaveLength(2);

  const secondSocket = sockets[1]?.socket;
  secondSocket.user = { id: '491701234567:2@s.whatsapp.net' };
  const socketPromise = manager.waitForSocket();
  const secondUpdateHandlers = sockets[1]?.evHandlers.get('connection.update');
  expect(secondUpdateHandlers).toHaveLength(1);

  secondUpdateHandlers?.[0]?.({
    connection: 'open',
  });

  await expect(socketPromise).resolves.toBe(secondSocket);
});

test('waitForSocket does not revive the manager after stop during implicit startup', async () => {
  const { createWhatsAppConnectionManager, sockets, releaseAuthState } =
    await importFreshConnectionModule({
      deferAuthState: true,
    });

  const manager = createWhatsAppConnectionManager();
  const socketPromise = manager.waitForSocket();

  await flushMicrotasks();
  await manager.stop();
  releaseAuthState();
  await flushMicrotasks();

  await expect(socketPromise).rejects.toThrow('WhatsApp runtime stopped');
  expect(sockets).toHaveLength(0);
});

test('transport-level WhatsApp emitters are handled without throwing', async () => {
  const { createWhatsAppConnectionManager, sockets, whatsappLogger } =
    await importFreshConnectionModule();

  const manager = createWhatsAppConnectionManager();
  await manager.start();

  const transport = sockets[0];
  expect(transport).toBeDefined();

  expect(() =>
    transport?.rawSocketEmitter.emit(
      'error',
      new Error('Opening handshake has timed out'),
    ),
  ).not.toThrow();

  expect(whatsappLogger.warn).toHaveBeenCalledWith(
    'WhatsApp raw websocket error',
  );
});

test('info-level WhatsApp logs omit structured metadata', async () => {
  const {
    createWhatsAppConnectionManager,
    qrcodeGenerate,
    sockets,
    whatsappLogger,
  } = await importFreshConnectionModule();

  const manager = createWhatsAppConnectionManager();
  await manager.start();

  expect(whatsappLogger.info).toHaveBeenCalledWith('connected to WA');

  const updateHandlers = sockets[0]?.evHandlers.get('connection.update');
  updateHandlers?.[0]?.({ qr: 'test-qr' });
  expect(whatsappLogger.info).toHaveBeenCalledWith(
    'Scan the WhatsApp QR code in Linked Devices',
  );
  expect(qrcodeGenerate).toHaveBeenCalledWith('test-qr', { small: true });

  if (sockets[0]) {
    sockets[0].socket.user = { id: '491701234567:1@s.whatsapp.net' };
  }
  updateHandlers?.[0]?.({ connection: 'open' });
  expect(whatsappLogger.info).toHaveBeenCalledWith(
    'WhatsApp connection established',
  );
});

test('debug-level WhatsApp logs keep structured metadata', async () => {
  const {
    APP_VERSION,
    createWhatsAppConnectionManager,
    sockets,
    whatsappLogger,
  } = await importFreshConnectionModule({
    logLevel: 'debug',
  });

  const manager = createWhatsAppConnectionManager();
  await manager.start();

  expect(whatsappLogger.info).toHaveBeenCalledWith(
    {
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      helloMsg: { clientHello: { ephemeral: 'secret' } },
    },
    'connected to WA',
  );

  const updateHandlers = sockets[0]?.evHandlers.get('connection.update');
  updateHandlers?.[0]?.({ qr: 'test-qr' });
  expect(whatsappLogger.info).toHaveBeenCalledWith(
    { appVersion: APP_VERSION },
    'Scan the WhatsApp QR code in Linked Devices',
  );
});

test('forced root debug level keeps structured metadata even if child logger level is stale', async () => {
  const { createWhatsAppConnectionManager, whatsappLogger } =
    await importFreshConnectionModule({
      logLevel: 'info',
      rootLevel: 'debug',
    });

  const manager = createWhatsAppConnectionManager();
  await manager.start();

  expect(whatsappLogger.info).toHaveBeenCalledWith(
    {
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      helloMsg: { clientHello: { ephemeral: 'secret' } },
    },
    'connected to WA',
  );
});

test('provides WhatsApp retry replay lookup to Baileys and persists sent messages', async () => {
  const {
    APP_VERSION,
    acquireWhatsAppAuthLock,
    createWhatsAppConnectionManager,
    releaseAuthLock,
    sockets,
    messageStore,
  } = await importFreshConnectionModule();

  const manager = createWhatsAppConnectionManager();
  await manager.start();

  expect(acquireWhatsAppAuthLock).toHaveBeenCalledWith(undefined, {
    purpose: 'runtime',
  });
  expect(sockets[0]?.config.browser).toEqual([
    'HybridClaw',
    'Gateway',
    APP_VERSION,
  ]);
  expect(typeof sockets[0]?.config.getMessage).toBe('function');

  const key = { id: 'abc', remoteJid: '491701234567@s.whatsapp.net' };
  await expect(sockets[0]?.config.getMessage?.(key)).resolves.toBeUndefined();
  expect(messageStore.getMessage).toHaveBeenCalledWith(key);

  const sentMessage = {
    key: {
      id: 'bot-1',
      remoteJid: '491701234567@s.whatsapp.net',
      fromMe: true,
    },
    message: {
      conversation: 'hello',
    },
  };
  await manager.rememberSentMessage(sentMessage);
  expect(messageStore.rememberSentMessage).toHaveBeenCalledWith(sentMessage);

  await manager.stop();
  expect(releaseAuthLock).toHaveBeenCalledTimes(1);
});

test('serializes WhatsApp credential saves on rapid creds.update events', async () => {
  const { createWhatsAppConnectionManager, saveCredsMock, sockets } =
    await importFreshConnectionModule();
  const firstSave = createDeferred<void>();
  const secondSave = createDeferred<void>();
  let saveCall = 0;
  let activeSaves = 0;
  let maxConcurrentSaves = 0;

  saveCredsMock.mockImplementation(async () => {
    saveCall += 1;
    activeSaves += 1;
    maxConcurrentSaves = Math.max(maxConcurrentSaves, activeSaves);
    if (saveCall === 1) await firstSave.promise;
    if (saveCall === 2) await secondSave.promise;
    activeSaves -= 1;
  });

  const manager = createWhatsAppConnectionManager();
  await manager.start();

  const credsHandlers = sockets[0]?.evHandlers.get('creds.update');
  expect(credsHandlers).toHaveLength(1);
  credsHandlers?.[0]?.({});
  credsHandlers?.[0]?.({});

  await flushMicrotasks();
  expect(saveCredsMock).toHaveBeenCalledTimes(1);

  firstSave.resolve();
  await flushMicrotasks();
  expect(saveCredsMock).toHaveBeenCalledTimes(2);

  secondSave.resolve();
  await manager.stop();
  expect(maxConcurrentSaves).toBe(1);
});
