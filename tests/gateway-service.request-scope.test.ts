import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-request-scope-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

async function runScopedTurn(params: {
  allowedTools?: string[];
  instructions?: string;
  content?: string;
}) {
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });
  const result = await handleGatewayMessage({
    sessionId: 'session-request-scope',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'user_a',
    content: params.content ?? 'How is the pipeline?',
    model: 'test-model',
    chatbotId: 'bot-1',
    ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
    ...(params.instructions ? { instructions: params.instructions } : {}),
  });
  expect(result.status).toBe('success');
  const call = runAgentMock.mock.calls[0]?.[0] as {
    allowedTools?: string[];
    messages: Array<{ role: string; content: unknown }>;
  };
  const systemText = call.messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');
  return { call, systemText };
}

test('a request allowlist reaches the agent run', async () => {
  setupHome();
  const { call } = await runScopedTurn({ allowedTools: ['read', 'bash'] });
  expect(call.allowedTools).toEqual(['read', 'bash']);
});

test('without a request allowlist the agent run stays unrestricted', async () => {
  setupHome();
  const { call } = await runScopedTurn({});
  expect(call.allowedTools).toBeUndefined();
});

test('operator instructions land in the system prompt, caller content does not', async () => {
  setupHome();
  const { systemText } = await runScopedTurn({
    instructions: 'Answer from Salesforce opportunities only.',
    content: 'caller-question-marker',
  });
  expect(systemText).toContain(
    '## Operator Instructions\nAnswer from Salesforce opportunities only.',
  );
  expect(systemText).not.toContain('caller-question-marker');
});
