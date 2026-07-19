import type { WhatsAppTransportHost } from '@hybridaione/hybridclaw/plugin-sdk';
import type { ConnectionState, WASocket } from '@whiskeysockets/baileys';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { loadWhatsAppAuthState } from './auth-state.js';
import {
  createWhatsAppMessageStore,
  type WhatsAppMessageStore,
} from './message-store.js';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const VERBOSE_WHATSAPP_LOG_LEVELS = new Set(['debug', 'trace']);
const WHATSAPP_TRANSPORT_HOST = 'web.whatsapp.com';
const EXPECTED_TRANSPORT_DEBUG_WINDOW_MS = 60_000;
const EXPECTED_TRANSPORT_DEBUG_LIMIT = 3;
const EXPECTED_TRANSPORT_DEBUG_COOLDOWN_MS = 1_000;
const KEEPALIVE_ERROR_SUPPRESS_MS = 30_000;
const STOP_CREDS_SAVE_TIMEOUT_MS = 2_000;

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

interface EventEmitterLike {
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
}

const WHATSAPP_ERROR_SINK_ATTACHED = Symbol(
  'hybridclaw.whatsapp-error-sink-attached',
);

interface EventEmitterWithInternals extends EventEmitterLike {
  socket?: unknown;
  _socket?: unknown;
  _req?: unknown;
  [WHATSAPP_ERROR_SINK_ATTACHED]?: boolean;
}

interface WhatsAppConnectionContext {
  host: WhatsAppTransportHost;
  expectedTransportDebugLimiter: InstanceType<
    WhatsAppTransportHost['SlidingWindowRateLimiter']
  >;
  lastExpectedTransportAt: number;
}

function isEventEmitterLike(value: unknown): value is EventEmitterLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { on?: unknown }).on === 'function'
  );
}

function formatReconnectDelay(delayMs: number): string {
  return `${Math.max(1, Math.ceil(delayMs / 1_000))}s`;
}

function noteExpectedTransportActivity(
  context: WhatsAppConnectionContext,
  nowMs = Date.now(),
): void {
  context.lastExpectedTransportAt = nowMs;
}

function shouldSuppressKeepAliveError(
  context: WhatsAppConnectionContext,
  nowMs = Date.now(),
): boolean {
  return nowMs - context.lastExpectedTransportAt < KEEPALIVE_ERROR_SUPPRESS_MS;
}

function resolveWhatsAppLogMessage(payload: unknown, message?: string): string {
  if (typeof message === 'string' && message.trim().length > 0) {
    return message;
  }
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload;
  }
  return '';
}

function extractTransportSignal(payload: unknown, message?: string): unknown {
  if (payload && typeof payload === 'object') {
    if ('error' in payload) {
      return (payload as { error?: unknown }).error;
    }
    if (typeof (payload as { trace?: unknown }).trace === 'string') {
      return (payload as { trace: string }).trace;
    }
  }
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload;
  }
  return message || null;
}

function logExpectedWhatsAppTransport(
  context: WhatsAppConnectionContext,
  target: WhatsAppLogger,
  error: unknown,
  key: string,
  nextAction: string,
  level: 'debug' | 'warn',
): void {
  noteExpectedTransportActivity(context);
  if (
    level === 'debug' &&
    (!context.expectedTransportDebugLimiter.shouldNotify(
      key,
      EXPECTED_TRANSPORT_DEBUG_COOLDOWN_MS,
    ) ||
      !context.expectedTransportDebugLimiter.check(
        key,
        EXPECTED_TRANSPORT_DEBUG_LIMIT,
      ).allowed)
  ) {
    return;
  }

  const message = `${context.host.describeExpectedTransportError(
    error,
    'WhatsApp WebSocket',
    WHATSAPP_TRANSPORT_HOST,
  )} ${nextAction}`;
  context.host.pairing.setError(message);
  if (level === 'debug') {
    target.debug(message);
    return;
  }
  target.warn(message);
}

function attachWhatsAppEmitterErrorSink(
  context: WhatsAppConnectionContext,
  target: WhatsAppLogger,
  emitter: unknown,
  key: string,
  unexpectedMessage: string,
): void {
  if (!isEventEmitterLike(emitter)) return;
  const candidate = emitter as EventEmitterWithInternals;
  if (candidate[WHATSAPP_ERROR_SINK_ATTACHED]) return;
  candidate[WHATSAPP_ERROR_SINK_ATTACHED] = true;
  candidate.on('error', (error: unknown) => {
    if (context.host.isExpectedTransportError(error)) {
      logExpectedWhatsAppTransport(
        context,
        target,
        error,
        key,
        'Reconnect will be retried automatically.',
        'debug',
      );
      return;
    }
    logWhatsAppMessage(context, target, 'warn', unexpectedMessage, { error });
  });
}

