import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { DEFAULT_EMAIL_SUBJECT } from '../src/channels/email/constants.js';
import { useCleanMocks } from './test-utils.js';

const INBOUND_MESSAGE_ID = '<inbound-1@example.com>';
const INBOUND_SUBJECT = 'weekly status b5f8b8885a84';

useCleanMocks({ restoreAllMocks: true, resetModules: true });

type InboundCallback = (
  messages: Array<{ folder: string; raw: Buffer; uid: number }>,
) => Promise<void>;

async function setupRuntime() {
  vi.doMock('../src/config/config.ts', () => ({
    APP_VERSION: '0.7.1',
    DATA_DIR: path.join(os.tmpdir(), 'hybridclaw-test-data'),
    EMAIL_PASSWORD: 'email-app-password',
    EMAIL_TEXT_CHUNK_LIMIT: 50_000,
    getConfigSnapshot: () => ({
      email: {
        enabled: true,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecure: false,
        address: 'agent@example.com',
        password: 'email-app-password',
        pollIntervalMs: 30000,
        folders: ['INBOX'],
        allowFrom: ['boss@example.com'],
        textChunkLimit: 50000,
        mediaMaxMb: 20,
        accounts: [],
      },
    }),
  }));

  // The first SMTP send stays in flight until the test releases it.
  let releaseFirstSend = () => {};
  const firstSendGate = new Promise<void>((resolve) => {
    releaseFirstSend = resolve;
  });
  const sendMail = vi.fn(async (_mail: { subject: string }) => {
    if (sendMail.mock.calls.length === 1) await firstSendGate;
    return { messageId: '<ignored@example.com>' };
  });
  let deliverInbound: InboundCallback | null = null;

  vi.doMock('nodemailer', () => ({
    default: {
      createTransport: vi.fn(() => ({
        close: vi.fn(async () => {}),
        verify: vi.fn(async () => {}),
        sendMail,
      })),
    },
  }));
  vi.doMock('imapflow', () => ({
    ImapFlow: class {
      mailbox = { path: 'Sent' };
      connect = vi.fn(async () => {});
      logout = vi.fn(async () => {});
      close = vi.fn(() => {});
      list = vi.fn(async () => [
        { path: 'Sent', name: 'Sent', flags: new Set<string>() },
      ]);
      getMailboxLock = vi.fn(async (folder: string) => ({
        path: folder,
        release: vi.fn(),
      }));
      search = vi.fn(async () => []);
      append = vi.fn(async () => ({ destination: 'Sent', uid: 7 }));
    },
  }));
  vi.doMock('../src/channels/email/connection.ts', () => ({
    createEmailConnectionManager: vi.fn(
      (_config: unknown, _password: string, callback: InboundCallback) => {
        deliverInbound = callback;
        return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      },
    ),
  }));
  vi.doMock('../src/channels/email/inbound.ts', () => ({
    cleanupEmailInboundMedia: vi.fn(async () => {}),
    processInboundEmail: vi.fn(async () => ({
      sessionId: 'agent:main:channel:email:chat:dm:peer:boss%40example.com',
      agentId: 'main',
      guildId: null,
      channelId: 'boss@example.com',
      userId: 'boss@example.com',
      username: 'Boss',
      content: 'Please reply in-thread with a short confirmation.',
      media: [],
      senderAddress: 'boss@example.com',
      senderName: 'Boss',
      subject: INBOUND_SUBJECT,
      threadContext: {
        subject: INBOUND_SUBJECT,
        messageId: INBOUND_MESSAGE_ID,
        references: [],
      },
    })),
  }));

  const { createEmailRuntime } = await import(
    '../src/channels/email/runtime.js'
  );
  return {
    runtime: createEmailRuntime(),
    sendMail,
    releaseFirstSend,
    deliverInbound: () =>
      deliverInbound?.([{ folder: 'INBOX', raw: Buffer.from('raw'), uid: 1 }]),
  };
}

test('keeps turn replies on the inbound thread when a send to the same peer finishes mid-turn', async () => {
  const { runtime, sendMail, releaseFirstSend, deliverInbound } =
    await setupRuntime();

  await runtime.initEmail(async (...args) => {
    const reply = args[7] as (text: string) => Promise<void>;
    releaseFirstSend();
    await scheduledSend;
    await runtime.sendToEmail('boss@example.com', 'Received, thanks.');
    await reply('Done.');
  });

  // A scheduled delivery to the peer starts before its mail is polled, then
  // completes while the agent is still answering that mail.
  const scheduledSend = runtime.sendToEmail('boss@example.com', 'Briefing');
  await deliverInbound();

  const subjects = sendMail.mock.calls.map(([mail]) => mail.subject);
  expect(subjects).toEqual([
    DEFAULT_EMAIL_SUBJECT,
    `Re: ${INBOUND_SUBJECT}`,
    `Re: ${INBOUND_SUBJECT}`,
  ]);
  expect(sendMail.mock.calls[1]?.[0]).toMatchObject({
    inReplyTo: INBOUND_MESSAGE_ID,
  });
});
