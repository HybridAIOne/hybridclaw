import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-context-refs-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('handleGatewayMessage expands context references only for llm-facing paths', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { DEFAULT_AGENT_ID } = await import('../src/agents/agent-types.ts');
  const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  const workspacePath = agentWorkspaceDir(DEFAULT_AGENT_ID);
  fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'src', 'app.ts'),
    'export const answer = 42;\n',
    'utf8',
  );

  const promptMemorySpy = vi.spyOn(memoryService, 'buildPromptMemoryContext');
  const sessionId = 'session-context-refs';
  const content = 'Explain @file:src/app.ts';

  const result = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content,
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(promptMemorySpy).toHaveBeenCalledWith(
    expect.objectContaining({
      query: 'Explain',
    }),
  );

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ content: string; role: string }>;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);
  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toContain('Explain');
  expect(userMessage?.content).toContain('--- Attached Context ---');
  expect(userMessage?.content).toContain('File: src/app.ts');
  expect(userMessage?.content).toContain('export const answer = 42;');
  expect(userMessage?.content).not.toContain('@file:src/app.ts');

  const history = memoryService.getConversationHistory(sessionId, 10);
  expect(history.find((message) => message.role === 'user')?.content).toBe(
    content,
  );

  const records = fs
    .readFileSync(getAuditWirePath(sessionId), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: Record<string, unknown> });
  const turnStart = records.find(
    (record) => record.event?.type === 'turn.start',
  )?.event;

  expect(turnStart?.userInput).toBe(content);
});

test('handleGatewayMessage keeps explicit skill expansion when skill args inject context', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { DEFAULT_AGENT_ID } = await import('../src/agents/agent-types.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  const workspacePath = agentWorkspaceDir(DEFAULT_AGENT_ID);
  fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'src', 'app.ts'),
    'export const answer = 42;\n',
    'utf8',
  );

  const result = await handleGatewayMessage({
    sessionId: 'session-context-refs-skill',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: '/skill pdf summarize @file:src/app.ts',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ content: string; role: string }>;
      }
    | undefined;
  const systemMessage = request?.messages?.[0];
  const userMessage = request?.messages?.at(-1);

  expect(systemMessage?.role).toBe('system');
  expect(systemMessage?.content).not.toContain('## Skills (mandatory)');
  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toContain('[Explicit skill invocation]');
  expect(userMessage?.content).toContain(
    'Use the "pdf" skill for this request.',
  );
  expect(userMessage?.content).toContain('Skill input: summarize');
  expect(userMessage?.content).toContain('--- Attached Context ---');
  expect(userMessage?.content).toContain('File: src/app.ts');
  expect(userMessage?.content).toContain('export const answer = 42;');
  expect(userMessage?.content).not.toContain('@file:src/app.ts');
});
