import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-approval-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('handleGatewayMessage does not persist approval-required turns as chat history', async () => {
  setupHome();
  const continuation = {
    approvalId: 'abc123',
    blockedToolCall: {
      id: 'call-1',
      type: 'function' as const,
      function: {
        name: 'browser_use',
        arguments: '{"action":"navigate","url":"https://x.com/notifications"}',
      },
    },
    history: [],
    toolsUsed: ['browser_use'],
    toolExecutions: [],
    toolCallHistory: [],
    tokenUsage: {
      modelCalls: 1,
      apiUsageAvailable: false,
      apiPromptTokens: 0,
      apiCompletionTokens: 0,
      apiTotalTokens: 0,
      apiCacheUsageAvailable: false,
      apiCacheReadTokens: 0,
      apiCacheWriteTokens: 0,
      estimatedPromptTokens: 10,
      estimatedCompletionTokens: 5,
      estimatedTotalTokens: 15,
    },
    effectiveUserPrompt: 'Open X.com notifications',
  };
  const onPendingApprovalCaptured = vi.fn();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Approval needed for: access x.com',
    toolsUsed: ['browser_use'],
    toolExecutions: [],
    pendingApproval: {
      approvalId: 'abc123',
      prompt: 'Approval needed for: access x.com',
      intent: 'access x.com',
      reason: 'this would contact a new external host',
      allowSession: true,
      allowAgent: true,
      expiresAt: Date.now() + 60_000,
    },
    approvalContinuation: continuation,
    effectiveUserPrompt: 'Open X.com notifications',
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const sessionId = 'tui:approval';
  memoryService.getOrCreateSession(sessionId, null, 'tui');

  const result = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'alice',
    content: 'Open X.com notifications',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    onPendingApprovalCaptured,
  });

  expect(result.status).toBe('success');
  expect(result.pendingApproval?.approvalId).toBe('abc123');
  expect(onPendingApprovalCaptured).toHaveBeenCalledWith({
    approval: expect.objectContaining({
      approvalId: 'abc123',
    }),
    continuation,
  });
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(0);
  expect(memoryService.getSessionById(sessionId)?.message_count).toBe(0);
});

test('handleGatewayMessage forwards approval continuations to runAgent', async () => {
  setupHome();
  const approvalContinuation = {
    approvalId: 'abc123',
    blockedToolCall: {
      id: 'call-1',
      type: 'function' as const,
      function: {
        name: 'browser_use',
        arguments: '{"action":"navigate","url":"https://x.com/notifications"}',
      },
    },
    history: [],
    toolsUsed: ['browser_use'],
    toolExecutions: [],
    toolCallHistory: [],
    tokenUsage: {
      modelCalls: 1,
      apiUsageAvailable: false,
      apiPromptTokens: 0,
      apiCompletionTokens: 0,
      apiTotalTokens: 0,
      apiCacheUsageAvailable: false,
      apiCacheReadTokens: 0,
      apiCacheWriteTokens: 0,
      estimatedPromptTokens: 10,
      estimatedCompletionTokens: 5,
      estimatedTotalTokens: 15,
    },
    effectiveUserPrompt: 'Open X.com notifications',
  };

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Notifications summary',
    toolsUsed: ['browser_use'],
    toolExecutions: [],
    effectiveUserPrompt: 'Open X.com notifications',
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const sessionId = 'tui:approval-resume';
  memoryService.getOrCreateSession(sessionId, null, 'tui');

  const result = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'alice',
    content: 'Open X.com notifications',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    approvalResponse: {
      approvalId: 'abc123',
      decision: 'approve',
      mode: 'once',
    },
    approvalContinuation,
  });

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      approvalResponse: {
        approvalId: 'abc123',
        decision: 'approve',
        mode: 'once',
      },
      approvalContinuation,
    }),
  );
});
