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
  tempHomePrefix: 'hybridclaw-mobile-browser-',
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

// The phone watches the agent browse only through the local browser's frames.
test('a turn from the phone drives the local browser, other turns the configured one', async () => {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.js');
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
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    content: 'Open example.com in the browser.',
  };

  await handleGatewayMessage({
    ...request,
    sessionId: 'web:phone',
    client: 'mobile',
  });
  await handleGatewayMessage({ ...request, sessionId: 'web:desk' });

  expect(runAgentMock.mock.calls[0]?.[0].browserProvider).toBe('local');
  expect(runAgentMock.mock.calls[1]?.[0].browserProvider).toBeUndefined();
  // The app is named on the turn so its model calls can be told apart.
  expect(runAgentMock.mock.calls[0]?.[0].client).toBe('mobile');
  expect(runAgentMock.mock.calls[1]?.[0].client).toBeUndefined();
});
