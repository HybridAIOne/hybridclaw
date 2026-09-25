import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-optional-reply-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

const SILENT = '__MESSAGE_SEND_HANDLED__';

async function runSilentTurn(allowSilentReply?: boolean) {
  setupHome();
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: SILENT,
    toolsUsed: [],
    toolExecutions: [],
  });
  const { initDatabase } = await import('../src/memory/db.js');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  initDatabase({ quiet: true });
  return handleGatewayMessage({
    sessionId: 'discord:channel:optional-reply',
    guildId: 'guild',
    channelId: '123456789012345678',
    userId: 'user-1',
    username: 'alice',
    content: 'Heads up, the update is running now.',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    source: 'discord',
    allowSilentReply,
  });
}

test('keeps a silent reply when the channel allows no reply', async () => {
  const result = await runSilentTurn(true);
  expect(result.status).toBe('success');
  expect(result.result).toBe(SILENT);
});

test('replaces a silent reply with a fallback otherwise', async () => {
  const result = await runSilentTurn();
  expect(result.status).toBe('success');
  expect(result.result).toBe('Done.');
});
