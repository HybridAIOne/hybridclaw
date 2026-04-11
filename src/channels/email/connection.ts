import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { DATA_DIR } from '../../config/config.js';
import type { RuntimeEmailConfig } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const EMAIL_CURSOR_STATE_DIR = path.join(DATA_DIR, 'email');
const EMAIL_CURSOR_STATE_VERSION = 1;

export interface EmailFetchedMessage {
  folder: string;
  uid: number;
  raw: Buffer;
}

export interface EmailConnectionManager {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface PersistedFolderCursorState {
  uidValidity: string | null;
  lastProcessedUid: number;
}

function resolveFolders(folders: string[]): string[] {
  const resolved = folders
    .map((folder) => String(folder || '').trim())
    .filter(Boolean);
  return resolved.length > 0 ? [...new Set(resolved)] : ['INBOX'];
}

function resolveCursorStatePath(address: string): string {
  const encodedAddress = Buffer.from(
    String(address || '')
      .trim()
      .toLowerCase(),
  )
    .toString('base64url')
    .replace(/=+$/g, '');
  return path.join(
    EMAIL_CURSOR_STATE_DIR,
    `${encodedAddress || 'default'}-cursor-state.json`,
  );
}

function resolveMailboxUidNext(client: ImapFlow): number {
  return Math.max(1, client.mailbox ? client.mailbox.uidNext : 1);
}

function resolveMailboxUidValidity(client: ImapFlow): string | null {
  return client.mailbox
    ? normalizeUidValidity(client.mailbox.uidValidity)
    : null;
}

function normalizeUidValidity(
  value: bigint | string | null | undefined,
): string | null {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeLastProcessedUid(value: unknown): number {
  const normalized = Math.max(0, Math.trunc(Number(value) || 0));
  return Number.isFinite(normalized) ? normalized : 0;
}

async function loadPersistedFolderCursorState(
  address: string,
): Promise<Map<string, PersistedFolderCursorState>> {
  const statePath = resolveCursorStatePath(address);
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      version?: number;
      folders?: Record<
        string,
        {
          uidValidity?: string | null;
          lastProcessedUid?: number;
        }
      >;
    };
    if (parsed.version !== EMAIL_CURSOR_STATE_VERSION || !parsed.folders) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed.folders).map(([folder, state]) => [
        folder,
        {
          uidValidity: normalizeUidValidity(state?.uidValidity),
          lastProcessedUid: normalizeLastProcessedUid(state?.lastProcessedUid),
        },
      ]),
    );
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
    if (code === 'ENOENT') {
      return new Map();
    }
    logger.warn({ error, statePath }, 'Failed to read email cursor state');
    return new Map();
  }
}

async function savePersistedFolderCursorState(
  address: string,
  state: Map<string, PersistedFolderCursorState>,
): Promise<void> {
  const statePath = resolveCursorStatePath(address);
  const serialized = {
    version: EMAIL_CURSOR_STATE_VERSION,
    folders: Object.fromEntries(
      [...state.entries()].map(([folder, cursor]) => [
        folder,
        {
          uidValidity: cursor.uidValidity,
          lastProcessedUid: cursor.lastProcessedUid,
        },
      ]),
    ),
  };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(serialized, null, 2));
}

export function createEmailConnectionManager(
  config: RuntimeEmailConfig,
  password: string,
  onNewMessages: (messages: EmailFetchedMessage[]) => Promise<void>,
): EmailConnectionManager {
  const childLogger = logger.child({ channel: 'email' });
  const folders = resolveFolders(config.folders);
  const persistedCursorState = new Map<string, PersistedFolderCursorState>();

  let client: ImapFlow | null = null;
  let started = false;
  let stopped = false;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let connectingPromise: Promise<void> | null = null;
  let stateLoaded = false;

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
    if (!stateLoaded) {
      const loadedState = await loadPersistedFolderCursorState(config.address);
      for (const [folder, cursor] of loadedState.entries()) {
        persistedCursorState.set(folder, cursor);
      }
      stateLoaded = true;
    }

    for (const folder of folders) {
      const lock = await activeClient.getMailboxLock(folder);
      lock.release();
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
      const uidValidity = resolveMailboxUidValidity(activeClient);
      const storedCursor = persistedCursorState.get(folder);
      let lastProcessedUid =
        storedCursor && storedCursor.uidValidity === uidValidity
          ? storedCursor.lastProcessedUid
          : 0;

      const maxKnownUid = resolveMailboxUidNext(activeClient) - 1;
      if (maxKnownUid <= lastProcessedUid) {
        if (
          !storedCursor ||
          storedCursor.uidValidity !== uidValidity ||
          storedCursor.lastProcessedUid !== lastProcessedUid
        ) {
          persistedCursorState.set(folder, {
            uidValidity,
            lastProcessedUid,
          });
          await savePersistedFolderCursorState(
            config.address,
            persistedCursorState,
          );
        }
        return;
      }

      const allUids =
        (await activeClient.search({ all: true }, { uid: true })) || [];
      const pending = [...new Set(allUids)]
        .filter((uid) => uid > lastProcessedUid)
        .sort((left, right) => left - right);
      if (pending.length === 0) {
        if (!storedCursor || storedCursor.uidValidity !== uidValidity) {
          persistedCursorState.set(folder, {
            uidValidity,
            lastProcessedUid: maxKnownUid,
          });
          await savePersistedFolderCursorState(
            config.address,
            persistedCursorState,
          );
        }
        return;
      }

      for (const uid of pending) {
        const message = await fetchOneMessage(folder, uid);
        if (!message) {
          lastProcessedUid = uid;
          persistedCursorState.set(folder, {
            uidValidity,
            lastProcessedUid,
          });
          await savePersistedFolderCursorState(
            config.address,
            persistedCursorState,
          );
          continue;
        }

        await onNewMessages([message]);
        lastProcessedUid = uid;
        persistedCursorState.set(folder, {
          uidValidity,
          lastProcessedUid,
        });
        await savePersistedFolderCursorState(
          config.address,
          persistedCursorState,
        );
        try {
          await activeClient.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        } catch (error) {
          childLogger.warn(
            { error, folder, uid },
            'Failed to mark processed email as seen',
          );
        }
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
        secure: config.imapSecure,
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
      persistedCursorState.clear();
      stateLoaded = false;
      await closeClient();
    },
  };
}
