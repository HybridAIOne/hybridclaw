import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

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

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('imapflow');
  vi.doUnmock('../src/config/config.js');
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) continue;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('email connection manager', () => {
  test('processes existing folder messages once and resumes from the saved UID cursor', async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-email-connection-'),
    );
    tempDirs.push(dataDir);

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

    expect(search).toHaveBeenCalledWith({ all: true }, { uid: true });
    expect(processedUids).toEqual([1, 2]);
    expect(messageFlagsAdd).toHaveBeenNthCalledWith(1, [1], ['\\Seen'], {
      uid: true,
    });
    expect(messageFlagsAdd).toHaveBeenNthCalledWith(2, [2], ['\\Seen'], {
      uid: true,
    });

    processedUids.length = 0;
    await runManager();
    expect(processedUids).toEqual([]);

    mailboxUids = [1, 2, 3];
    uidNext = 4;
    await runManager();
    expect(processedUids).toEqual([3]);
  });
});
