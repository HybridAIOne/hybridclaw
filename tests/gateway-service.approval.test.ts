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
  });

  expect(result.status).toBe('success');
  expect(result.pendingApproval?.approvalId).toBe('abc123');
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(0);
  expect(memoryService.getSessionById(sessionId)?.message_count).toBe(0);
});
