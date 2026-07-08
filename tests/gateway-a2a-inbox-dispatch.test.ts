import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { sendA2AMessageMock } = vi.hoisted(() => ({
  sendA2AMessageMock: vi.fn(),
}));

vi.mock('../src/a2a/runtime.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/a2a/runtime.ts')>();
  return {
    ...actual,
    sendMessage: sendA2AMessageMock,
  };
});

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;
const ORIGINAL_CONFIG_WATCHER = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

let tmpDir: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gateway-a2a-dispatch-'));
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_INSTANCE_ID = 'inst-i1';
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
});

afterEach(() => {
  sendA2AMessageMock.mockReset();
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_INSTANCE_ID', ORIGINAL_INSTANCE_ID);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_CONFIG_WATCHER,
  );
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('persists outbound A2A chat sends in the web session history', async () => {
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  sendA2AMessageMock.mockReturnValue({
    delivered: true,
    message_id: 'outbound-to-i2',
    thread_id: 'web-thread-a2a-send',
    recipient_agent_id: 'main@local@inst-i2',
  });

  const result = await handleGatewayMessage({
    sessionId: 'web-thread-a2a-send',
    guildId: null,
    channelId: 'web',
    userId: 'web-user',
    username: 'web',
    content: '@main@local@inst-i2 Who are you?',
  });

  expect(result).toMatchObject({
    status: 'success',
    result:
      'Delivered to `main@local@inst-i2`.\n' +
      'Message: `outbound-to-i2`\n' +
      'Thread: `web-thread-a2a-send`',
    messageRole: 'command',
    userMessageId: expect.any(Number),
    assistantMessageId: expect.any(Number),
    a2aDelivery: {
      messageId: 'outbound-to-i2',
      threadId: 'web-thread-a2a-send',
      recipientAgentId: 'main@local@inst-i2',
      status: 'delivered',
    },
  });
  expect(sendA2AMessageMock).toHaveBeenCalledWith(
    expect.objectContaining({
      recipient_agent_id: 'main@local@inst-i2',
      thread_id: 'web-thread-a2a-send',
      intent: 'chat',
      content: 'Who are you?',
    }),
    expect.objectContaining({
      actor: 'web-user',
      sessionId: 'web-thread-a2a-send',
    }),
  );

  const history = memoryService.getConversationHistory(
    'web-thread-a2a-send',
    10,
  );
  expect(history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content:
        'Delivered to `main@local@inst-i2`.\n' +
        'Message: `outbound-to-i2`\n' +
        'Thread: `web-thread-a2a-send`',
      agent_id: 'main',
    }),
    expect.objectContaining({
      role: 'user',
      user_id: 'web-user',
      username: 'web',
      content: '@main@local@inst-i2 Who are you?',
    }),
  ]);
});

test('stores A2A parent replies in the originating chat session', async () => {
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { createA2AEnvelope } = await import('../src/a2a/envelope.ts');
  const { enqueueA2AInboxDispatch } = await import(
    '../src/a2a/a2a-inbox-dispatch-store.ts'
  );
  const { dispatchA2AInboxItemToGateway } = await import(
    '../src/gateway/a2a-inbox-dispatch.ts'
  );

  initDatabase({ quiet: true });
  const originSession = memoryService.getOrCreateSession(
    'web-thread-a2a',
    null,
    'web',
    'main',
  );
  const envelope = createA2AEnvelope({
    id: 'reply-from-i2',
    sender_agent_id: 'main@local@inst-i2',
    recipient_agent_id: 'main@local@inst-i1',
    thread_id: originSession.id,
    parent_message_id: 'outbound-to-i2',
    intent: 'chat',
    content: 'I am I2.',
  });
  const item = enqueueA2AInboxDispatch(envelope);

  await expect(
    dispatchA2AInboxItemToGateway({
      item,
      envelope,
      agentId: 'main',
      sessionId: 'a2a-dispatch-session',
      channelId: 'a2a',
      userId: envelope.sender_agent_id,
      username: envelope.sender_agent_id,
      source: 'a2a.dispatch',
      content: 'synthetic dispatch prompt should not be persisted',
      addressEnvelope: {
        to: 'main',
        from: envelope.sender_agent_id,
      },
    }),
  ).resolves.toEqual({
    status: 'success',
    result: null,
  });

  expect(memoryService.getSessionById('a2a-dispatch-session')).toBeUndefined();
  expect(memoryService.getSessionById(originSession.id)?.message_count).toBe(1);
  expect(memoryService.getConversationHistory(originSession.id, 10)).toEqual([
    expect.objectContaining({
      role: 'assistant',
      user_id: 'main@local@inst-i2',
      username: 'main@local@inst-i2',
      agent_id: 'main@local@inst-i2',
      content: 'I am I2.',
    }),
  ]);
});
