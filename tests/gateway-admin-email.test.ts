import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-gateway-email-'),
  );
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('admin email mailbox summarizes stored email threads and ignores non-email sessions', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getOrCreateSession, storeMessage } = await import(
    '../src/memory/db.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { getGatewayAdminEmailMailbox } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  updateRuntimeConfig((draft) => {
    draft.email.enabled = true;
    draft.email.address = 'agent@example.com';
    draft.email.folders = ['INBOX', 'VIP'];
  });

  const financeSession = getOrCreateSession(
    'agent:main:channel:email:chat:dm:peer:finance%40example.com',
    null,
    'finance@example.com',
  );
  storeMessage(
    financeSession.id,
    'finance@example.com',
    'Finance Ops',
    'user',
    '[Subject: Quarterly plan]\n\nPlease review the updated budget.',
  );
  storeMessage(
    financeSession.id,
    'assistant',
    'HybridClaw',
    'assistant',
    'Budget reviewed. I sent the highlights back already.',
  );

  const followupSession = getOrCreateSession(
    'agent:main:channel:email:chat:dm:peer:founder%40example.com',
    null,
    'founder@example.com',
  );
  storeMessage(
    followupSession.id,
    'founder@example.com',
    'Founder',
    'user',
    '[Subject: Launch checklist]\n\nCan you confirm the status on the rollout?',
  );

  const discordSession = getOrCreateSession(
    'agent:main:channel:discord:chat:dm:peer:user-123',
    null,
    'dm:user-123',
  );
  storeMessage(
    discordSession.id,
    'user-123',
    'Discord User',
    'user',
    'This should not appear in the email mailbox.',
  );

  const mailbox = getGatewayAdminEmailMailbox();
  const financeThread = mailbox.threads.find(
    (thread) => thread.sessionId === financeSession.id,
  );
  const followupThread = mailbox.threads.find(
    (thread) => thread.sessionId === followupSession.id,
  );

  expect(mailbox).toMatchObject({
    enabled: true,
    address: 'agent@example.com',
    folders: ['INBOX', 'VIP'],
  });
  expect(mailbox.threads).toHaveLength(2);
  expect(
    mailbox.threads.some((thread) => thread.channelId === 'dm:user-123'),
  ).toBe(false);

  expect(financeThread).toMatchObject({
    channelId: 'finance@example.com',
    senderName: 'Finance Ops',
    subject: 'Quarterly plan',
    preview: 'Budget reviewed. I sent the highlights back already.',
    messageCount: 2,
    userMessageCount: 1,
    lastMessageRole: 'assistant',
  });
  expect(followupThread).toMatchObject({
    channelId: 'founder@example.com',
    senderName: 'Founder',
    subject: 'Launch checklist',
    preview: 'Can you confirm the status on the rollout?',
    messageCount: 1,
    userMessageCount: 1,
    lastMessageRole: 'user',
  });
});
