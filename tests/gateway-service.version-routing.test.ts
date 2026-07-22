import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-version-routing-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('routes prompts containing --version through the agent', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Python 3.11.2',
    toolsUsed: ['bash'],
    toolExecutions: [],
  });

  const content = 'Führ mal python3 --version aus';
  const result = await handleGatewayMessage({
    sessionId: 'session-version-routing',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content,
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | { messages?: Array<{ role: string; content: string }> }
    | undefined;
  expect(request?.messages?.at(-1)).toMatchObject({
    role: 'user',
    content: expect.stringContaining(content),
  });
  expect(result).toMatchObject({
    status: 'success',
    result: 'Python 3.11.2',
    toolsUsed: ['bash'],
  });
});

test('routes direct HybridClaw version questions through the agent', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Model-owned response',
    toolsUsed: [],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-direct-version-routing',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Welche Version bist du?',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(result.result).toBe('Model-owned response');
});
