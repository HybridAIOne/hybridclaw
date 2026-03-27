import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const {
  runAgentMock,
  callAuxiliaryModelMock,
  fetchHybridAIAccountChatbotIdMock,
} = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  callAuxiliaryModelMock: vi.fn(),
  fetchHybridAIAccountChatbotIdMock: vi.fn(async () => 'user-fallback'),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: callAuxiliaryModelMock,
}));

vi.mock('../src/providers/hybridai-bots.ts', () => ({
  HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
  fetchHybridAIAccountChatbotId: fetchHybridAIAccountChatbotIdMock,
  fetchHybridAIBots: vi.fn(async () => []),
}));

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-concierge-home-'),
  );
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function createFixture() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase, updateSessionModel } = await import(
    '../src/memory/db.ts'
  );
  initDatabase({ quiet: true });
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  return {
    handleGatewayMessage,
    memoryService,
    updateRuntimeConfig,
    updateSessionModel,
    upsertRegisteredAgent,
  };
}

afterEach(() => {
  runAgentMock.mockReset();
  callAuxiliaryModelMock.mockReset();
  fetchHybridAIAccountChatbotIdMock.mockReset();
  fetchHybridAIAccountChatbotIdMock.mockResolvedValue('user-fallback');
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('asks the urgency question before a long-running request', async () => {
  callAuxiliaryModelMock.mockResolvedValue({
    provider: 'hybridai',
    model: 'gemini-3-flash',
    content: '{"decision":"ask_user"}',
  });

  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.concierge.enabled = true;
    draft.routing.concierge.model = 'gemini-3-flash';
  });

  const result = await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-ask',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Can you create a marketing plan as PDF for our Q3 launch?',
    chatbotId: 'bot_123',
  });

  expect(result.status).toBe('success');
  expect(result.result).toContain('When do you need the result?');
  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).not.toHaveBeenCalled();
  const history = fixture.memoryService.getConversationHistory(
    'session-concierge-ask',
    10,
  );
  expect(
    history.some((message) => message.content.includes('marketing plan')),
  ).toBe(true);
});

test('numeric concierge reply selects the configured profile model', async () => {
  callAuxiliaryModelMock.mockResolvedValue({
    provider: 'hybridai',
    model: 'gemini-3-flash',
    content: '{"decision":"ask_user"}',
  });

  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.concierge.enabled = true;
    draft.routing.concierge.model = 'gemini-3-flash';
    draft.routing.concierge.profiles.noHurry = 'ollama/qwen3:latest';
  });

  await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-choice',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Can you create a marketing plan as PDF for our Q3 launch?',
    chatbotId: 'bot_123',
  });

  const resumed = await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-choice',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: '3',
    chatbotId: 'bot_123',
  });

  expect(resumed.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | { model?: string; messages?: Array<{ role: string; content: string }> }
    | undefined;
  expect(request?.model).toBe('ollama/qwen3:latest');
  expect(request?.messages?.at(-1)?.content).toContain(
    'User selected: No hurry',
  );
  expect(request?.messages?.at(-1)?.content).toContain('marketing plan');
});

test('concierge profile changes still resolve a chatbot for HybridAI models', async () => {
  callAuxiliaryModelMock.mockResolvedValue({
    provider: 'hybridai',
    model: 'gemini-3-flash',
    content: '{"decision":"pick_profile","profile":"asap"}',
  });

  const fixture = await createFixture();
  fixture.upsertRegisteredAgent({
    id: 'research',
    model: 'openai-codex/gpt-5.4',
  });
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.concierge.enabled = true;
    draft.routing.concierge.model = 'gemini-3-flash';
    draft.routing.concierge.profiles.asap = 'gpt-5-nano';
  });

  const result = await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-hybridai-fallback',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'I need a full launch plan ASAP.',
    agentId: 'research',
  });

  expect(result.status).toBe('success');
  expect(fetchHybridAIAccountChatbotIdMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | { chatbotId?: string; model?: string }
    | undefined;
  expect(request?.model).toBe('gpt-5-nano');
  expect(request?.chatbotId).toBe('user-fallback');
});

test('invalid concierge replies re-ask instead of running the agent', async () => {
  callAuxiliaryModelMock.mockResolvedValue({
    provider: 'hybridai',
    model: 'gemini-3-flash',
    content: '{"decision":"ask_user"}',
  });

  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.concierge.enabled = true;
  });

  await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-invalid',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Can you create a marketing plan as PDF for our Q3 launch?',
    chatbotId: 'bot_123',
  });

  const retry = await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-invalid',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'maybe later',
    chatbotId: 'bot_123',
  });

  expect(retry.status).toBe('success');
  expect(retry.result).toContain('Please reply with 1, 2, or 3.');
  expect(runAgentMock).not.toHaveBeenCalled();
});

test('explicit session model pins bypass the concierge', async () => {
  callAuxiliaryModelMock.mockResolvedValue({
    provider: 'hybridai',
    model: 'gemini-3-flash',
    content: '{"decision":"ask_user"}',
  });

  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.concierge.enabled = true;
  });

  await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-pinned',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'hello',
    chatbotId: 'bot_123',
  });
  fixture.updateSessionModel(
    'session-concierge-pinned',
    'openai-codex/gpt-5.4',
  );

  await fixture.handleGatewayMessage({
    sessionId: 'session-concierge-pinned',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Can you create a marketing plan as PDF for our Q3 launch?',
    chatbotId: 'bot_123',
  });

  expect(callAuxiliaryModelMock).not.toHaveBeenCalled();
  expect(runAgentMock).toHaveBeenCalledTimes(2);
  const latest = runAgentMock.mock.calls.at(-1)?.[0] as
    | { model?: string }
    | undefined;
  expect(latest?.model).toBe('openai-codex/gpt-5.4');
});
