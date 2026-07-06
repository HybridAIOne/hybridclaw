import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
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
    collectPromptContextDetails: vi.fn(async () => ({
      sections: [],
      pluginIds: [],
      replacesBuiltInMemory: false,
    })),
    collectPromptContext: vi.fn(async () => []),
    getToolDefinitions: vi.fn(() => []),
    getMemoryLayerBehavior: vi.fn(async () => ({
      replacesBuiltInMemory: false,
    })),
    hasMiddleware: vi.fn(() => false),
    applyMiddleware: vi.fn(async () => ({
      userContent: '',
      resultText: '',
      blocked: false,
      events: [],
    })),
    hasOutputGuards: vi.fn(() => false),
    applyOutputGuards: vi.fn(async (context: { resultText: string }) => ({
      resultText: context.resultText,
      blocked: false,
      events: [],
    })),
    notifyBeforeAgentStart: vi.fn(async () => {}),
    notifyAgentEnd: vi.fn(async () => {}),
    notifyMemoryWrites: vi.fn(async () => {}),
    notifySessionStart: vi.fn(async () => {}),
    notifyTurnComplete: vi.fn(async () => {}),
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
    pluginManagerMock.collectPromptContextDetails.mockClear();
    pluginManagerMock.collectPromptContext.mockClear();
    pluginManagerMock.getToolDefinitions.mockClear();
    pluginManagerMock.getMemoryLayerBehavior.mockClear();
    pluginManagerMock.hasMiddleware.mockClear();
    pluginManagerMock.applyMiddleware.mockClear();
    pluginManagerMock.hasOutputGuards.mockClear();
    pluginManagerMock.applyOutputGuards.mockClear();
    pluginManagerMock.notifyBeforeAgentStart.mockClear();
    pluginManagerMock.notifyAgentEnd.mockClear();
    pluginManagerMock.notifyMemoryWrites.mockClear();
    pluginManagerMock.notifySessionStart.mockClear();
    pluginManagerMock.notifyTurnComplete.mockClear();
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

  const { getRecentStructuredAuditForSession, initDatabase } = await import(
    '../src/memory/db.ts'
  );
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
        chatbotId?: string;
      }
    | undefined;
  expect(request?.channelId).toBe('web');
  expect(request?.chatbotId).toBe('user-bootstrap');
  expect(request?.messages?.some((message) => message.role === 'system')).toBe(
    true,
  );
  const systemPrompt =
    request?.messages?.find((message) => message.role === 'system')?.content ||
    '';
  expect(systemPrompt).toContain('## SOUL.md');
  expect(systemPrompt).toContain('## IDENTITY.md');
  expect(systemPrompt).toContain('## USER.md');
  expect(systemPrompt).toContain('## MEMORY.md');
  expect(systemPrompt).toContain('## BOOTSTRAP.md');
  expect(systemPrompt).toContain('## Runtime Metadata');
  expect(systemPrompt).toContain("new coworker's first day");
  expect(systemPrompt).toContain('You are not running an intake form');
  expect(systemPrompt).toContain('Write an actual message');
  expect(systemPrompt).toContain('genuine greeting');
  expect(systemPrompt).toContain(
    'not a setup wizard',
  );
  expect(systemPrompt).toContain('one question per line');
  expect(systemPrompt).toContain('Two or three questions');
  expect(systemPrompt).toContain("what they'd like to call YOU");
  expect(systemPrompt).toContain("don't have a fixed name yet");
  expect(systemPrompt).toContain('including the name they chose for you');
  expect(systemPrompt).toContain('a good email for you');
  expect(systemPrompt).toContain('home automation');
  expect(systemPrompt).toContain("what they're working on right now");
  expect(systemPrompt).toContain("claim it's sent until");
  expect(systemPrompt).not.toContain('## AGENTS.md');
  expect(systemPrompt).not.toContain('## TOOLS.md');
  expect(systemPrompt).not.toContain('## BOOT.md');
  expect(systemPrompt).not.toContain('## OPENING.md');
  expect(systemPrompt).not.toContain('## Skills (mandatory)');
  expect(systemPrompt).not.toContain('<required_credentials>');
  expect(systemPrompt).not.toContain('<supported_channels>');
  expect(systemPrompt).not.toContain('## Runtime Safety Guardrails');
  expect(systemPrompt).not.toContain('## Tool Execution Discipline');
  expect(systemPrompt).not.toContain('## Web Retrieval Routing');
  expect(systemPrompt).not.toContain('## Browser Auth Handling');
  expect(systemPrompt).not.toContain('## Subagent Delegation Playbook');
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'Greet the user like you are his new coworker or companion',
    ),
  });
  expect(request?.messages?.at(-1)?.content).toContain(
    "Don't forget to ask for the email",
  );
  expect(request?.messages?.at(-1)?.content).not.toContain(
    'startup instruction file',
  );
  expect(callAuxiliaryModelMock).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      agentId: 'main',
      fallbackEnableRag: false,
      maxTokens: 48,
      timeoutMs: 5000,
      messages: [
        {
          role: 'user',
          content:
            'You are a HybridClaw agent coming alive. Tell the user in a nice way that you are on your way. Make it one sentence only.',
        },
      ],
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
  const auditRows = getRecentStructuredAuditForSession(
    storedSession?.id || sessionId,
    100,
  );
  const quickMessageEvent = auditRows.find(
    (row) => row.event_type === 'onboarding.quick_message',
  );
  const assistantMessageEvent = auditRows.find(
    (row) => row.event_type === 'onboarding.assistant_message',
  );
  expect(quickMessageEvent).toBeTruthy();
  expect(assistantMessageEvent).toBeTruthy();
  expect(JSON.parse(String(quickMessageEvent?.payload || '{}'))).toMatchObject({
    type: 'onboarding.quick_message',
    workspaceAgentId: 'main',
    source: 'gateway.bootstrap',
    bootstrapFile: 'BOOTSTRAP.md',
    messageRole: 'assistant',
    messageChars: DEFAULT_GATEWAY_AUXILIARY_PRELUDE.length,
  });
  expect(
    JSON.parse(String(assistantMessageEvent?.payload || '{}')),
  ).toMatchObject({
    type: 'onboarding.assistant_message',
    workspaceAgentId: 'main',
    source: 'gateway.bootstrap',
    bootstrapFile: 'BOOTSTRAP.md',
    messageRole: 'assistant',
    messageChars: 'Hello. I am ready to get you oriented.'.length,
    toolCallCount: 0,
  });
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