function attachWhatsAppTransportErrorSinks(
  context: WhatsAppConnectionContext,
  target: WhatsAppLogger,
  transport: unknown,
): void {
  if (!isEventEmitterLike(transport)) return;

  attachWhatsAppEmitterErrorSink(
    context,
    target,
    transport,
    'whatsapp-websocket',
    'Unexpected WhatsApp websocket error',
  );

  // Baileys still exposes the underlying ws EventEmitter on `ws.socket` in
  // this runtime surface. Keep an explicit sink here so a raw transport error
  // cannot surface as an uncaught EventEmitter `error`.
  const rawSocket = (transport as EventEmitterWithInternals).socket;

  attachWhatsAppEmitterErrorSink(
    context,
    target,
    rawSocket,
    'whatsapp-websocket',
    'Unexpected WhatsApp raw websocket error',
  );

  const request = isEventEmitterLike(rawSocket)
    ? (rawSocket as EventEmitterWithInternals)._req
    : null;
  attachWhatsAppEmitterErrorSink(
    context,
    target,
    request,
    'whatsapp-websocket',
    'Unexpected WhatsApp websocket request error',
  );

  const tcpSocket = isEventEmitterLike(rawSocket)
    ? (rawSocket as EventEmitterWithInternals)._socket
    : null;
  attachWhatsAppEmitterErrorSink(
    context,
    target,
    tcpSocket,
    'whatsapp-websocket',
    'Unexpected WhatsApp websocket tcp error',
  );
}

function isVerboseWhatsAppLogging(
  context: WhatsAppConnectionContext,
  target: Pick<WhatsAppLogger, 'level'>,
): boolean {
  const effectiveLevel =
    typeof context.host.logger.level === 'string' &&
    context.host.logger.level.trim().length > 0
      ? context.host.logger.level
      : target.level;
  return VERBOSE_WHATSAPP_LOG_LEVELS.has(effectiveLevel.trim().toLowerCase());
}

function emitWhatsAppLog(
  context: WhatsAppConnectionContext,
  target: WhatsAppLogger,
  level: WhatsAppLogLevel,
  payload: unknown,
  message?: string,
): void {
  const resolvedMessage = resolveWhatsAppLogMessage(payload, message);
  const transportSignal = extractTransportSignal(payload, message);
  if (
    resolvedMessage === 'connection errored' &&
    context.host.isExpectedTransportError(transportSignal)
  ) {
    noteExpectedTransportActivity(context);
    return;
  }
  if (
    resolvedMessage === 'error in sending keep alive' &&
    shouldSuppressKeepAliveError(context)
  ) {
    return;
  }
  if (
    shouldSuppressKeepAliveError(context) &&
    (resolvedMessage === 'Buffer timeout reached, auto-flushing' ||
      resolvedMessage === 'Flushing event buffer' ||
      resolvedMessage === 'Event buffer activated')
  ) {
    return;
  }

  if (isVerboseWhatsAppLogging(context, target)) {
    if (message === undefined) {
      target[level](payload);
      return;
    }
    target[level](payload, message);
    return;
  }

  if (typeof message === 'string' && message.trim().length > 0) {
    target[level](message);
    return;
  }
  if (typeof payload === 'string' && payload.trim().length > 0) {
    target[level](payload);
    return;
  }
  target[level](`WhatsApp ${level}`);
}

function logWhatsAppMessage(
  context: WhatsAppConnectionContext,
  target: WhatsAppLogger,
  level: Exclude<WhatsAppLogLevel, 'trace'>,
  message: string,
  metadata?: unknown,
): void {
  emitWhatsAppLog(
    context,
    target,
    level,
    metadata === undefined ? message : metadata,
    metadata === undefined ? undefined : message,
  );
}

