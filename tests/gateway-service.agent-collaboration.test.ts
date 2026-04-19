import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-agent-collab-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

async function configureAgents(): Promise<void> {
  const runtimeConfigModule = await import('../src/config/runtime-config.ts');
  const nextConfig = structuredClone(runtimeConfigModule.getRuntimeConfig());
  nextConfig.agents = {
    defaultAgentId: 'main',
    defaults: {
      model: 'openai-codex/gpt-5.4-mini',
    },
    list: [
      {
        id: 'main',
        name: 'Main Agent',
        model: 'openai-codex/gpt-5.4-mini',
      },
      {
        id: 'research',
        name: 'Research Agent',
        model: 'openai-codex/gpt-5.4-mini',
      },
      {
        id: 'writer',
        name: 'Writer Agent',
        model: 'openai-codex/gpt-5.4-mini',
      },
    ],
  };
  runtimeConfigModule.saveRuntimeConfig(nextConfig);
}

test('routes agent collaboration through a named destination session key', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'ready',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage, handleAgentCollaborationChatRequest } =
    await import('../src/gateway/gateway-chat-service.ts');
  const { parseSessionKey } = await import('../src/session/session-key.ts');

  initDatabase({ quiet: true });
  await configureAgents();

  await handleGatewayMessage({
    sessionId: 'source-agent-session',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: 'kick off',
    agentId: 'main',
    model: 'openai-codex/gpt-5.4-mini',
    chatbotId: 'bot-main',
  });

  runAgentMock.mockClear();
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Research summary',
    toolsUsed: ['web_search'],
    toolExecutions: [],
  });

  const result = await handleAgentCollaborationChatRequest({
    currentSessionId: 'source-agent-session',
    toAgent: 'research',
    text: 'Review the rollout plan and flag gaps.',
    destination: 'planner',
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('Research summary');
  expect(result.route).toMatchObject({
    sourceAgentId: 'main',
    targetAgentId: 'research',
    destination: 'planner',
    channelId: 'agent:main:planner',
  });

  const parsedKey = parseSessionKey(result.route?.sessionId || '');
  expect(parsedKey).toMatchObject({
    agentId: 'research',
    channelKind: 'agent',
    chatType: 'dm',
    peerId: 'main',
    subagentId: 'planner',
  });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        agentId?: string;
        channelId?: string;
        messages?: Array<{ role: string; content: string }>;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);

  expect(request?.agentId).toBe('research');
  expect(request?.channelId).toBe('agent:main:planner');
  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toContain('# Agent Handoff');
  expect(userMessage?.content).toContain('Source agent: `main`');
  expect(userMessage?.content).toContain('Destination: `planner`');
  expect(userMessage?.content).toContain(
    'Review the rollout plan and flag gaps.',
  );
});

test('rejects reusing an agent collaboration session with a different target agent', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'ready',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage, handleAgentCollaborationChatRequest } =
    await import('../src/gateway/gateway-chat-service.ts');

  initDatabase({ quiet: true });
  await configureAgents();

  await handleGatewayMessage({
    sessionId: 'source-agent-session',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: 'kick off',
    agentId: 'main',
    model: 'openai-codex/gpt-5.4-mini',
    chatbotId: 'bot-main',
  });

  const firstResult = await handleAgentCollaborationChatRequest({
    currentSessionId: 'source-agent-session',
    toAgent: 'research',
    text: 'Review the first draft.',
    destination: 'planner',
  });

  await expect(
    handleAgentCollaborationChatRequest({
      currentSessionId: 'source-agent-session',
      toAgent: 'writer',
      text: 'Now rewrite it.',
      sessionId: firstResult.route?.sessionId || '',
    }),
  ).rejects.toThrow(/belongs to agent "research"/i);
});
