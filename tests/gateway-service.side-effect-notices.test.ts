import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-side-effect-notices-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('a delegation skipped for the depth limit is reported in the reply', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Working on it.',
    toolsUsed: ['delegate'],
    toolExecutions: [],
    sideEffects: {
      delegations: [{ prompt: 'Summarize the release notes.' }],
    },
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  initDatabase({ quiet: true });

  const result = await handleGatewayMessage({
    sessionId: 'delegate:d2:dm:parent-session',
    guildId: null,
    channelId: 'channel-delegate-depth',
    userId: 'user-1',
    username: 'alice',
    content: 'Delegate this.',
    model: 'gpt-4.1-mini',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.result).toContain('Working on it.');
  expect(result.result).toContain(
    '⚠️ Delegation was not started: nesting depth limit (2) reached.',
  );
});
