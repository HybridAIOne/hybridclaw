import { afterEach, expect, test, vi } from 'vitest';

async function flushMicrotasks(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

async function importFreshConnectionModule(options?: {
  logLevel?: string;
  rootLevel?: string;
}) {
  vi.resetModules();

  const sockets: Array<{
    evHandlers: Map<string, Array<(payload: unknown) => void>>;
    wsHandlers: Map<string, Array<(payload: unknown) => void>>;
    socket: {
      ev: {
        on: (event: string, handler: (payload: unknown) => void) => void;
      };
      ws: {
        on: (event: string, handler: (payload: unknown) => void) => void;
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

  vi.doMock('../src/channels/whatsapp/auth.ts', () => ({
    loadWhatsAppAuthState: vi.fn(async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(async () => {}),
    })),
  }));

  vi.doMock('../src/logger.ts', () => ({
    logger: rootLogger,
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
      Browsers: {
        ubuntu: (name: string) => ['Ubuntu', name, '22.04.4'],
      },
      DisconnectReason,
      fetchLatestBaileysVersion: vi.fn(async () => ({
        version: [2, 3000, 0],
      })),
      makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
      makeWASocket: vi.fn(
        (config: {
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
            },
            user: undefined,
            end: vi.fn(),
          };
          sockets.push({ evHandlers, wsHandlers, socket });
          return socket;
        },
      ),
    };
  });

  const module = await import('../src/channels/whatsapp/connection.ts');
  return { ...module, qrcodeGenerate, sockets, whatsappLogger };
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
  const { createWhatsAppConnectionManager, sockets, whatsappLogger } =
    await importFreshConnectionModule({
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
    { appVersion: '0.6.0' },
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