test('ensureGatewayBootstrapAutostart records later onboarding turns as continue', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Still onboarding.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const {
    getRecentStructuredAuditForSession,
    getSessionById,
    initDatabase,
  } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId =
    'agent:main:channel:web:chat:dm:peer:bootstrap-continue-audit';
  await ensureGatewayBootstrapAutostart({ sessionId });
  await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'main',
    content: 'My email is ben@example.com',
    chatbotId: 'bot-1',
  });

  const storedSessionId = getSessionById(sessionId)?.id || sessionId;
  const auditRows = getRecentStructuredAuditForSession(storedSessionId, 100);
  const onboardingTurnEvents = auditRows
    .filter(
      (row) =>
        row.event_type === 'onboarding.start' ||
        row.event_type === 'onboarding.continue',
    )
    .sort((left, right) => left.seq - right.seq);

  expect(onboardingTurnEvents.map((row) => row.event_type)).toEqual([
    'onboarding.start',
    'onboarding.continue',
  ]);
  const startPayload = JSON.parse(
    String(onboardingTurnEvents[0]?.payload || '{}'),
  );
  const continuePayload = JSON.parse(
    String(onboardingTurnEvents[1]?.payload || '{}'),
  );
  expect(startPayload).toMatchObject({
    type: 'onboarding.start',
    workspaceAgentId: 'main',
    source: 'gateway.bootstrap',
    bootstrapFile: 'BOOTSTRAP.md',
  });
  expect(continuePayload).toMatchObject({
    type: 'onboarding.continue',
    workspaceAgentId: 'main',
    source: 'gateway.chat',
    bootstrapFile: 'BOOTSTRAP.md',
    onboardingStartedAt: startPayload.onboardingStartedAt,
  });
});

test('ensureGatewayBootstrapAutostart audits onboarding abort when bootstrap is already absent', async () => {
  setupHome();

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const {
    getRecentStructuredAuditForSession,
    getSessionById,
    initDatabase,
  } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'research' });
  ensureBootstrapFiles('research');

  const workspaceDir = agentWorkspaceDir('research');
  fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));

  const sessionId =
    'agent:main:channel:web:chat:dm:peer:bootstrap-missing-abort';
  await ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
  });

  expect(runAgentMock).not.toHaveBeenCalled();
  const storedSessionId = getSessionById(sessionId)?.id || sessionId;
  const auditRows = getRecentStructuredAuditForSession(storedSessionId, 20);
  const abortEvent = auditRows.find(
    (row) => row.event_type === 'onboarding.abort',
  );
  expect(abortEvent).toBeTruthy();
  expect(JSON.parse(String(abortEvent?.payload || '{}'))).toMatchObject({
    type: 'onboarding.abort',
    workspaceAgentId: 'research',
    source: 'gateway.bootstrap',
    bootstrapFile: 'BOOTSTRAP.md',
    gatewayRule: 'missing_bootstrap_after_seed',
  });
});

test('ensureGatewayBootstrapAutostart does not refresh started sessions on history probes', async () => {
  setupHome();

  const { initDatabase, getSessionById, storeMessage } = await import(
    '../src/memory/db.ts'
  );
  const { DB_PATH } = await import('../src/config/config.ts');
  const { ensureGatewayBootstrapAutostart } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:opened-session';
  memoryService.getOrCreateSession(sessionId, null, 'web', 'main');
  storeMessage(sessionId, 'user-1', 'user', 'user', 'previous turn', 'main');

  const oldLastActive = '2026-04-01T00:00:00.000Z';
  const storedSession = getSessionById(sessionId);
  expect(storedSession).toBeTruthy();
  const db = new Database(DB_PATH);
  db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(
    oldLastActive,
    storedSession?.id,
  );
  db.close();

  await ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
  });

  expect(runAgentMock).not.toHaveBeenCalled();
  expect(getSessionById(sessionId)?.last_active).toBe(oldLastActive);
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

