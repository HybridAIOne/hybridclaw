import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, sendToEmailMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  sendToEmailMock: vi.fn(async () => {}),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/channels/email/runtime.js', () => ({
  sendToEmail: sendToEmailMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-context-refs-',
  cleanup: () => {
    runAgentMock.mockReset();
    sendToEmailMock.mockClear();
  },
});

function completedOnboardingUserMarkdown(): string {
  return [
    '# USER.md - About Your Human',
    '',
    '- **Name:** Ben',
    '- **What to call them:** Ben',
    '- **Email:** ben@example.com',
    '- **Primary work / activity:** AI product engineering',
    '- **HybridClaw goals:** coding, operations, and communication support',
    '- **Important tools and platforms:** GitHub, email, Discord',
    '- **Preferred working style:** brief status updates with concrete next steps',
    '',
    '## Suggested First Jobs',
    '',
    '- Review GitHub pull requests and follow CI to green.',
    '- Draft weekly HybridClaw progress updates.',
    '- Summarize important email and Discord threads.',
    '',
    '## First Jobs Email',
    '',
    '- **Status:** drafted in chat',
    '- **Recipient:** ben@example.com',
    '- **Subject:** Your first HybridClaw engineering workflows',
    '- **Delivery:** not sent',
    '- **Last handled:**',
    '',
  ].join('\n');
}

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
  expect(userMessage?.content).toContain(
    'perform any concrete requested action or required onboarding file update',
  );
  expect(userMessage?.content).toContain(
    'call the message tool with action="send"',
  );
  expect(userMessage?.content).toContain('do not post only a draft in chat');
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

test('handleGatewayMessage auto-sends first jobs email after hatching artifacts are written', async () => {
  setupHome();

  const { DEFAULT_AGENT_ID } = await import('../src/agents/agent-types.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  const workspacePath = agentWorkspaceDir(DEFAULT_AGENT_ID);
  runAgentMock.mockImplementation(async () => {
    fs.writeFileSync(
      path.join(workspacePath, 'USER.md'),
      completedOnboardingUserMarkdown(),
      'utf-8',
    );
    return {
      status: 'success',
      result:
        'Here is the first-jobs email draft.\n\n[Subject: Your first HybridClaw engineering workflows]\n\nHi Ben...',
      toolsUsed: [],
      toolExecutions: [],
    };
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-onboarding-auto-email',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: 'Sounds good',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(sendToEmailMock).toHaveBeenCalledWith(
    'ben@example.com',
    expect.stringContaining('Review GitHub pull requests and follow CI to green.'),
    expect.objectContaining({
      subject: 'Your first HybridClaw engineering workflows',
    }),
  );
  expect(result.result).toContain(
    'I sent the first-jobs email to ben@example.com.',
  );
  const userMarkdown = fs.readFileSync(
    path.join(workspacePath, 'USER.md'),
    'utf-8',
  );
  expect(userMarkdown).toContain('- **Status:** sent');
  expect(fs.existsSync(path.join(workspacePath, 'BOOTSTRAP.md'))).toBe(false);
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
