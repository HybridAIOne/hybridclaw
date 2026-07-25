import { Client, TalkMessage } from '@jsr/evex__linejs';
import { BaseClient } from '@jsr/evex__linejs/base';
import { FileStorage } from '@jsr/evex__linejs/storage';
import qrcode from 'qrcode-terminal';

/**
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').LineTransportHost} LineTransportHost
 */

/**
 * @param {string} url
 * @returns {string}
 */
function renderLinePairingQrText(url) {
  let text = '';
  qrcode.generate(url, { small: true }, (rendered) => {
    text = rendered.trimEnd();
  });
  return text;
}

function serializeSyncState(sync) {
  return JSON.stringify(sync, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

function parseRevision(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

/**
 * @param {LineTransportHost} host
 * @param {InstanceType<typeof BaseClient>} base
 * @param {unknown} value
 */
function restoreSyncState(host, base, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  try {
    const parsed = JSON.parse(value);
    base.poll.sync = {
      ...(typeof parsed.square === 'string' ? { square: parsed.square } : {}),
      talk: {
        revision: parseRevision(parsed.talk?.revision),
        globalRev: parseRevision(parsed.talk?.globalRev),
        individualRev: parseRevision(parsed.talk?.individualRev),
      },
    };
  } catch (error) {
    host.logger.warn({ error }, 'Ignoring invalid persisted LINE sync state');
  }
}

/**
 * @param {LineTransportHost} host
 * @param {{ onMessage?: (message: TalkMessage) => void | Promise<void> }} [params]
 */
export function createLineConnectionManager(host, params) {
  const childLogger = host.logger.child({ channel: 'line' });
  let client = null;
  let base = null;
  let selfMid = null;
  let releaseAuthLock = null;
  let connectingPromise = null;
  let eventLoopPromise = null;
  let fetchAbortController = null;
  let stopped = false;
  const seenMessageIds = new Set();

  const runEventLoop = async (connectedClient) => {
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
        host.pairing.setError('LINE event stream stopped unexpectedly.');
        childLogger.warn({ error }, 'LINE event stream failed');
      }
    }
  };

  const connect = async () => {
    const storagePath = await host.auth.ensureStoragePath();
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
      host.pairing.setQr({ text: pairingQrText, url });
      childLogger.warn(
        'LINE personal-account QR login is unofficial and may cause account restrictions. Scan only if you accept that risk.',
      );
      qrcode.generate(url, { small: true });
    });
    nextBase.on('pincall', (pincode) => {
      host.pairing.setPincode(pincode);
      childLogger.info(`Confirm LINE login with PIN ${pincode}.`);
    });
    nextBase.on('update:authtoken', (authToken) => {
      void storage.set(host.auth.storageKeys.authToken, authToken);
    });
    nextBase.on('update:syncdata', (sync) => {
      void storage.set(host.auth.storageKeys.sync, serializeSyncState(sync));
    });

    restoreSyncState(
      host,
      nextBase,
      await storage.get(host.auth.storageKeys.sync),
    );
    const cachedToken = await storage.get(host.auth.storageKeys.authToken);
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
    await storage.set(host.auth.storageKeys.authToken, nextClient.authToken);
    await storage.set(host.auth.storageKeys.profileMid, mid);
    selfMid = mid;
    client = nextClient;
    host.pairing.clear();
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
      releaseAuthLock = await host.auth.acquireLock();
      host.pairing.clear();
      connectingPromise = connect();
      void connectingPromise.catch((error) => {
        if (stopped) return;
        const message =
          error instanceof Error ? error.message : 'Unknown LINE login error';
        host.pairing.setError(message);
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
      host.pairing.clear();
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
