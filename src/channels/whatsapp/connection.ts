import type { ConnectionState, WASocket } from '@whiskeysockets/baileys';
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { APP_VERSION } from '../../config/config.js';
import { logger } from '../../logger.js';
import { sleep } from '../../utils/sleep.js';
import { loadWhatsAppAuthState } from './auth.js';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const VERBOSE_WHATSAPP_LOG_LEVELS = new Set(['debug', 'trace']);

type WhatsAppLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface WhatsAppLogger {
  level: string;
  child: (bindings: Record<string, unknown>) => WhatsAppLogger;
  trace: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

function resolveWhatsAppMetadataLogLevel(
  target: Pick<WhatsAppLogger, 'level'>,
): string | undefined {
  const rootLevel =
    typeof logger.level === 'string' && logger.level.trim()
      ? logger.level
      : undefined;
  if (rootLevel) return rootLevel;
  return target.level;
}

function shouldLogWhatsAppMetadata(level: string | undefined): boolean {
  return VERBOSE_WHATSAPP_LOG_LEVELS.has(
    String(level || '')
      .trim()
      .toLowerCase(),
  );
}

function writeWhatsAppLog(
  target: WhatsAppLogger,
  level: WhatsAppLogLevel,
  payload: unknown,
  message?: string,
): void {
  if (message == null) {
    target[level](payload);
    return;
  }
  target[level](payload, message);
}

function resolveWhatsAppLogMessage(
  level: WhatsAppLogLevel,
  payload: unknown,
  message?: string,
): string {
  if (typeof message === 'string' && message.trim().length > 0) return message;
  if (typeof payload === 'string' && payload.trim().length > 0) return payload;
  return `WhatsApp ${level}`;
}

function logWhatsAppMessage(
  target: WhatsAppLogger,
  level: Exclude<WhatsAppLogLevel, 'trace'>,
  message: string,
  metadata?: unknown,
): void {
  if (
    metadata !== undefined &&
    shouldLogWhatsAppMetadata(resolveWhatsAppMetadataLogLevel(target))
  ) {
    writeWhatsAppLog(target, level, metadata, message);
    return;
  }
  writeWhatsAppLog(target, level, message);
}

function createBaileysLogger(baseLogger: WhatsAppLogger): WhatsAppLogger {
  const forward =
    (level: WhatsAppLogLevel) =>
    (payload: unknown, message?: string): void => {
      if (
        shouldLogWhatsAppMetadata(resolveWhatsAppMetadataLogLevel(baseLogger))
      ) {
        writeWhatsAppLog(baseLogger, level, payload, message);
        return;
      }
      writeWhatsAppLog(
        baseLogger,
        level,
        resolveWhatsAppLogMessage(level, payload, message),
      );
    };

  return {
    get level() {
      return baseLogger.level;
    },
    child(bindings) {
      return createBaileysLogger(baseLogger.child(bindings));
    },
    trace: forward('trace'),
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
  };
}

function resolveDisconnectStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const output = (error as { output?: { statusCode?: unknown } }).output;
  if (typeof output?.statusCode === 'number') return output.statusCode;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : null;
}

export interface WhatsAppConnectionManager {
  getSocket: () => WASocket | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  waitForSocket: () => Promise<WASocket>;
}