function createBaileysLogger(
  context: WhatsAppConnectionContext,
  baseLogger: WhatsAppLogger,
): WhatsAppLogger {
  const forward =
    (level: WhatsAppLogLevel) =>
    (payload: unknown, message?: string): void => {
      emitWhatsAppLog(context, baseLogger, level, payload, message);
    };

  return {
    get level() {
      return baseLogger.level;
    },
    child(bindings) {
      return createBaileysLogger(context, baseLogger.child(bindings));
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

function renderWhatsAppPairingQrText(qrPayload: string): string {
  let pairingQrText = '';
  qrcode.generate(qrPayload, { small: true }, (rendered) => {
    pairingQrText = rendered.trimEnd();
  });
  return pairingQrText;
}

export interface WhatsAppConnectionManager {
  getSocket: () => WASocket | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  waitForSocket: () => Promise<WASocket>;
  rememberSentMessage: WhatsAppMessageStore['rememberSentMessage'];
}

async function waitForPendingCredsSave(
  target: WhatsAppLogger,
  pendingSave: Promise<void>,
): Promise<void> {
  let timeoutHandle!: ReturnType<typeof setTimeout>;
  try {
    const outcome = await Promise.race([
      pendingSave.then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve('timeout'),
          STOP_CREDS_SAVE_TIMEOUT_MS,
        );
      }),
    ]);
    if (outcome === 'timeout') {
      target.warn(
        `Timed out waiting ${STOP_CREDS_SAVE_TIMEOUT_MS}ms for WhatsApp credential save during shutdown; continuing.`,
      );
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function createWhatsAppConnectionManager(
  host: WhatsAppTransportHost,
  params?: {
    onSocketCreated?: (socket: WASocket) => void;
  },
): WhatsAppConnectionManager {
  const context: WhatsAppConnectionContext = {
    host,
    expectedTransportDebugLimiter: new host.SlidingWindowRateLimiter(
      EXPECTED_TRANSPORT_DEBUG_WINDOW_MS,
    ),
    lastExpectedTransportAt: 0,
  };
  const childLogger = host.logger.child({
    channel: 'whatsapp',
  }) as WhatsAppLogger;
  const baileysLogger = createBaileysLogger(context, childLogger);
  const messageStore = createWhatsAppMessageStore(host);
  let socket: WASocket | null = null;
  let releaseAuthLock: (() => void) | null = null;
  let started = false;
  let stopped = false;
  let stopGeneration = 0;
  let connectionOpen = false;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectingPromise: Promise<void> | null = null;
  const waiters: Array<{
    resolve: (socket: WASocket) => void;
    reject: (error: Error) => void;
  }> = [];
  let credsSaveQueue: Promise<void> = Promise.resolve();

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

  const scheduleReconnect = (reason: string, error?: unknown): void => {
    if (stopped || reconnectTimer) return;
    const delayMs = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    if (error && host.isExpectedTransportError(error)) {
      logExpectedWhatsAppTransport(
        context,
        childLogger,
        error,
        `whatsapp-reconnect:${reason}`,
        `Retrying connection in ${formatReconnectDelay(delayMs)}.`,
        'warn',
      );
    } else if (
      reason === 'connection-close' ||
      reason === 'status:408' ||
      reason === 'status:428'
    ) {
      const message = `WhatsApp connection was lost. Retrying connection in ${formatReconnectDelay(delayMs)}.`;
      host.pairing.setError(message);
      childLogger.warn(message);
    } else {
      host.pairing.setError(
        `WhatsApp connection is not ready. Retrying connection in ${formatReconnectDelay(delayMs)}.`,
      );
      logWhatsAppMessage(
        context,
        childLogger,
        'warn',
        'WhatsApp reconnect scheduled',
        {
          delayMs,
          reason,
        },
      );
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => undefined);
    }, delayMs);
  };

  const enqueueSaveCreds = (
    saveCreds: () => Promise<void> | void,
  ): Promise<void> => {
    credsSaveQueue = credsSaveQueue
      // Recover from any previous save error so the queue remains alive.
      .catch(() => undefined)
      .then(() => Promise.resolve(saveCreds()))
      .catch((error) => {
        logWhatsAppMessage(
          context,
          childLogger,
          'warn',
          'Failed to persist WhatsApp credentials',
          { error },
        );
      });
    return credsSaveQueue;
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    if (connectingPromise) return connectingPromise;
    connectingPromise = (async () => {
      const { state, saveCreds } = await loadWhatsAppAuthState(host);
      if (stopped) return;
      const latestVersion = await fetchLatestBaileysVersion().catch((error) => {
        logWhatsAppMessage(
          context,
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
        browser: ['HybridClaw', 'Gateway', host.appVersion],
        fireInitQueries: false, // Avoid intermittent 400/bad-request from Baileys fetchProps init query; metadata-only and not required for message flow.
        getMessage: (key) => messageStore.getMessage(key),
        logger: baileysLogger,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        syncFullHistory: false,
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
      attachWhatsAppTransportErrorSinks(context, childLogger, nextSocket.ws);
      params?.onSocketCreated?.(nextSocket);

      nextSocket.ev.on('creds.update', () => {
        void enqueueSaveCreds(saveCreds);
      });

      nextSocket.ev.on(
        'connection.update',
        (update: Partial<ConnectionState>) => {
          void handleConnectionUpdate(nextSocket, update);
        },
      );
    })()
      .catch((error) => {
        if (host.isExpectedTransportError(error)) {
          scheduleReconnect('connect-error', error);
        } else {
          logWhatsAppMessage(
            context,
            childLogger,
            'error',
            'WhatsApp connection attempt failed',
            { error },
          );
          scheduleReconnect('connect-error');
        }
        throw error;
      })
      .finally(() => {
        connectingPromise = null;
      });

    await connectingPromise;
  };

  const startConnectionManager = async (params?: {
    allowRestart?: boolean;
    expectedStopGeneration?: number;
  }): Promise<void> => {
    if (started) return;
    if (
      params?.expectedStopGeneration !== undefined &&
      params.expectedStopGeneration !== stopGeneration
    ) {
      return;
    }
    if (stopped) {
      if (!params?.allowRestart) return;
      stopped = false;
    }
    if (
      params?.expectedStopGeneration !== undefined &&
      params.expectedStopGeneration !== stopGeneration
    ) {
      return;
    }
    if (started) return;
    releaseAuthLock ??= await host.auth.acquireLock(host.auth.authDir, {
      purpose: 'runtime',
    });
    host.pairing.clear();
    started = true;
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    try {
      await connect();
    } catch (error) {
      started = false;
      releaseAuthLock?.();
      releaseAuthLock = null;
      throw error;
    }
  };

  const handleConnectionUpdate = async (
    observedSocket: WASocket,
    update: Partial<ConnectionState>,
  ): Promise<void> => {
    if (socket !== observedSocket) return;

    if (update.qr) {
      host.pairing.setQrText(renderWhatsAppPairingQrText(update.qr));
      logWhatsAppMessage(
        context,
        childLogger,
        'info',
        'Scan the WhatsApp QR code in Linked Devices',
        { appVersion: host.appVersion },
      );
      qrcode.generate(update.qr, { small: true });
    }

    if (update.connection === 'open') {
      host.pairing.clear();
      connectionOpen = true;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      logWhatsAppMessage(
        context,
        childLogger,
        'info',
        'WhatsApp connection established',
        { jid: observedSocket.user?.id || null },
      );
      resolveWaiters(observedSocket);
      return;
    }

    if (update.connection !== 'close') return;

    host.pairing.clear();
    connectionOpen = false;
    socket = null;
    const disconnectError = update.lastDisconnect?.error;
    const statusCode = resolveDisconnectStatusCode(disconnectError);
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
      await host.sleep(0);
      return;
    }

    rejectWaiters(new Error('WhatsApp connection closed'));
    scheduleReconnect(
      statusCode != null ? `status:${statusCode}` : 'connection-close',
      disconnectError,
    );
    await host.sleep(0);
  };

  return {
    getSocket() {
      return socket;
    },
    async start() {
      await startConnectionManager({ allowRestart: true });
    },
    async stop() {
      stopGeneration += 1;
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
      host.pairing.clear();
      if (activeSocket && typeof activeSocket.end === 'function') {
        try {
          activeSocket.end(undefined);
        } catch (error) {
          childLogger.debug({ error }, 'WhatsApp socket shutdown raised');
        }
      }
      await waitForPendingCredsSave(childLogger, credsSaveQueue);
      releaseAuthLock?.();
      releaseAuthLock = null;
      rejectWaiters(new Error('WhatsApp runtime stopped'));
    },
    waitForSocket() {
      if (stopped) {
        return Promise.reject(new Error('WhatsApp runtime stopped'));
      }
      if (socket && connectionOpen) return Promise.resolve(socket);
      const expectedStopGeneration = stopGeneration;
      return new Promise<WASocket>((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (!started) {
          void startConnectionManager({ expectedStopGeneration }).catch(reject);
        }
      });
    },
    async rememberSentMessage(message) {
      await messageStore.rememberSentMessage(message).catch((error) => {
        childLogger.warn(
          { error, messageId: message?.key?.id || null },
          'Failed to persist WhatsApp message for retry replay',
        );
      });
    },
  };
}
