import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;

let tmpDir: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-admin-inbox-'));
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
  vi.resetModules();
});

afterEach(() => {
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_INSTANCE_ID', ORIGINAL_INSTANCE_ID);
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gateway admin A2A inbox', () => {
  test('returns thread summaries and selected thread messages', async () => {
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const store = await import('../src/a2a/store.ts');
    const envelope = await import('../src/a2a/envelope.ts');
    const service = await import('../src/gateway/gateway-service.ts');

    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        { id: 'main', owner: 'team', role: 'lead' },
        { id: 'writer', owner: 'team', role: 'writer' },
      ];
    });

    store.saveA2AEnvelope(
      envelope.validateA2AEnvelope({
        id: 'msg-a',
        sender_agent_id: 'main',
        recipient_agent_id: 'writer',
        thread_id: 'thread-a',
        intent: 'chat',
        content: 'Draft the brief.',
        created_at: '2026-05-01T09:00:00.000Z',
      }),
    );
    store.saveA2AEnvelope(
      envelope.validateA2AEnvelope({
        id: 'msg-b-2',
        sender_agent_id: 'main',
        recipient_agent_id: 'writer',
        thread_id: 'thread-b',
        parent_message_id: 'msg-b',
        intent: 'ack',
        content: 'Acknowledged.',
        created_at: '2026-05-01T10:01:00.000Z',
      }),
    );
    store.saveA2AEnvelope(
      envelope.validateA2AEnvelope({
        id: 'msg-b',
        sender_agent_id: 'writer',
        recipient_agent_id: 'main',
        thread_id: 'thread-b',
        intent: 'handoff',
        content: 'Here is the newest handoff.',
        created_at: '2026-05-01T10:00:00.000Z',
      }),
    );

    const latest = service.getGatewayAdminA2AInbox();
    expect(latest.selectedThreadId).toBe('thread-b');
    expect(latest.threads.map((thread) => thread.id)).toEqual([
      'thread-b',
      'thread-a',
    ]);
    expect(latest.threads[0]).toMatchObject({
      id: 'thread-b',
      ownerCoworkerId: 'main@team@local-dev',
      messageCount: 2,
      participants: ['main@team@local-dev', 'writer@team@local-dev'],
      latestMessage: {
        id: 'msg-b-2',
        parentMessageId: 'msg-b',
        senderAgentId: 'main@team@local-dev',
        recipientAgentId: 'writer@team@local-dev',
        intent: 'ack',
        content: 'Acknowledged.',
      },
    });
    expect(latest.messages).toEqual([
      expect.objectContaining({
        id: 'msg-b',
        threadId: 'thread-b',
        senderAgentId: 'writer@team@local-dev',
        recipientAgentId: 'main@team@local-dev',
        content: 'Here is the newest handoff.',
      }),
      expect.objectContaining({
        id: 'msg-b-2',
        parentMessageId: 'msg-b',
        threadId: 'thread-b',
        senderAgentId: 'main@team@local-dev',
        recipientAgentId: 'writer@team@local-dev',
        content: 'Acknowledged.',
      }),
    ]);

    const selected = service.getGatewayAdminA2AInbox({
      threadId: 'thread-a',
    });
    expect(selected.selectedThreadId).toBe('thread-a');
    expect(selected.threads.find((thread) => thread.id === 'thread-a')).toEqual(
      expect.objectContaining({
        ownerCoworkerId: null,
      }),
    );
    expect(selected.messages).toEqual([
      expect.objectContaining({
        id: 'msg-a',
        threadId: 'thread-a',
        senderAgentId: 'main@team@local-dev',
        recipientAgentId: 'writer@team@local-dev',
      }),
    ]);
  });

  test('marks a handed-off thread as owned by the recipient in the inbox', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const service = await import('../src/gateway/gateway-service.ts');

    initDatabase({ quiet: true });
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        { id: 'briefing', owner: 'team', role: 'sender' },
        { id: 'builder', owner: 'team', role: 'recipient' },
      ];
    });

    runtime.sendMessage({
      id: 'msg-handoff',
      sender_agent_id: 'briefing',
      recipient_agent_id: 'builder',
      thread_id: 'thread-handoff',
      intent: 'handoff',
      content: 'Please take ownership of this thread.',
      created_at: '2026-05-01T10:00:00.000Z',
    });

    expect(service.getGatewayAdminA2AInbox()).toMatchObject({
      threads: [
        {
          id: 'thread-handoff',
          ownerCoworkerId: 'builder@team@local-dev',
          latestMessage: {
            id: 'msg-handoff',
            recipientAgentId: 'builder@team@local-dev',
          },
        },
      ],
      messages: [
        {
          id: 'msg-handoff',
          recipientAgentId: 'builder@team@local-dev',
        },
      ],
    });
  });
});
