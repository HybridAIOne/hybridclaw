import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-home-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    runAgentMock.mockReset();
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
});

test('handleGatewayMessage clears session history when the agent workspace is recreated', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'fresh result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  const sessionId = 'tui:local';
  memoryService.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'old user message',
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant-1',
    username: 'assistant',
    role: 'assistant',
    content: 'old assistant message',
  });

  const workspaceDir = agentWorkspaceDir('main');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'stale.txt'), 'stale\n', 'utf-8');
  fs.rmSync(workspaceDir, { recursive: true, force: true });

  const result = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    content: 'hello',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
  });

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  const history = memoryService.getConversationHistory(sessionId, 10);
  expect(history).toHaveLength(2);
  expect(
    history.some((message) => message.content === 'old user message'),
  ).toBe(false);
  expect(
    history.some((message) => message.content === 'old assistant message'),
  ).toBe(false);

  const session = memoryService.getSessionById(sessionId);
  expect(session?.message_count).toBe(2);

  const request = runAgentMock.mock.calls[0]?.[0] as
    | { messages?: Array<{ role: string; content: string }> }
    | undefined;
  const messages = request?.messages;
  expect(messages).toBeDefined();
  expect(
    messages?.some((message) => message.content.includes('old user message')),
  ).toBe(false);
  expect(
    messages?.some((message) =>
      message.content.includes('old assistant message'),
    ),
  ).toBe(false);
});
