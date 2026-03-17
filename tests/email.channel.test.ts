import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  isEmailAddress,
  matchesEmailAllowList,
  normalizeEmailAddress,
} from '../src/channels/email/allowlist.js';
import { createEmailDedupSet } from '../src/channels/email/dedup.js';
import {
  cleanupEmailInboundMedia,
  processInboundEmail,
} from '../src/channels/email/inbound.js';
import {
  createOutboundThreadContext,
  createThreadTracker,
  ensureReplySubject,
} from '../src/channels/email/threading.js';

const BASE_EMAIL_CONFIG = {
  enabled: true,
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
  address: 'agent@example.com',
  pollIntervalMs: 30000,
  folders: ['INBOX'],
  allowFrom: ['boss@example.com'],
  textChunkLimit: 50000,
  mediaMaxMb: 20,
};

function buildMultipartEmail(params: {
  from: string;
  inReplyTo?: string;
  messageId: string;
  subject: string;
  text: string;
}): string {
  return [
    `From: ${params.from}`,
    'To: Agent <agent@example.com>',
    `Subject: ${params.subject}`,
    `Message-ID: ${params.messageId}`,
    ...(params.inReplyTo ? [`In-Reply-To: ${params.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="EMAIL-BOUNDARY"',
    '',
    '--EMAIL-BOUNDARY',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    params.text,
    '--EMAIL-BOUNDARY',
    'Content-Type: text/plain; name="plan.txt"',
    'Content-Disposition: attachment; filename="plan.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('quarterly plan').toString('base64'),
    '--EMAIL-BOUNDARY--',
    '',
  ].join('\r\n');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('email allowlist helpers', () => {
  test('normalizes and validates email addresses', () => {
    expect(normalizeEmailAddress('Boss <BOSS@example.com>')).toBe(
      'boss@example.com',
    );
    expect(isEmailAddress('ops@example.com')).toBe(true);
    expect(normalizeEmailAddress('not-an-email')).toBeNull();
  });

  test('matches exact, wildcard-domain, and global allowlist entries', () => {
    expect(
      matchesEmailAllowList(['boss@example.com'], 'boss@example.com'),
    ).toBe(true);
    expect(matchesEmailAllowList(['*@example.com'], 'boss@example.com')).toBe(
      true,
    );
    expect(matchesEmailAllowList(['*'], 'boss@other.com')).toBe(true);
    expect(matchesEmailAllowList([], 'boss@example.com')).toBe(false);
  });
});

describe('email dedup set', () => {
  test('deduplicates entries and evicts the oldest when full', () => {
    const dedup = createEmailDedupSet(2);

    expect(dedup.add('inbox:1')).toBe(true);
    expect(dedup.add('inbox:1')).toBe(false);
    expect(dedup.add('inbox:2')).toBe(true);
    expect(dedup.has('inbox:1')).toBe(true);
    expect(dedup.add('inbox:3')).toBe(true);
    expect(dedup.has('inbox:1')).toBe(false);
    expect(dedup.size()).toBe(2);
  });
});

describe('email threading helpers', () => {
  test('tracks the latest thread context per sender', () => {
    const tracker = createThreadTracker();
    tracker.remember('boss@example.com', {
      subject: 'Quarterly plan',
      messageId: '<msg-1@example.com>',
      references: ['<ref-1@example.com>'],
    });

    const next = createOutboundThreadContext(
      tracker.get('boss@example.com'),
      '<msg-2@example.com>',
      ensureReplySubject('Quarterly plan'),
    );
    expect(next).toEqual({
      subject: 'Re: Quarterly plan',
      messageId: '<msg-2@example.com>',
      references: ['<ref-1@example.com>', '<msg-1@example.com>'],
    });
  });
});

describe('email inbound parsing', () => {
  test('ignores self-messages and blocked senders', async () => {
    const raw = [
      'From: Agent <agent@example.com>',
      'To: Agent <agent@example.com>',
      'Subject: Hello',
      'Message-ID: <self@example.com>',
      '',
      'self message',
      '',
    ].join('\r\n');

    await expect(
      processInboundEmail(raw, BASE_EMAIL_CONFIG, 'agent@example.com'),
    ).resolves.toBeNull();

    const blocked = await processInboundEmail(
      raw.replace('Agent <agent@example.com>', 'Other <other@example.com>'),
      BASE_EMAIL_CONFIG,
      'agent@example.com',
    );
    expect(blocked).toBeNull();
  });

  test('parses subject context, threading headers, and attachments', async () => {
    const result = await processInboundEmail(
      buildMultipartEmail({
        from: 'Boss <boss@example.com>',
        messageId: '<msg-1@example.com>',
        subject: 'Quarterly plan',
        text: 'Please review the attachment.',
      }),
      BASE_EMAIL_CONFIG,
      'agent@example.com',
    );

    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(
      'agent:main:channel:email:chat:dm:peer:boss%40example.com',
    );
    expect(result?.content).toContain('[Subject: Quarterly plan]');
    expect(result?.content).toContain('Please review the attachment.');
    expect(result?.media).toHaveLength(1);
    expect(result?.threadContext).toEqual({
      subject: 'Quarterly plan',
      messageId: '<msg-1@example.com>',
      references: [],
    });
    expect(result?.media[0]?.filename).toBe('plan.txt');
    expect(fs.existsSync(result?.media[0]?.path || '')).toBe(true);

    if (result) {
      await cleanupEmailInboundMedia(result.media);
      expect(fs.existsSync(result.media[0]?.path || '')).toBe(false);
    }
  });

  test('omits the subject prefix for reply threads', async () => {
    const result = await processInboundEmail(
      buildMultipartEmail({
        from: 'Boss <boss@example.com>',
        inReplyTo: '<msg-0@example.com>',
        messageId: '<msg-1@example.com>',
        subject: 'Re: Quarterly plan',
        text: 'Thanks for the update.',
      }),
      BASE_EMAIL_CONFIG,
      'agent@example.com',
    );

    expect(result?.content.startsWith('[Subject:')).toBe(false);
    expect(result?.threadContext?.references).toEqual(['<msg-0@example.com>']);

    if (result) {
      await cleanupEmailInboundMedia(result.media);
    }
  });
});

describe('email delivery helpers', () => {
  test('renders multipart html from lightweight email formatting', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const { sendEmail } = await import('../src/channels/email/delivery.js');
    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-html@example.com>',
      })),
    };

    await sendEmail({
      transport,
      to: 'boss@example.com',
      body: [
        'Executive summary:',
        '',
        '- *HybridAI GmbH* registration updated',
        '- `message` reads now route correctly',
        '',
        '-- ',
        '',
        '*Hybot*',
        'Personal Assistant',
      ].join('\n'),
      selfAddress: 'agent@example.com',
      threadContext: null,
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: [
          'Executive summary:',
          '',
          '- *HybridAI GmbH* registration updated',
          '- `message` reads now route correctly',
          '',
          '-- ',
          '',
          '*Hybot*',
          'Personal Assistant',
        ].join('\n'),
        html: expect.stringContaining('<strong>HybridAI GmbH</strong>'),
      }),
    );
    const html = String(transport.sendMail.mock.calls[0]?.[0]?.html || '');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code>message</code>');
    expect(html).toMatch(/<hr\s*\/?>/);
    expect(html).toContain('<strong>Hybot</strong>');
  });

  test('sanitizes raw html from outbound email bodies', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const { sendEmail } = await import('../src/channels/email/delivery.js');
    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-sanitized@example.com>',
      })),
    };

    await sendEmail({
      transport,
      to: 'boss@example.com',
      body: [
        'Executive summary',
        '',
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert(1)>',
        '',
        '- *Safe item*',
      ].join('\n'),
      selfAddress: 'agent@example.com',
      threadContext: null,
    });

    const html = String(transport.sendMail.mock.calls[0]?.[0]?.html || '');
    expect(html).toContain('<p>Executive summary</p>');
    expect(html).toContain('<strong>Safe item</strong>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=');
  });

  test('logs outbound email delivery metadata without body content', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const loggerInfo = vi.fn();
    const loggerWarn = vi.fn();
    vi.doMock('../src/logger.js', () => ({
      logger: {
        info: loggerInfo,
        warn: loggerWarn,
      },
    }));
    const { sendEmail } = await import('../src/channels/email/delivery.js');
    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-logged@example.com>',
        accepted: ['boss@example.com'],
        rejected: [],
        pending: [],
        response: '250 2.0.0 queued as ABC123',
      })),
    };

    await sendEmail({
      transport,
      to: 'boss@example.com',
      body: 'Sensitive body should not appear in logs.',
      selfAddress: 'agent@example.com',
      threadContext: null,
    });

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'boss@example.com',
        subject: 'HybridClaw',
        messageId: '<sent-logged@example.com>',
        chunkIndex: 1,
        chunkCount: 1,
        hasAttachment: false,
        response: '250 2.0.0 queued as ABC123',
      }),
      'Email send completed',
    );
    expect(loggerInfo.mock.calls[0]?.[0]).not.toHaveProperty('body');
    expect(loggerInfo.mock.calls[0]?.[0]).not.toHaveProperty('text');
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  test('warns when SMTP reports rejected or pending recipients', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const loggerInfo = vi.fn();
    const loggerWarn = vi.fn();
    vi.doMock('../src/logger.js', () => ({
      logger: {
        info: loggerInfo,
        warn: loggerWarn,
      },
    }));
    const { sendEmail } = await import('../src/channels/email/delivery.js');
    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-warning@example.com>',
        accepted: ['boss@example.com'],
        rejected: ['blocked@example.com'],
        pending: ['slow@example.com'],
        response: '250 queued with warnings',
      })),
    };

    await sendEmail({
      transport,
      to: 'boss@example.com',
      body: 'Sensitive body should not appear in logs.',
      selfAddress: 'agent@example.com',
      threadContext: null,
    });

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'boss@example.com',
        subject: 'HybridClaw',
        messageId: '<sent-warning@example.com>',
        response: '250 queued with warnings',
      }),
      'Email send completed',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'boss@example.com',
        subject: 'HybridClaw',
        messageId: '<sent-warning@example.com>',
        accepted: ['boss@example.com'],
        acceptedCount: 1,
        rejected: ['blocked@example.com'],
        rejectedCount: 1,
        pending: ['slow@example.com'],
        pendingCount: 1,
        response: '250 queued with warnings',
      }),
      'Email send reported recipient delivery issues',
    );
  });

  test('adds reply subject and threading headers on outbound send', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const { sendEmail } = await import('../src/channels/email/delivery.js');
    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-1@example.com>',
      })),
    };

    const result = await sendEmail({
      transport,
      to: 'boss@example.com',
      body: 'Here is the update.',
      selfAddress: 'agent@example.com',
      threadContext: {
        subject: 'Quarterly plan',
        messageId: '<msg-1@example.com>',
        references: ['<ref-1@example.com>'],
      },
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'agent@example.com',
        to: 'boss@example.com',
        subject: 'Re: Quarterly plan',
        inReplyTo: '<msg-1@example.com>',
        references: '<ref-1@example.com> <msg-1@example.com>',
        text: 'Here is the update.',
        html: expect.stringContaining('<p>Here is the update.</p>'),
      }),
    );
    expect(result.threadContext).toEqual({
      subject: 'Re: Quarterly plan',
      messageId: '<sent-1@example.com>',
      references: ['<ref-1@example.com>', '<msg-1@example.com>'],
    });
  });

  test('extracts inline subject prefixes and attaches files', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const { sendEmail } = await import('../src/channels/email/delivery.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-email-'));
    const filePath = path.join(tempDir, 'report.txt');
    fs.writeFileSync(filePath, 'report');

    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-2@example.com>',
      })),
    };

    await sendEmail({
      transport,
      to: 'ops@example.com',
      body: '[Subject: Deployment complete]\n\nAttached is the report.',
      selfAddress: 'agent@example.com',
      threadContext: null,
      attachment: {
        filePath,
      },
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Deployment complete',
        text: 'Attached is the report.',
        html: expect.stringContaining('<p>Attached is the report.</p>'),
        attachments: [
          expect.objectContaining({
            path: filePath,
            filename: 'report.txt',
          }),
        ],
      }),
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('sends attachment-only email without inserting placeholder body text', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const { sendEmail } = await import('../src/channels/email/delivery.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-email-'));
    const filePath = path.join(tempDir, 'report.txt');
    fs.writeFileSync(filePath, 'report');

    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-attachment-only@example.com>',
      })),
    };

    await sendEmail({
      transport,
      to: 'ops@example.com',
      body: '',
      selfAddress: 'agent@example.com',
      threadContext: null,
      attachment: {
        filePath,
      },
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: undefined,
        html: undefined,
        attachments: [
          expect.objectContaining({
            path: filePath,
            filename: 'report.txt',
          }),
        ],
      }),
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('chunks long email bodies according to the configured limit', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_TEXT_CHUNK_LIMIT: 500,
    }));
    const { prepareEmailTextChunks } = await import(
      '../src/channels/email/delivery.js'
    );

    expect(prepareEmailTextChunks('x'.repeat(1200))).toHaveLength(3);
  });
});

describe('email runtime', () => {
  test('aborts in-flight handlers during shutdown', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_PASSWORD: 'email-app-password',
      getConfigSnapshot: () => ({
        email: BASE_EMAIL_CONFIG,
      }),
    }));

    const transportClose = vi.fn(async () => {});
    const transportVerify = vi.fn(async () => {});
    const createTransport = vi.fn(() => ({
      close: transportClose,
      verify: transportVerify,
    }));
    let onNewMessages:
      | ((
          messages: Array<{ folder: string; raw: Buffer; uid: number }>,
        ) => Promise<void>)
      | null = null;
    const managerStart = vi.fn(async () => {});
    const managerStop = vi.fn(async () => {});
    const cleanupEmailInboundMedia = vi.fn(async () => {});

    vi.doMock('nodemailer', () => ({
      default: {
        createTransport,
      },
    }));
    vi.doMock('../src/channels/email/connection.ts', () => ({
      createEmailConnectionManager: vi.fn(
        (
          _config: unknown,
          _password: string,
          callback: (
            messages: Array<{ folder: string; raw: Buffer; uid: number }>,
          ) => Promise<void>,
        ) => {
          onNewMessages = callback;
          return {
            start: managerStart,
            stop: managerStop,
          };
        },
      ),
    }));
    vi.doMock('../src/channels/email/inbound.ts', () => ({
      cleanupEmailInboundMedia,
      processInboundEmail: vi.fn(async () => ({
        sessionId: 'email:boss@example.com',
        guildId: null,
        channelId: 'boss@example.com',
        userId: 'boss@example.com',
        username: 'Boss',
        content: 'hello',
        media: [],
        senderAddress: 'boss@example.com',
        senderName: 'Boss',
        subject: 'Hello',
        threadContext: null,
      })),
    }));

    const { createEmailRuntime } = await import(
      '../src/channels/email/runtime.js'
    );
    const runtime = createEmailRuntime();
    let aborted = false;
    const handlerCompleted = vi.fn();

    await runtime.initEmail(async (...args) => {
      const context = args[8];
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          aborted = true;
          resolve();
        };
        if (context.abortSignal.aborted) {
          onAbort();
          return;
        }
        context.abortSignal.addEventListener('abort', onAbort, { once: true });
      });
      handlerCompleted();
    });

    expect(onNewMessages).not.toBeNull();
    const inboundPromise = onNewMessages?.([
      {
        folder: 'INBOX',
        raw: Buffer.from('raw'),
        uid: 1,
      },
    ]);

    await Promise.resolve();
    await runtime.shutdownEmail();
    await inboundPromise;

    expect(aborted).toBe(true);
    expect(handlerCompleted).toHaveBeenCalledTimes(1);
    expect(managerStop).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
    expect(cleanupEmailInboundMedia).toHaveBeenCalledTimes(1);
    await expect(
      runtime.sendToEmail('boss@example.com', 'after shutdown'),
    ).rejects.toThrow('Email runtime shutting down.');
  });

  test('does not resume processing later messages after shutdown completes', async () => {
    vi.doMock('../src/config/config.ts', async () => ({
      ...(await vi.importActual('../src/config/config.ts')),
      EMAIL_PASSWORD: 'email-app-password',
      getConfigSnapshot: () => ({
        email: BASE_EMAIL_CONFIG,
      }),
    }));

    const createTransport = vi.fn(() => ({
      close: vi.fn(async () => {}),
      verify: vi.fn(async () => {}),
    }));
    let onNewMessages:
      | ((
          messages: Array<{ folder: string; raw: Buffer; uid: number }>,
        ) => Promise<void>)
      | null = null;

    vi.doMock('nodemailer', () => ({
      default: {
        createTransport,
      },
    }));
    vi.doMock('../src/channels/email/connection.ts', () => ({
      createEmailConnectionManager: vi.fn(
        (
          _config: unknown,
          _password: string,
          callback: (
            messages: Array<{ folder: string; raw: Buffer; uid: number }>,
          ) => Promise<void>,
        ) => {
          onNewMessages = callback;
          return {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          };
        },
      ),
    }));
    vi.doMock('../src/channels/email/inbound.ts', () => ({
      cleanupEmailInboundMedia: vi.fn(async () => {}),
      processInboundEmail: vi.fn(async (raw: Buffer) => {
        const id = raw.toString('utf8');
        return {
          sessionId: 'email:boss@example.com',
          guildId: null,
          channelId: 'boss@example.com',
          userId: 'boss@example.com',
          username: 'Boss',
          content: `hello ${id}`,
          media: [],
          senderAddress: 'boss@example.com',
          senderName: 'Boss',
          subject: 'Hello',
          threadContext: null,
        };
      }),
    }));

    const { createEmailRuntime } = await import(
      '../src/channels/email/runtime.js'
    );
    const runtime = createEmailRuntime();
    const handledContents: string[] = [];

    await runtime.initEmail(async (...args) => {
      const content = args[5];
      const context = args[8];
      handledContents.push(content);
      if (content !== 'hello first') return;
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        if (context.abortSignal.aborted) {
          onAbort();
          return;
        }
        context.abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    });

    expect(onNewMessages).not.toBeNull();
    const inboundPromise = onNewMessages?.([
      {
        folder: 'INBOX',
        raw: Buffer.from('first'),
        uid: 1,
      },
      {
        folder: 'INBOX',
        raw: Buffer.from('second'),
        uid: 2,
      },
    ]);

    await Promise.resolve();
    await runtime.shutdownEmail();
    await inboundPromise;

    expect(handledContents).toEqual(['hello first']);
  });
});
