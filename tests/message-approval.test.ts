import { expect, test, vi } from 'vitest';
import {
  setupGatewayTest,
  cleanupGatewayRuntime,
} from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hy-approval-history-',
});

test('a structured approval survives restart and its decision stays in the owning chat', async () => {
  setupHome();
  const db = await import('../src/memory/db.js');
  const { memoryService } = await import('../src/memory/memory-service.js');
  const { rememberChatApproval } = await import(
    '../src/gateway/chat-approval-review.js'
  );
  const { setMessageApproval } = await import(
    '../src/memory/message-approval.js'
  );
  db.initDatabase({ quiet: true });
  const sessionId = 'web:review';
  memoryService.getOrCreateSession(sessionId, null, 'web');
  memoryService.storeMessage({
    sessionId,
    userId: 'pat',
    username: 'pat',
    role: 'user',
    content: 'Send the reviewed message.',
  });
  const id = memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'I need your approval before I send.\nApproval ID: aabbccdd',
  });
  const approval = {
    approvalId: 'aabbccdd',
    prompt: 'Review the message.',
    intent: 'send a message',
    reason: 'external communication',
    toolName: 'hybridai__google__send_mail',
    reviewArguments: JSON.stringify({
      to: ['pat@example.com'],
      body: 'See you Friday.',
    }),
    expiresAt: Date.now() + 120000,
    allowSession: false,
    allowAgent: false,
    allowAll: false,
  };
  await rememberChatApproval(
    {
      sessionId,
      channelId: 'web',
      userId: 'pat',
      username: 'pat',
      guildId: null,
      content: 'Send the reviewed message.',
    },
    {
      status: 'success',
      result: approval.prompt,
      toolsUsed: [],
      assistantMessageId: id,
      pendingApproval: approval,
    },
  );
  // A snapshot cannot be attached to a message in another session.
  setMessageApproval('web:other', id, { ...approval, intent: 'wrong session' });
  await cleanupGatewayRuntime();
  vi.resetModules();
  const restoredDb = await import('../src/memory/db.js');
  restoredDb.initDatabase({ quiet: true });
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.js'
  );
  const { pendingChatApproval } = await import(
    '../src/gateway/chat-approval-review.js'
  );
  expect(getGatewayHistory(sessionId).history.at(-1)?.approval).toEqual(
    approval,
  );
  expect(pendingChatApproval(sessionId, 'pat')?.approvalId).toBe(
    approval.approvalId,
  );
  expect(pendingChatApproval(sessionId, 'other')).toBeNull();
  const { rememberChatApprovalDecision } = await import(
    '../src/gateway/chat-approval-review.js'
  );
  await rememberChatApprovalDecision('web:other', 'pat', {
    approvalId: approval.approvalId,
    decision: 'approve',
    scope: 'once',
  });
  expect(
    getGatewayHistory(sessionId).history.at(-1)?.approval?.decision,
  ).toBeUndefined();
  await rememberChatApprovalDecision(sessionId, 'other', {
    approvalId: approval.approvalId,
    decision: 'approve',
    scope: 'once',
  });
  expect(
    getGatewayHistory(sessionId).history.at(-1)?.approval?.decision,
  ).toBeUndefined();
  await rememberChatApprovalDecision(sessionId, 'pat', {
    approvalId: approval.approvalId,
    decision: 'deny',
    scope: null,
  });
  expect(pendingChatApproval(sessionId, 'pat')).toBeNull();
  expect(getGatewayHistory(sessionId).history.at(-1)?.approval).toMatchObject({
    ...approval,
    decision: 'denied',
    decidedAt: expect.any(Number),
  });
}, 20000);
