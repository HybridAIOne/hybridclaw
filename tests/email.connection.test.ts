import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const BASE_EMAIL_CONFIG = {
  enabled: true,
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
  address: 'agent@example.com',
  pollIntervalMs: 30_000,
  folders: ['INBOX'],
  allowFrom: ['*'],
  textChunkLimit: 50_000,
  mediaMaxMb: 20,
};

const makeTempDir = useTempDir();

useCleanMocks({
  resetModules: true,
  unmock: ['imapflow', '../src/config/config.js'],
});

describe('email connection manager', () => {
  test('seeds a missing cursor from the current mailbox head and only processes later UIDs', async () => {
    const dataDir = makeTempDir('hybridclaw-email-connection-');

    let mailboxUids = [1, 2];
    let uidNext = 3;
    const processedUids: number[] = [];
    const search = vi.fn(async () => [...mailboxUids]);
    const messageFlagsAdd = vi.fn(async () => true);
    const fetch = vi.fn(async function* (uids: number[]) {
      for (const uid of uids) {
        yield {
          uid,
          source: Buffer.from(`raw-${uid}`, 'utf8'),
        };
      }
    });

    vi.doMock('../src/config/config.js', () => ({
      DATA_DIR: dataDir,
    }));
    vi.doMock('imapflow', () => ({
      ImapFlow: class {
        mailbox = {
          path: 'INBOX',
          uidNext,
          uidValidity: 1n,
        };
        connect = vi.fn(async () => {});
        logout = vi.fn(async () => {});
        close = vi.fn(() => {});
        removeAllListeners = vi.fn(() => {});
        on = vi.fn(() => this);
        getMailboxLock = vi.fn(async (folder: string) => {
          this.mailbox = {
            path: folder,
            uidNext,
            uidValidity: 1n,
          };
          return {
            release: vi.fn(),
          };
        });
        search = search;
        fetch = fetch;
        messageFlagsAdd = messageFlagsAdd;
      },
    }));

    const { createEmailConnectionManager } = await import(
      '../src/channels/email/connection.js'
    );

    const runManager = async () => {
      const manager = createEmailConnectionManager(
        BASE_EMAIL_CONFIG,
        'secret',
        async (messages) => {
          for (const message of messages) {
            processedUids.push(message.uid);
          }
        },
      );
      await manager.start();
      await manager.stop();
    };

    await runManager();

    expect(search).not.toHaveBeenCalled();
    expect(processedUids).toEqual([]);
    expect(messageFlagsAdd).not.toHaveBeenCalled();

    processedUids.length = 0;
    await runManager();
    expect(processedUids).toEqual([]);

    mailboxUids = [1, 2, 3];
    uidNext = 4;
    await runManager();
    expect(processedUids).toEqual([3]);
    expect(search).toHaveBeenCalledWith({ all: true }, { uid: true });
    expect(messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(messageFlagsAdd).toHaveBeenCalledWith([3], ['\\Seen'], {
      uid: true,
    });
  });

  test('resumes from a saved cursor and processes messages that arrived while offline', async () => {
    const dataDir = makeTempDir('hybridclaw-email-connection-');

    const cursorStatePath = path.join(
      dataDir,
      'email',
      `${Buffer.from(BASE_EMAIL_CONFIG.address).toString('base64url').replace(/=+$/g, '')}-cursor-state.json`,
    );
    fs.mkdirSync(path.dirname(cursorStatePath), { recursive: true });
    fs.writeFileSync(
      cursorStatePath,
      JSON.stringify(
        {
          version: 1,
          folders: {
            INBOX: {
              uidValidity: '1',
              lastProcessedUid: 1,
            },
          },
        },
        null,
        2,
      ),
    );

    const processedUids: number[] = [];
    const search = vi.fn(async () => [1, 2, 3]);
    const messageFlagsAdd = vi.fn(async () => true);
    const fetch = vi.fn(async function* (uids: number[]) {
      for (const uid of uids) {
        yield {
          uid,
          source: Buffer.from(`raw-${uid}`, 'utf8'),
        };
      }
    });

    vi.doMock('../src/config/config.js', () => ({
      DATA_DIR: dataDir,
    }));
    vi.doMock('imapflow', () => ({
      ImapFlow: class {
        mailbox = {
          path: 'INBOX',
          uidNext: 4,
          uidValidity: 1n,
        };
        connect = vi.fn(async () => {});
        logout = vi.fn(async () => {});
        close = vi.fn(() => {});
        removeAllListeners = vi.fn(() => {});
        on = vi.fn(() => this);
        getMailboxLock = vi.fn(async (folder: string) => {
          this.mailbox = {
            path: folder,
            uidNext: 4,
            uidValidity: 1n,
          };
          return {
            release: vi.fn(),
          };
        });
        search = search;
        fetch = fetch;
        messageFlagsAdd = messageFlagsAdd;
      },
    }));

    const { createEmailConnectionManager } = await import(
      '../src/channels/email/connection.js'
    );
    const manager = createEmailConnectionManager(
      BASE_EMAIL_CONFIG,
      'secret',
      async (messages) => {
        for (const message of messages) {
          processedUids.push(message.uid);
        }
      },
    );

    await manager.start();
    await manager.stop();

    expect(search).toHaveBeenCalledWith({ all: true }, { uid: true });
    expect(processedUids).toEqual([2, 3]);
    expect(messageFlagsAdd).toHaveBeenNthCalledWith(1, [2], ['\\Seen'], {
      uid: true,
    });
    expect(messageFlagsAdd).toHaveBeenNthCalledWith(2, [3], ['\\Seen'], {
      uid: true,
    });
  });
});
