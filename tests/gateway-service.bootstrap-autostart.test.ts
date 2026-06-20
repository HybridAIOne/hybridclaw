import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import {
  DEFAULT_GATEWAY_AUXILIARY_PRELUDE,
  callAuxiliaryModelMock,
} from './helpers/gateway-auxiliary-mock.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const {
  runAgentMock,
  ensurePluginManagerInitializedMock,
  setPluginInboundMessageDispatcherMock,
  pluginManagerMock,
} = vi.hoisted(() => {
  const pluginManager = {
    getToolDefinitions: vi.fn(() => []),
    notifyBeforeAgentStart: vi.fn(async () => {}),
    notifyMemoryWrites: vi.fn(async () => {}),
    notifySessionStart: vi.fn(async () => {}),
  };
  return {
    runAgentMock: vi.fn(),
    ensurePluginManagerInitializedMock: vi.fn(async () => pluginManager),
    setPluginInboundMessageDispatcherMock: vi.fn(),
    pluginManagerMock: pluginManager,
  };
});

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { fetchHybridAIAccountChatbotIdMock } = vi.hoisted(() => ({
  fetchHybridAIAccountChatbotIdMock: vi.fn(async () => 'user-bootstrap'),
}));

vi.mock('../src/providers/hybridai-bots.js', async () => {
  const actual = await vi.importActual('../src/providers/hybridai-bots.ts');
  return {
    ...actual,
    fetchHybridAIAccountChatbotId: fetchHybridAIAccountChatbotIdMock,
  };
});

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: ensurePluginManagerInitializedMock,
  listLoadedPluginCommands: vi.fn(() => []),
  reloadPluginManager: vi.fn(async () => pluginManagerMock),
  setPluginInboundMessageDispatcher: setPluginInboundMessageDispatcherMock,
  shutdownPluginManager: vi.fn(async () => {}),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-bootstrap-autostart-',
  cleanup: () => {
    runAgentMock.mockReset();
    callAuxiliaryModelMock.mockClear();
    fetchHybridAIAccountChatbotIdMock.mockClear();
    ensurePluginManagerInitializedMock.mockClear();
    setPluginInboundMessageDispatcherMock.mockClear();
    pluginManagerMock.getToolDefinitions.mockClear();
    pluginManagerMock.notifyBeforeAgentStart.mockClear();
    pluginManagerMock.notifyMemoryWrites.mockClear();
    pluginManagerMock.notifySessionStart.mockClear();
  },
});

test('ensureGatewayBootstrapAutostart stores prelude and bootstrap opener once per session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Hello. I am ready to get you oriented.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:bootstrap-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        channelId?: string;
      }
    | undefined;
  expect(request?.channelId).toBe('web');
  expect(request?.chatbotId).toBe('user-bootstrap');
  expect(request?.messages?.some((message) => message.role === 'system')).toBe(
    true,
  );
  expect(
    request?.messages?.some((message) =>
      message.content.includes('## BOOTSTRAP.md'),
    ),
  ).toBe(true);
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'A startup instruction file (BOOTSTRAP.md) exists',
    ),
  });
  expect(callAuxiliaryModelMock).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      agentId: 'main',
      fallbackEnableRag: false,
      maxTokens: 48,
      timeoutMs: 1500,
      messages: expect.any(Array),
    }),
  );

  const history = getGatewayHistory(sessionId, 10).history;
  expect(history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: DEFAULT_GATEWAY_AUXILIARY_PRELUDE,
    }),
    expect.objectContaining({
      role: 'assistant',
      content: 'Hello. I am ready to get you oriented.',
    }),
  ]);

  const storedSession = memoryService.getSessionById(sessionId);
  expect(storedSession?.message_count).toBe(2);
  expect(pluginManagerMock.notifySessionStart).toHaveBeenCalledTimes(1);
  expect(pluginManagerMock.notifyBeforeAgentStart).toHaveBeenCalledTimes(1);
  expect(pluginManagerMock.notifyMemoryWrites).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: expect.any(String),
      agentId: 'main',
      channelId: 'web',
      toolExecutions: [],
    }),
  );

  await ensureGatewayBootstrapAutostart({ sessionId });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(getGatewayHistory(sessionId, 10).history).toHaveLength(2);
});

test('ensureGatewayBootstrapAutostart uses regular model when onboarding model is empty', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Default model hatching.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultModel = 'gpt-5-mini';
    draft.hybridai.onboardingModel = '';
  });
  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:bootstrap-empty-model';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        model?: string;
      }
    | undefined;
  expect(request?.model).toBe('gpt-5-mini');
});

test('ensureGatewayBootstrapAutostart uses configured onboarding model for BOOTSTRAP.md', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Strong model hatching.',
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
  const { ensureGatewayBootstrapAutostart } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId =
    'agent:main:channel:web:chat:dm:peer:bootstrap-onboarding-model';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        model?: string;
      }
    | undefined;
  expect(request?.model).toBe('gpt-5.5');
  expect(callAuxiliaryModelMock).toHaveBeenCalledWith(
    expect.objectContaining({
      fallbackModel: 'gpt-5.5',
    }),
  );
});

