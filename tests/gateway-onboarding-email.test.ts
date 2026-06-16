import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import type { ToolExecution } from '../src/types/execution.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function writeUserMarkdown(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'USER.md'),
    [
      '# USER.md - About Your Human',
      '',
      '- **Name:** Ben',
      '- **What to call them:** Ben',
      '- **Email:** ben@example.com',
      '- **Primary work / activity:** AI product engineering',
      '- **HybridClaw goals:** coding, operations, and communication support',
      '- **Important tools and platforms:** GitHub, email, Discord',
      '- **Preferred working style:** brief status updates with concrete next steps',
      '',
      '## Helpful Links',
      '',
      '- **Agent chat:** https://example.com/chat',
      '- **WhatsApp channel setup:**',
      '- **Documentation:** https://example.com/docs',
      '',
      '## Suggested First Jobs',
      '',
      '- Review GitHub pull requests and follow CI to green.',
      '- Draft weekly HybridClaw progress updates.',
      '- Summarize important email and Discord threads.',
      '',
      '## First Jobs Email',
      '',
      '- **Status:** drafted in chat',
      '- **Recipient:** ben@example.com',
      '- **Subject:** Your first HybridClaw engineering workflows',
      '- **Delivery:** not sent',
      '- **Last handled:**',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function messageSendExecution(): ToolExecution {
  return {
    name: 'message',
    arguments: JSON.stringify({
      action: 'send',
      to: 'ben@example.com',
      content: '[Subject: Your first HybridClaw engineering workflows]\n\nHi',
    }),
    result: JSON.stringify({
      ok: true,
      action: 'send',
      transport: 'email',
      channelId: 'ben@example.com',
    }),
    durationMs: 12,
  };
}

test('maybeSendOnboardingFirstJobsEmail sends and marks USER.md sent', async () => {
  const workspacePath = makeTempDir('hybridclaw-onboarding-email-');
  writeUserMarkdown(workspacePath);
  const sendEmail = vi.fn(async () => {});

  const { maybeSendOnboardingFirstJobsEmail } = await import(
    '../src/gateway/onboarding-email.js'
  );
  const result = await maybeSendOnboardingFirstJobsEmail({
    workspacePath,
    agentName: 'Nova',
    startupBootstrapFile: 'BOOTSTRAP.md',
    toolExecutions: [],
    now: new Date('2026-06-16T12:00:00.000Z'),
    sendEmail,
  });

  expect(result).toMatchObject({
    status: 'sent',
    recipient: 'ben@example.com',
    subject: 'Your first HybridClaw engineering workflows',
  });
  expect(sendEmail).toHaveBeenCalledWith(
    'ben@example.com',
    expect.stringContaining(
      'Review GitHub pull requests and follow CI to green.',
    ),
    {
      subject: 'Your first HybridClaw engineering workflows',
      fromName: 'Nova',
    },
  );
  expect(sendEmail.mock.calls[0]?.[1]).toContain(
    'Agent chat: https://example.com/chat',
  );

  const updated = fs.readFileSync(path.join(workspacePath, 'USER.md'), 'utf-8');
  expect(updated).toContain('- **Status:** sent');
  expect(updated).toContain('- **Recipient:** ben@example.com');
  expect(updated).toContain('- **Delivery:** email channel, 2026-06-16');
  expect(updated).toContain('- **Last handled:** 2026-06-16');
});

test('maybeSendOnboardingFirstJobsEmail does not duplicate a successful model send', async () => {
  const workspacePath = makeTempDir('hybridclaw-onboarding-email-');
  writeUserMarkdown(workspacePath);
  const sendEmail = vi.fn(async () => {});

  const { maybeSendOnboardingFirstJobsEmail } = await import(
    '../src/gateway/onboarding-email.js'
  );
  const result = await maybeSendOnboardingFirstJobsEmail({
    workspacePath,
    agentName: 'Nova',
    startupBootstrapFile: 'BOOTSTRAP.md',
    toolExecutions: [messageSendExecution()],
    now: new Date('2026-06-16T12:00:00.000Z'),
    sendEmail,
  });

  expect(result).toMatchObject({
    status: 'already-sent',
    recipient: 'ben@example.com',
  });
  expect(sendEmail).not.toHaveBeenCalled();
  const updated = fs.readFileSync(path.join(workspacePath, 'USER.md'), 'utf-8');
  expect(updated).toContain('- **Status:** sent');
});

test('maybeSendOnboardingFirstJobsEmail records unavailable email channel failure', async () => {
  const workspacePath = makeTempDir('hybridclaw-onboarding-email-');
  writeUserMarkdown(workspacePath);
  const sendEmail = vi.fn(async () => {
    throw new Error('Email runtime is not configured.');
  });

  const { maybeSendOnboardingFirstJobsEmail } = await import(
    '../src/gateway/onboarding-email.js'
  );
  const result = await maybeSendOnboardingFirstJobsEmail({
    workspacePath,
    agentName: 'Nova',
    startupBootstrapFile: 'BOOTSTRAP.md',
    toolExecutions: [],
    now: new Date('2026-06-16T12:00:00.000Z'),
    sendEmail,
  });

  expect(result).toMatchObject({
    status: 'failed',
    recipient: 'ben@example.com',
  });
  const updated = fs.readFileSync(path.join(workspacePath, 'USER.md'), 'utf-8');
  expect(updated).toContain(
    '- **Status:** send failed - email channel unavailable',
  );
  expect(updated).toContain('- **Delivery:** not sent');
});

test('maybeSendOnboardingFirstJobsEmail waits until suggested jobs exist', async () => {
  const workspacePath = makeTempDir('hybridclaw-onboarding-email-');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'USER.md'),
    [
      '# USER.md - About Your Human',
      '',
      '- **Email:** ben@example.com',
      '',
      '## Suggested First Jobs',
      '',
      '_(After hatching, keep a short list of practical jobs.)_',
      '',
      '## First Jobs Email',
      '',
      '- **Status:** pending',
      '',
    ].join('\n'),
    'utf-8',
  );
  const sendEmail = vi.fn(async () => {});

  const { maybeSendOnboardingFirstJobsEmail } = await import(
    '../src/gateway/onboarding-email.js'
  );
  const result = await maybeSendOnboardingFirstJobsEmail({
    workspacePath,
    agentName: 'Nova',
    startupBootstrapFile: 'BOOTSTRAP.md',
    toolExecutions: [],
    sendEmail,
  });

  expect(result).toEqual({
    status: 'skipped',
    reason: 'missing_suggested_jobs',
  });
  expect(sendEmail).not.toHaveBeenCalled();
});
