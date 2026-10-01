import { expect, test, vi } from 'vitest';

import type { ContainerOutput } from '../src/types/container.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-mobile-rag-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

const SUCCESS: ContainerOutput = {
  status: 'success',
  result: 'Done.',
  toolsUsed: [],
  toolExecutions: [],
};

// HybridAI runs a vector search for every model call that asks for RAG.
test('turns from the phone never ask for RAG, and their session keeps it off', async () => {
  setupHome();
  const { getSessionById, initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue(SUCCESS);
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const request = {
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
    model: 'hybridai/gpt-5-mini',
    chatbotId: 'bot_a',
    content: 'What is on my calendar today?',
  };

  const phone = await handleGatewayMessage({
    ...request,
    sessionId: 'web:phone',
    client: 'mobile',
  });
  const desk = await handleGatewayMessage({ ...request, sessionId: 'web:desk' });
  // A later run in the phone's chat, such as a goal or a delegation result.
  await handleGatewayMessage({ ...request, sessionId: String(phone.sessionId) });

  expect(runAgentMock.mock.calls[0]?.[0].enableRag).toBe(false);
  expect(runAgentMock.mock.calls[1]?.[0].enableRag).toBe(true);
  expect(runAgentMock.mock.calls[2]?.[0].enableRag).toBe(false);
  expect(getSessionById(String(phone.sessionId))?.enable_rag).toBe(0);
  expect(getSessionById(String(desk.sessionId))?.enable_rag).toBe(1);
});