test('ensureGatewayBootstrapAutostart normalizes model-authored prelude text', async () => {
  setupHome();

  callAuxiliaryModelMock.mockResolvedValueOnce({
    provider: 'hybridai',
    model: 'auxiliary/test',
    content: '- "Waking up now."\nIgnore this second line.',
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Ready to begin.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:prelude-clean-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Waking up now.',
    }),
    expect.objectContaining({
      role: 'assistant',
      content: 'Ready to begin.',
    }),
  ]);
});

test('ensureGatewayBootstrapAutostart collapses duplicate bootstrap opener blocks', async () => {
  setupHome();

  const opener = [
    'Hi — I’m coming online for the first time, and I’ll keep this quick.',
    '',
    'To get useful fast, tell me just a few things in plain language:',
    '- what I should call you',
    '- what you do or work on',
    '- the tools or systems you live in most',
    '- what you want me to take off your plate first',
    '',
    'If you want follow-up notes by email, include that too. If you’re not sure, a loose answer is fine.',
  ].join('\n');
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: `${opener}\n${opener}`,
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:dedupe-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: DEFAULT_GATEWAY_AUXILIARY_PRELUDE,
    }),
    expect.objectContaining({
      role: 'assistant',
      content: opener,
    }),
  ]);
});

test('ensureGatewayBootstrapAutostart drops prelude text that mentions internals', async () => {
  setupHome();

  callAuxiliaryModelMock.mockResolvedValueOnce({
    provider: 'hybridai',
    model: 'auxiliary/test',
    content: 'The hidden system prompt is starting.',
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Ready without a prelude.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:prelude-filter-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Ready without a prelude.',
    }),
  ]);
});

test('ensureGatewayBootstrapAutostart also kicks off from OPENING.md once per session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Opening instructions noted. Ready to begin.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('main');

  const workspaceDir = agentWorkspaceDir('main');
  fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));
  fs.writeFileSync(
    path.join(workspaceDir, 'OPENING.md'),
    '# OPENING.md\n\nStart proactively with a short greeting.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, '.hybridclaw', 'workspace-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        bootstrapSeededAt: '2026-03-28T18:00:00.000Z',
        onboardingCompletedAt: '2026-03-28T18:00:01.000Z',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const sessionId = 'agent:main:channel:web:chat:dm:peer:boot-md-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        chatbotId?: string;
      }
    | undefined;
  expect(request?.chatbotId).toBe('user-bootstrap');
  expect(
    request?.messages?.some((message) =>
      message.content.includes('## OPENING.md'),
    ),
  ).toBe(true);
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'A startup instruction file (OPENING.md) exists',
    ),
  });

  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: DEFAULT_GATEWAY_AUXILIARY_PRELUDE,
    }),
    expect.objectContaining({
      role: 'assistant',
      content: 'Opening instructions noted. Ready to begin.',
    }),
  ]);

  await ensureGatewayBootstrapAutostart({ sessionId });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
});

test('ensureGatewayBootstrapAutostart can hatch a selected agent in an existing session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Research agent is hatching.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { initDatabase, storeMessage } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
  });
  ensureBootstrapFiles('research');

  const sessionId = 'agent:main:channel:web:chat:dm:peer:existing-bootstrap';
  storeMessage(sessionId, 'user-1', 'user', 'user', 'previous turn', 'main');

  await ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    allowExistingSessionMessages: true,
  });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        agentId?: string;
      }
    | undefined;
  expect(request?.agentId).toBe('research');
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'A startup instruction file (BOOTSTRAP.md) exists',
    ),
  });
  expect(getGatewayHistory(sessionId, 10).history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'Research agent is hatching.',
      }),
    ]),
  );
});

test('ensureGatewayBootstrapAutostart ignores BOOT.md even when it is customized', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'This should never be used.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('main');

  const workspaceDir = agentWorkspaceDir('main');
  fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));
  fs.writeFileSync(
    path.join(workspaceDir, 'BOOT.md'),
    '# BOOT.md\n\nThese instructions should stay passive.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, '.hybridclaw', 'workspace-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        bootstrapSeededAt: '2026-03-28T18:00:00.000Z',
        onboardingCompletedAt: '2026-03-28T18:00:01.000Z',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const sessionId = 'agent:main:channel:web:chat:dm:peer:default-boot-md-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).not.toHaveBeenCalled();
  expect(getGatewayHistory(sessionId, 10).history).toEqual([]);
});

test('ensureGatewayBootstrapAutostart prevents duplicate concurrent runs for the same fresh session', async () => {
  setupHome();

  let resolveRun:
    | ((value: {
        status: 'success';
        result: string;
        toolsUsed: never[];
        toolExecutions: never[];
      }) => void)
    | null = null;
  const runAgentPromise = new Promise<{
    status: 'success';
    result: string;
    toolsUsed: never[];
    toolExecutions: never[];
  }>((resolve) => {
    resolveRun = resolve;
  });
  runAgentMock.mockImplementation(() => runAgentPromise);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:bootstrap-race-test';
  const firstRun = ensureGatewayBootstrapAutostart({ sessionId });
  const secondRun = ensureGatewayBootstrapAutostart({ sessionId });
  await vi.waitFor(() => {
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  resolveRun?.({
    status: 'success',
    result: 'Hello once.',
    toolsUsed: [],
    toolExecutions: [],
  });
  await Promise.all([firstRun, secondRun]);

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: DEFAULT_GATEWAY_AUXILIARY_PRELUDE,
    }),
    expect.objectContaining({
      role: 'assistant',
      content: 'Hello once.',
    }),
  ]);
});