test('ensureGatewayBootstrapAutostart keeps bootstrap opener when auxiliary generation fails', async () => {
  setupHome();

  callAuxiliaryModelMock.mockRejectedValueOnce(new Error('aux timeout'));
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Ready after aux failure.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:prelude-fallback-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
      }
    | undefined;
  expect(request?.messages?.at(-1)?.content).toContain(
    'Greet the user like you are his new coworker or companion',
  );
  expect(request?.messages?.at(-1)?.content).toContain(
    "Don't forget to ask for the email",
  );
  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Ready after aux failure.',
    }),
  ]);
});

test('ensureGatewayBootstrapAutostart also kicks off from OPENING.md once per session', async () => {
  setupHome();

  callAuxiliaryModelMock.mockResolvedValueOnce({
    provider: 'hybridai',
    model: 'auxiliary/test',
    content: 'Why did the computer go to therapy?\nIt had too many unresolved issues.',
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

  expect(runAgentMock).not.toHaveBeenCalled();
  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(1);
  const request = callAuxiliaryModelMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        fallbackChatbotId?: string;
        maxTokens?: number;
        timeoutMs?: number;
      }
    | undefined;
  expect(request?.fallbackChatbotId).toBe('user-bootstrap');
  expect(request?.maxTokens).toBe(512);
  expect(request?.timeoutMs).toBe(5000);
  expect(
    request?.messages?.some((message) =>
      message.content.includes('## OPENING.md'),
    ),
  ).toBe(true);
  expect(
    request?.messages?.some((message) =>
      message.content.includes('Follow OPENING.md before replying normally'),
    ),
  ).toBe(true);
  expect(
    request?.messages?.some((message) =>
      message.content.includes('Opening kickoff turn'),
    ),
  ).toBe(true);
  expect(
    request?.messages?.some((message) =>
      message.content.includes('brief hatching prelude'),
    ),
  ).toBe(false);
  expect(
    request?.messages?.some((message) =>
      message.content.includes('HybridClaw agent coming alive'),
    ),
  ).toBe(false);
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining('Generate exactly one concise'),
  });

  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content:
        'Why did the computer go to therapy?\nIt had too many unresolved issues.',
    }),
  ]);

  await ensureGatewayBootstrapAutostart({ sessionId });
  expect(runAgentMock).not.toHaveBeenCalled();
  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(1);
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
      'Greet the user like you are his new coworker or companion',
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

test('ensureGatewayBootstrapAutostart uses the active thread agent without explicit agentId', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Active research agent is hatching.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { setActiveThreadAgentId } = await import(
    '../src/gateway/agent-addressing.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
  });
  ensureBootstrapFiles('research');

  const sessionId =
    'agent:main:channel:web:chat:dm:peer:active-agent-bootstrap';
  const session = memoryService.getOrCreateSession(
    sessionId,
    null,
    'web',
    'main',
  );
  setActiveThreadAgentId(session, 'research');

  await ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
  });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        agentId?: string;
      }
    | undefined;
  expect(request?.agentId).toBe('research');
  expect(getGatewayHistory(sessionId, 10).history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'Active research agent is hatching.',
      }),
    ]),
  );
});

test('ensureGatewayBootstrapAutostart hatches the configured default agent without explicit agentId or existing session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Default research agent is hatching.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
  });
  updateRuntimeConfig((draft) => {
    draft.agents.defaultAgentId = 'research';
    draft.agents.list = [{ id: 'main' }, { id: 'research' }];
  });
  ensureBootstrapFiles('research');

  const sessionId = 'sess_default_agent_bootstrap';

  await ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
  });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        agentId?: string;
      }
    | undefined;
  expect(request?.agentId).toBe('research');
  expect(getGatewayHistory(sessionId, 10).history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'Default research agent is hatching.',
      }),
    ]),
  );
});

test('ensureGatewayBootstrapAutostart reruns after same agent id is recreated with fresh BOOTSTRAP', async () => {
  setupHome();

  runAgentMock
    .mockResolvedValueOnce({
      status: 'success',
      result: 'First hatching.',
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: 'Fresh hatching after reinstall.',
      toolsUsed: [],
      toolExecutions: [],
    });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'research' });
  ensureBootstrapFiles('research');

  const sessionId = 'agent:main:channel:web:chat:dm:peer:reinstall-bootstrap';
  await ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
  });

  expect(runAgentMock).toHaveBeenCalledTimes(1);

  fs.rmSync(path.dirname(agentWorkspaceDir('research')), {
    recursive: true,
    force: true,
  });
  ensureBootstrapFiles('research');

  await ensureGatewayBootstrapAutostart({
    sessionId,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    agentId: 'research',
    allowExistingSessionMessages: true,
  });

  expect(runAgentMock).toHaveBeenCalledTimes(2);
  expect(getGatewayHistory(sessionId, 10).history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'First hatching.',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Fresh hatching after reinstall.',
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
