import { Client, TalkMessage } from '@jsr/evex__linejs';
import { BaseClient } from '@jsr/evex__linejs/base';
import { FileStorage } from '@jsr/evex__linejs/storage';
import qrcode from 'qrcode-terminal';
import { logger } from '../../logger.js';
import {
  acquireLineAuthLock,
  ensureLineAuthStoragePath,
  LINE_AUTH_STORAGE_KEY,
  LINE_PROFILE_MID_STORAGE_KEY,
  LINE_SYNC_STORAGE_KEY,
} from './auth.js';
import {
  clearLinePairingState,
  setLinePairingError,
  setLinePairingPincode,
  setLinePairingQr,
} from './pairing-state.js';

type LineMessageListener = (message: TalkMessage) => void | Promise<void>;

export interface LineConnectionManager {
  getClient: () => Client | null;
  getSelfMid: () => string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  waitForClient: () => Promise<Client>;
}

function renderLinePairingQrText(url: string): string {
  let text = '';
  qrcode.generate(url, { small: true }, (rendered) => {
    text = rendered.trimEnd();
  });
  return text;
}

function serializeSyncState(sync: BaseClient['poll']['sync']): string {
  return JSON.stringify(sync, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

function parseRevision(value: unknown): number | bigint | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

function restoreSyncState(base: BaseClient, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return;
  try {
    const parsed = JSON.parse(value) as {
      square?: unknown;
      talk?: {
        revision?: unknown;
        globalRev?: unknown;
        individualRev?: unknown;
      };
    };
    base.poll.sync = {
      ...(typeof parsed.square === 'string' ? { square: parsed.square } : {}),
      talk: {
        revision: parseRevision(parsed.talk?.revision),
        globalRev: parseRevision(parsed.talk?.globalRev),
        individualRev: parseRevision(parsed.talk?.individualRev),
      },
    };
  } catch (error) {
    logger.warn({ error }, 'Ignoring invalid persisted LINE sync state');
  }
}

export function createLineConnectionManager(params?: {
  onMessage?: LineMessageListener;
}): LineConnectionManager {
  const childLogger = logger.child({ channel: 'line' });
  let client: Client | null = null;
  let base: BaseClient | null = null;
  let selfMid: string | null = null;
  let releaseAuthLock: (() => void) | null = null;
  let connectingPromise: Promise<Client> | null = null;
  let eventLoopPromise: Promise<void> | null = null;
  let fetchAbortController: AbortController | null = null;
  let stopped = false;
  const seenMessageIds = new Set<string>();

  const runEventLoop = async (connectedClient: Client): Promise<void> => {
    const stream = connectedClient.base.poll.listenTalkEvents();
    try {
      for await (const event of stream) {
        if (stopped) return;
        if (event.type !== 'SEND_MESSAGE' && event.type !== 'RECEIVE_MESSAGE') {
          continue;
        }
        const messageId = String(event.message?.id || '').trim();
        if (messageId && seenMessageIds.has(messageId)) continue;
        try {
          const raw = await connectedClient.base.e2ee.decryptE2EEMessage(
            event.message,
          );
          if (messageId) {
            seenMessageIds.add(messageId);
            if (seenMessageIds.size > 1_000) {
              const oldest = seenMessageIds.values().next().value;
              if (oldest) seenMessageIds.delete(oldest);
            }
          }
          await params?.onMessage?.(
            new TalkMessage({ raw, client: connectedClient }),
          );
        } catch (error) {
          childLogger.warn(
            { error, messageId: event.message?.id || null },
            'Failed to process LINE message event',
          );
        }
      }
    } catch (error) {
      if (!stopped) {
        setLinePairingError('LINE event stream stopped unexpectedly.');
        childLogger.warn({ error }, 'LINE event stream failed');
      }
    }
  };

  const connect = async (): Promise<Client> => {
    const storagePath = await ensureLineAuthStoragePath();
    const storage = new FileStorage(storagePath);
    fetchAbortController = new AbortController();
    const nextBase = new BaseClient({
      device: 'ANDROIDSECONDARY',
      storage,
      fetch: (request) =>
        fetch(new Request(request, { signal: fetchAbortController?.signal })),
    });
    base = nextBase;

    nextBase.on('qrcall', (url) => {
      const pairingQrText = renderLinePairingQrText(url);
      setLinePairingQr({ text: pairingQrText, url });
      childLogger.warn(
        'LINE personal-account QR login is unofficial and may cause account restrictions. Scan only if you accept that risk.',
      );
      qrcode.generate(url, { small: true });
    });
    nextBase.on('pincall', (pincode) => {
      setLinePairingPincode(pincode);
      childLogger.info(`Confirm LINE login with PIN ${pincode}.`);
    });
    nextBase.on('update:authtoken', (authToken) => {
      void storage.set(LINE_AUTH_STORAGE_KEY, authToken);
    });
    nextBase.on('update:syncdata', (sync) => {
      void storage.set(LINE_SYNC_STORAGE_KEY, serializeSyncState(sync));
    });

    restoreSyncState(nextBase, await storage.get(LINE_SYNC_STORAGE_KEY));
    const cachedToken = await storage.get(LINE_AUTH_STORAGE_KEY);
    await nextBase.loginProcess.login(
      typeof cachedToken === 'string' && cachedToken.trim()
        ? { authToken: cachedToken }
        : { qr: true },
    );
    if (stopped) throw new Error('LINE runtime stopped during login.');

    const nextClient = new Client(nextBase);
    const mid = String(nextBase.profile?.mid || '')
      .trim()
      .toLowerCase();
    if (!mid) throw new Error('LINE login succeeded without a profile MID.');
    await storage.set(LINE_AUTH_STORAGE_KEY, nextClient.authToken);
    await storage.set(LINE_PROFILE_MID_STORAGE_KEY, mid);
    selfMid = mid;
    client = nextClient;
    clearLinePairingState();
    eventLoopPromise = runEventLoop(nextClient);
    childLogger.info({ mid }, 'LINE personal-account connection established');
    return nextClient;
  };

  return {
    getClient: () => client,
    getSelfMid: () => selfMid,
    async start() {
      if (connectingPromise || client) return;
      stopped = false;
      releaseAuthLock = await acquireLineAuthLock();
      clearLinePairingState();
      connectingPromise = connect();
      void connectingPromise.catch((error) => {
        if (stopped) return;
        const message =
          error instanceof Error ? error.message : 'Unknown LINE login error';
        setLinePairingError(message);
        childLogger.error({ error }, 'LINE connection failed');
      });
    },
    async stop() {
      stopped = true;
      fetchAbortController?.abort();
      if (base) {
        base.authToken = undefined;
        base.push.opStream.close();
        for (const connection of base.push.conns) {
          connection.close();
        }
      }
      await connectingPromise?.catch(() => undefined);
      await eventLoopPromise?.catch(() => undefined);
      clearLinePairingState();
      client = null;
      base = null;
      selfMid = null;
      connectingPromise = null;
      eventLoopPromise = null;
      fetchAbortController = null;
      seenMessageIds.clear();
      releaseAuthLock?.();
      releaseAuthLock = null;
    },
    async waitForClient() {
      if (client) return client;
      if (!connectingPromise) await this.start();
      if (!connectingPromise) throw new Error('LINE connection did not start.');
      return connectingPromise;
    },
  };
}