export function createWhatsAppConnectionManager(params?: {
  onSocketCreated?: (socket: WASocket) => void;
}): WhatsAppConnectionManager {
  const childLogger = logger.child({ channel: 'whatsapp' }) as WhatsAppLogger;
  const baileysLogger = createBaileysLogger(childLogger);
  let socket: WASocket | null = null;
  let started = false;
  let stopped = false;
  let connectionOpen = false;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectingPromise: Promise<void> | null = null;
  const waiters: Array<{
    resolve: (socket: WASocket) => void;
    reject: (error: Error) => void;
  }> = [];

  const resolveWaiters = (nextSocket: WASocket): void => {
    while (waiters.length > 0) {
      waiters.shift()?.resolve(nextSocket);
    }
  };

  const rejectWaiters = (error: Error): void => {
    while (waiters.length > 0) {
      waiters.shift()?.reject(error);
    }
  };

  const scheduleReconnect = (reason: string): void => {
    if (stopped || reconnectTimer) return;
    const delayMs = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    logWhatsAppMessage(childLogger, 'warn', 'WhatsApp reconnect scheduled', {
      delayMs,
      reason,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    if (connectingPromise) return connectingPromise;
    connectingPromise = (async () => {
      const { state, saveCreds } = await loadWhatsAppAuthState();
      if (stopped) return;
      const latestVersion = await fetchLatestBaileysVersion().catch((error) => {
        logWhatsAppMessage(
          childLogger,
          'warn',
          'Failed to fetch latest Baileys version; using bundled default',
          { error },
        );
        return null;
      });
      if (stopped) return;
      const nextSocket = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        browser: Browsers.ubuntu('Chrome'),
        logger: baileysLogger,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        version: latestVersion?.version,
      });
      if (stopped) {
        try {
          nextSocket.end(undefined);
        } catch (error) {
          childLogger.debug({ error }, 'WhatsApp socket shutdown raised');
        }
        return;
      }

      socket = nextSocket;
      params?.onSocketCreated?.(nextSocket);

      nextSocket.ev.on('creds.update', () => {
        void Promise.resolve(saveCreds()).catch((error) => {
          logWhatsAppMessage(
            childLogger,
            'warn',
            'Failed to persist WhatsApp credentials',
            { error },
          );
        });
      });

      nextSocket.ev.on(
        'connection.update',
        (update: Partial<ConnectionState>) => {
          void handleConnectionUpdate(nextSocket, update);
        },
      );

      if (typeof nextSocket.ws?.on === 'function') {
        nextSocket.ws.on('error', (error: Error) => {
          logWhatsAppMessage(childLogger, 'warn', 'WhatsApp websocket error', {
            error,
          });
        });
      }
    })()
      .catch((error) => {
        logWhatsAppMessage(
          childLogger,
          'error',
          'WhatsApp connection attempt failed',
          { error },
        );
        scheduleReconnect('connect-error');
        throw error;
      })
      .finally(() => {
        connectingPromise = null;
      });

    await connectingPromise;
  };

  const handleConnectionUpdate = async (
    observedSocket: WASocket,
    update: Partial<ConnectionState>,
  ): Promise<void> => {
    if (socket !== observedSocket) return;

    if (update.qr) {
      logWhatsAppMessage(
        childLogger,
        'info',
        'Scan the WhatsApp QR code in Linked Devices',
        { appVersion: APP_VERSION },
      );
      qrcode.generate(update.qr, { small: true });
    }

    if (update.connection === 'open') {
      connectionOpen = true;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      logWhatsAppMessage(
        childLogger,
        'info',
        'WhatsApp connection established',
        { jid: observedSocket.user?.id || null },
      );
      resolveWaiters(observedSocket);
      return;
    }

    if (update.connection !== 'close') return;

    connectionOpen = false;
    socket = null;
    const statusCode = resolveDisconnectStatusCode(
      update.lastDisconnect?.error,
    );
    if (statusCode === DisconnectReason.loggedOut) {
      childLogger.warn(
        'WhatsApp session logged out; scan a new QR code to reconnect',
      );
      rejectWaiters(new Error('WhatsApp session logged out'));
      return;
    }
    if (statusCode === DisconnectReason.restartRequired) {
      childLogger.info(
        'WhatsApp restart required after pairing; reconnecting automatically',
      );
      scheduleReconnect('restart-required');
      await sleep(0);
      return;
    }

    rejectWaiters(new Error('WhatsApp connection closed'));
    scheduleReconnect(
      statusCode != null ? `status:${statusCode}` : 'connection-close',
    );
    await sleep(0);
  };

  return {
    getSocket() {
      return socket;
    },
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      await connect();
    },
    async stop() {
      stopped = true;
      started = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const activeSocket = socket;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      connectionOpen = false;
      socket = null;
      if (activeSocket && typeof activeSocket.end === 'function') {
        try {
          activeSocket.end(undefined);
        } catch (error) {
          childLogger.debug({ error }, 'WhatsApp socket shutdown raised');
        }
      }
      rejectWaiters(new Error('WhatsApp runtime stopped'));
    },
    waitForSocket() {
      if (stopped) {
        return Promise.reject(new Error('WhatsApp runtime stopped'));
      }
      if (socket && connectionOpen) return Promise.resolve(socket);
      return new Promise<WASocket>((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (!started) {
          void this.start().catch(reject);
        }
      });
    },
  };
}
