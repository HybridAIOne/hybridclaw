import { ImapFlow } from 'imapflow';
import type { RuntimeEmailConfig } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import { createEmailDedupSet, type EmailDedupSet } from './dedup.js';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface EmailFetchedMessage {
  folder: string;
  uid: number;
  raw: Buffer;
}

export interface EmailConnectionManager {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

function resolveFolders(folders: string[]): string[] {
  const resolved = folders
    .map((folder) => String(folder || '').trim())
    .filter(Boolean);
  return resolved.length > 0 ? [...new Set(resolved)] : ['INBOX'];
}

function buildDedupKey(folder: string, uid: number): string {
  return `${folder}:${uid}`;
}

function resolveMailboxUidNext(client: ImapFlow): number {
  return Math.max(1, client.mailbox ? client.mailbox.uidNext : 1);
}

export function createEmailConnectionManager(
  config: RuntimeEmailConfig,
  password: string,
  onNewMessages: (messages: EmailFetchedMessage[]) => Promise<void>,
): EmailConnectionManager {
  const childLogger = logger.child({ channel: 'email' });
  const folders = resolveFolders(config.folders);
  const dedup: EmailDedupSet = createEmailDedupSet();
  const startupUidNext = new Map<string, number>();

  let client: ImapFlow | null = null;
  let started = false;
  let stopped = false;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let connectingPromise: Promise<void> | null = null;

  const clearPollTimer = (): void => {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = null;
  };

  const clearReconnectTimer = (): void => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const closeClient = async (): Promise<void> => {
    const activeClient = client;
    client = null;
    if (!activeClient) return;
    activeClient.removeAllListeners();
    await activeClient.logout().catch((error) => {
      childLogger.debug({ error }, 'Email IMAP logout failed');
    });
  };

  const scheduleReconnect = (reason: string, error?: unknown): void => {
    clearPollTimer();
    void closeClient();
    if (stopped || reconnectTimer) return;

    const delayMs = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    childLogger.warn({ delayMs, reason, error }, 'Email reconnect scheduled');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const scheduleNextPoll = (): void => {
    if (stopped || pollTimer) return;
    pollTimer = setTimeout(
      () => {
        pollTimer = null;
        void pollInbox();
      },
      Math.max(1_000, config.pollIntervalMs),
    );
  };

  const initializeFolders = async (): Promise<void> => {
    const activeClient = client;
    if (!activeClient) return;

    for (const folder of folders) {
      const lock = await activeClient.getMailboxLock(folder);
      try {
        if (!startupUidNext.has(folder)) {
          startupUidNext.set(folder, resolveMailboxUidNext(activeClient));
        }
      } finally {
        lock.release();
      }
    }
  };

  const fetchOneMessage = async (
    folder: string,
    uid: number,
  ): Promise<EmailFetchedMessage | null> => {
    const activeClient = client;
    if (!activeClient) return null;

    for await (const message of activeClient.fetch(
      [uid],
      { source: true },
      { uid: true },
    )) {
      if (!Buffer.isBuffer(message.source)) continue;
      return {
        folder,
        uid: message.uid,
        raw: message.source,
      };
    }
    return null;
  };

  const pollFolder = async (folder: string): Promise<void> => {
    const activeClient = client;
    if (!activeClient) return;

    const lock = await activeClient.getMailboxLock(folder);
    try {
      const baselineUid =
        startupUidNext.get(folder) ?? resolveMailboxUidNext(activeClient);
      if (!startupUidNext.has(folder)) {
        startupUidNext.set(folder, baselineUid);
      }

      const unseen = await activeClient.search({ seen: false }, { uid: true });
      if (!Array.isArray(unseen) || unseen.length === 0) return;

      const pending = unseen
        .filter((uid) => uid >= baselineUid)
        .sort((left, right) => left - right);

      for (const uid of pending) {
        const dedupKey = buildDedupKey(folder, uid);
        if (dedup.has(dedupKey)) {
          startupUidNext.set(
            folder,
            Math.max(startupUidNext.get(folder) || baselineUid, uid + 1),
          );
          continue;
        }

        const message = await fetchOneMessage(folder, uid);
        if (!message) continue;

        await onNewMessages([message]);
        await activeClient.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        dedup.add(dedupKey);
        startupUidNext.set(
          folder,
          Math.max(startupUidNext.get(folder) || baselineUid, uid + 1),
        );
      }
    } finally {
      lock.release();
    }
  };

  const pollInbox = async (): Promise<void> => {
    if (stopped) return;

    try {
      if (!client) {
        scheduleReconnect('missing-client');
        return;
      }
      for (const folder of folders) {
        await pollFolder(folder);
      }
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      scheduleNextPoll();
    } catch (error) {
      scheduleReconnect('poll-error', error);
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    if (connectingPromise) return connectingPromise;

    connectingPromise = (async () => {
      const nextClient = new ImapFlow({
        host: config.imapHost,
        port: config.imapPort,
        secure: config.imapPort === 993,
        auth: {
          user: config.address,
          pass: password,
        },
        logger: childLogger,
      });

      nextClient.on('close', () => {
        if (stopped) return;
        scheduleReconnect('client-closed');
      });
      nextClient.on('error', (error) => {
        if (stopped) return;
        scheduleReconnect('client-error', error);
      });

      await nextClient.connect();
      if (stopped) {
        await nextClient.logout().catch(() => {});
        return;
      }

      client = nextClient;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      await initializeFolders();
      await pollInbox();
    })()
      .catch((error) => {
        scheduleReconnect('connect-error', error);
        throw error;
      })
      .finally(() => {
        connectingPromise = null;
      });

    await connectingPromise;
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;
      await connect();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      started = false;
      clearPollTimer();
      clearReconnectTimer();
      dedup.clear();
      startupUidNext.clear();
      await closeClient();
    },
  };
}
