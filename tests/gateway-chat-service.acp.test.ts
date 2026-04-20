import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-acp-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('handleGatewayMessage forwards ACP workspace and MCP overrides to runAgent', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'ok',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  await handleGatewayMessage({
    sessionId: 'acp-session',
    guildId: null,
    channelId: 'cli',
    userId: 'acp:user',
    username: 'ACP',
    source: 'acp',
    content: 'List configured MCP servers.',
    chatbotId: 'bot-1',
    workspacePathOverride: '/tmp/acp-workspace',
    workspaceDisplayRootOverride: '/tmp/acp-workspace',
    mcpServersOverride: {
      github: {
        transport: 'http',
        url: 'https://editor.example/mcp',
      },
    },
  });

  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      workspacePathOverride: '/tmp/acp-workspace',
      workspaceDisplayRootOverride: '/tmp/acp-workspace',
      mcpServersOverride: {
        github: {
          transport: 'http',
          url: 'https://editor.example/mcp',
        },
      },
    }),
  );
});
