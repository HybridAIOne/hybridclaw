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
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  address: 'agent@example.com',
  pollIntervalMs: 15000,
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
    expect(result?.sessionId).toBe('email:boss@example.com');
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
  test('adds reply subject and threading headers on outbound send', async () => {
    vi.doMock('../src/config/config.ts', () => ({
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const { sendEmailReply } = await import(
      '../src/channels/email/delivery.js'
    );
    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-1@example.com>',
      })),
    };

    const result = await sendEmailReply(
      transport,
      'boss@example.com',
      'Here is the update.',
      'agent@example.com',
      {
        subject: 'Quarterly plan',
        messageId: '<msg-1@example.com>',
        references: ['<ref-1@example.com>'],
      },
    );

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'agent@example.com',
        to: 'boss@example.com',
        subject: 'Re: Quarterly plan',
        inReplyTo: '<msg-1@example.com>',
        references: '<ref-1@example.com> <msg-1@example.com>',
        text: 'Here is the update.',
      }),
    );
    expect(result.threadContext).toEqual({
      subject: 'Re: Quarterly plan',
      messageId: '<sent-1@example.com>',
      references: ['<ref-1@example.com>', '<msg-1@example.com>'],
    });
  });

  test('extracts inline subject prefixes and attaches files', async () => {
    vi.doMock('../src/config/config.ts', () => ({
      EMAIL_TEXT_CHUNK_LIMIT: 50000,
    }));
    const { sendEmailWithAttachment } = await import(
      '../src/channels/email/delivery.js'
    );
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-email-'));
    const filePath = path.join(tempDir, 'report.txt');
    fs.writeFileSync(filePath, 'report');

    const transport = {
      sendMail: vi.fn(async () => ({
        messageId: '<sent-2@example.com>',
      })),
    };

    await sendEmailWithAttachment(
      transport,
      'ops@example.com',
      '[Subject: Deployment complete]\n\nAttached is the report.',
      'agent@example.com',
      filePath,
      null,
    );

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Deployment complete',
        text: 'Attached is the report.',
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
    vi.doMock('../src/config/config.ts', () => ({
      EMAIL_TEXT_CHUNK_LIMIT: 500,
    }));
    const { prepareEmailTextChunks } = await import(
      '../src/channels/email/delivery.js'
    );

    expect(prepareEmailTextChunks('x'.repeat(1200))).toHaveLength(3);
  });
});
