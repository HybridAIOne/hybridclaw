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

test('handleGatewayMessage makes active hatching explicit for switched agents in reused sessions', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('research');

  const sessionId = 'session-switched-agent-hatching';
  await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'bob',
    content: 'hi',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });
  await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    content: 'Hi',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  expect(runAgentMock).toHaveBeenCalledTimes(2);
  const request = runAgentMock.mock.calls[1]?.[0] as
    | {
        messages?: Array<{ content: string; role: string }>;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);
  const systemMessage = request?.messages?.find(
    (message) => message.role === 'system',
  );
  expect(systemMessage?.content).toContain(
    'If the user has already asked you to perform an action',
  );
  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toContain(
    'Hatching mode is active for this agent.',
  );
  expect(userMessage?.content).toContain(
    'A startup instruction file (BOOTSTRAP.md) exists',
  );
  expect(userMessage?.content).toContain(
    'Continue the in-progress hatching conversation using the full chat history above.',
  );
  expect(userMessage?.content).toContain(
    'Do not restart hatching, reintroduce yourself, or repeat onboarding questions you already asked.',
  );
  expect(userMessage?.content).not.toContain(
    'If you have the basic info about the user and a valid email address, proceed to send the welcome message.',
  );
  expect(userMessage?.content).not.toContain(
    'call the message tool with action="send"',
  );
  expect(userMessage?.content).toContain('User message:\nHi');
  expect(
    request?.messages?.some((message) => message.content === 'agent result'),
  ).toBe(true);
  expect(
    request?.messages?.some((message) =>
      message.content.includes('## BOOTSTRAP.md'),
    ),
  ).toBe(true);

  const storedUsers = memoryService
    .getConversationHistory(sessionId, 10)
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  expect(storedUsers).toContain('Hi');
  expect(
    storedUsers.every(
      (content) => !content.includes('Hatching mode is active'),
    ),
  ).toBe(true);
});

test('handleGatewayMessage injects GPT-5 onboarding send directive for gpt-5.4-mini', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('research');

  await handleGatewayMessage({
    sessionId: 'session-gpt5-hatching',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    content: 'Hi',
    model: 'hybridai/gpt-5.4-mini',
    chatbotId: 'bot-1',
  });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ content: string; role: string }>;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);

  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toContain(
    'If you have the basic info about the user and a valid email address, proceed to send the welcome message.',
  );
  expect(userMessage?.content).toContain(
    'Do not display the draft to the user first, but send without asking.',
  );
  expect(userMessage?.content).toContain('User message:\nHi');
});

test('handleGatewayMessage uses configured onboarding model while BOOTSTRAP.md is active', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultModel = 'gpt-5-mini';
    draft.hybridai.onboardingModel = 'gpt-5.5';
  });
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('research');

  await handleGatewayMessage({
    sessionId: 'session-onboarding-model-active',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    content: 'Hi',
    chatbotId: 'bot-1',
  });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        model?: string;
      }
    | undefined;

  expect(request?.model).toBe('gpt-5.5');
});

test('handleGatewayMessage completes hatching after the first jobs email send', async () => {
  setupHome();

  runAgentMock
    .mockResolvedValueOnce({
      status: 'success',
      result: 'I sent the first jobs email.',
      toolsUsed: ['message'],
      toolExecutions: [
        {
          name: 'message',
          arguments: JSON.stringify({
            action: 'send',
            to: 'ben@example.com',
            subject: 'HybridClaw release support is ready',
            content: [
              'Hi Ben,',
              '',
              'I can help with these first jobs:',
              '- Draft technical HybridClaw release posts.',
              '- Review pull requests and summarize CI status.',
            ].join('\n'),
          }),
          result: JSON.stringify({
            ok: true,
            action: 'send',
            channelId: 'ben@example.com',
            transport: 'email',
            subject: 'HybridClaw release support is ready',
          }),
          durationMs: 12,
        },
      ],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: 'Normal turn.',
      toolsUsed: [],
      toolExecutions: [],
    });

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultModel = 'gpt-5-mini';
    draft.hybridai.onboardingModel = 'gpt-5.5';
  });
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('research');

  const workspaceDir = agentWorkspaceDir('research');
  expect(fs.existsSync(path.join(workspaceDir, 'BOOTSTRAP.md'))).toBe(true);

  await handleGatewayMessage({
    sessionId: 'session-onboarding-email-complete',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    content:
      'I am Ben, email ben@example.com. I want release posts and PR review support.',
    chatbotId: 'bot-1',
  });

  expect(fs.existsSync(path.join(workspaceDir, 'BOOTSTRAP.md'))).toBe(false);
  const userMarkdown = fs.readFileSync(
    path.join(workspaceDir, 'USER.md'),
    'utf-8',
  );
  expect(userMarkdown).toContain('- **Email:** ben@example.com');
  expect(userMarkdown).toContain('- **Status:** sent');
  expect(userMarkdown).toContain(
    '- **Subject:** HybridClaw release support is ready',
  );
  expect(userMarkdown).toContain('- Draft technical HybridClaw release posts.');

  await handleGatewayMessage({
    sessionId: 'session-onboarding-email-complete',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    content: 'Next normal prompt.',
    chatbotId: 'bot-1',
  });

  expect(runAgentMock).toHaveBeenCalledTimes(2);
  expect(
    (runAgentMock.mock.calls[0]?.[0] as { model?: string } | undefined)?.model,
  ).toBe('gpt-5.5');
  expect(
    (runAgentMock.mock.calls[1]?.[0] as { model?: string } | undefined)?.model,
  ).toBe('gpt-5-mini');
});

test('handleGatewayMessage returns to regular model after onboarding completes', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultModel = 'gpt-5-mini';
    draft.hybridai.onboardingModel = 'gpt-5.5';
  });
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('research');

  const workspaceDir = agentWorkspaceDir('research');
  fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));
  fs.writeFileSync(
    path.join(workspaceDir, '.hybridclaw', 'workspace-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        bootstrapSeededAt: '2026-06-19T10:00:00.000Z',
        onboardingCompletedAt: '2026-06-19T10:05:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  await handleGatewayMessage({
    sessionId: 'session-onboarding-model-complete',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    content: 'Hi',
    chatbotId: 'bot-1',
  });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        model?: string;
      }
    | undefined;

  expect(request?.model).toBe('gpt-5-mini');
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
