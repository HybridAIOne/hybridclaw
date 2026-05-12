import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-skill-observation-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('handleGatewayMessage records observations for implicitly activated single-skill runs', async () => {
  setupHome();

  const { initDatabase, getSkillObservationSummary } = await import(
    '../src/memory/db.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { subscribeSkillRunEvents } = await import(
    '../src/skills/skill-run-events.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.observationEnabled = true;
  });

  const receivedEvents: unknown[] = [];
  const unsubscribe = subscribeSkillRunEvents((event) => {
    receivedEvents.push(event);
  });

  runAgentMock.mockResolvedValue({
    status: 'error',
    result: null,
    toolsUsed: ['bash'],
    toolExecutions: [
      {
        name: 'bash',
        arguments:
          '{"cmd":"bash skills/apple-music/scripts/search.sh \\"... But Seriously by Phil Collins\\""}',
        result: 'resolved the wrong album',
        durationMs: 24,
        isError: true,
      },
    ],
    tokenUsage: {
      modelCalls: 1,
      apiUsageAvailable: true,
      apiPromptTokens: 12,
      apiCompletionTokens: 5,
      apiTotalTokens: 17,
      apiCacheUsageAvailable: false,
      apiCacheReadTokens: 0,
      apiCacheWriteTokens: 0,
      estimatedPromptTokens: 10,
      estimatedCompletionTokens: 4,
      estimatedTotalTokens: 14,
      costUsd: 0.00042,
    },
    error: 'resolved the wrong album',
  });

  let result!: Awaited<ReturnType<typeof handleGatewayMessage>>;
  try {
    result = await handleGatewayMessage({
      sessionId: 'session-implicit-apple-music',
      guildId: null,
      channelId: 'web',
      userId: 'user-1',
      username: 'alice',
      content: 'Play ... But Seriously by Phil Collins',
      model: 'test-model',
      chatbotId: 'bot-1',
      agentId: 'agent-alice',
    });
  } finally {
    unsubscribe();
  }

  expect(result.status).toBe('error');
  expect(getSkillObservationSummary({ skillName: 'apple-music' })).toEqual([
    expect.objectContaining({
      skill_name: 'apple-music',
      total_executions: 1,
      failure_count: 1,
      tool_calls_attempted: 1,
      tool_calls_failed: 1,
    }),
  ]);
  expect(receivedEvents).toEqual([
    expect.objectContaining({
      type: 'skill_run',
      skill_id: 'apple-music',
      agent_id: 'agent-alice',
      session_id: 'session-implicit-apple-music',
      model: 'test-model',
      latency_ms: expect.any(Number),
      cost_usd: 0.00042,
      errors: ['resolved the wrong album'],
      tokens: expect.objectContaining({
        prompt: 12,
        completion: 5,
        total: 17,
        modelCalls: 1,
        apiUsageAvailable: true,
      }),
      input: {
        content: expect.stringContaining('Phil Collins'),
        truncated: false,
      },
      output: {
        content: '{"status":"error","result":null}',
        truncated: false,
      },
    }),
  ]);
});

test('handleGatewayMessage does not attribute ambiguous read-only skill exploration', async () => {
  setupHome();

  const { initDatabase, getSkillObservationSummary } = await import(
    '../src/memory/db.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.observationEnabled = true;
  });

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'I explored a few skills.',
    toolsUsed: ['read'],
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"skills/apple-music/SKILL.md"}',
        result: 'ok',
        durationMs: 4,
      },
      {
        name: 'read',
        arguments: '{"path":"skills/pdf/SKILL.md"}',
        result: 'ok',
        durationMs: 4,
      },
    ],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-ambiguous-skill-read',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Help with a file and some music.',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(getSkillObservationSummary({ skillName: 'apple-music' })).toEqual([]);
  expect(getSkillObservationSummary({ skillName: 'pdf' })).toEqual([]);
});

test('handleGatewayMessage does not request text streaming when no text callback is provided', async () => {
  setupHome();

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
    sessionId: 'session-no-stream',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Say hi',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]?.onTextDelta).toBeUndefined();
});

test('handleGatewayMessage can auto-approve tools for eval requests without enabling full-auto session mode', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: ['write'],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-eval-auto-approve',
    guildId: null,
    channelId: 'eval-terminal-bench-native',
    userId: 'terminal-bench-native',
    username: 'terminal-bench-native',
    content: 'Write the file.',
    model: 'test-model',
    chatbotId: 'bot-1',
    autoApproveTools: true,
    neverAutoApproveTools: [],
    promptMode: 'none',
    source: 'eval.terminal-bench.native',
  });

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]?.fullAutoEnabled).toBe(true);
  expect(runAgentMock.mock.calls[0]?.[0]?.fullAutoNeverApproveTools).toEqual(
    [],
  );
  expect(runAgentMock.mock.calls[0]?.[0]?.skipContainerSystemPrompt).toBe(true);
  const messages = runAgentMock.mock.calls[0]?.[0]?.messages as
    | Array<{ content?: string }>
    | undefined;
  expect(messages?.[0]?.content || '').not.toContain(
    'FULLAUTO mode is active for this session.',
  );
});

test('handleGatewayMessage uses gateway system prompt mode defaults for container prompt skipping', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { GATEWAY_SYSTEM_PROMPT_MODE_ENV } = await import(
    '../src/gateway/gateway-lifecycle.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  process.env[GATEWAY_SYSTEM_PROMPT_MODE_ENV] = 'none';
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });

  try {
    const result = await handleGatewayMessage({
      sessionId: 'session-gateway-system-prompt-mode-none',
      guildId: null,
      channelId: 'web',
      userId: 'user-1',
      username: 'alice',
      content: 'Hi!',
      model: 'test-model',
      chatbotId: 'bot-1',
    });

    expect(result.status).toBe('success');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0]?.[0]?.skipContainerSystemPrompt).toBe(
      true,
    );
    const messages = runAgentMock.mock.calls[0]?.[0]?.messages as
      | Array<{ role?: string; content?: string }>
      | undefined;
    expect(messages).toEqual([{ role: 'user', content: 'Hi!' }]);
  } finally {
    delete process.env[GATEWAY_SYSTEM_PROMPT_MODE_ENV];
  }
});

test('handleGatewayMessage uses gateway tools mode defaults for tool ablation', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { GATEWAY_TOOLS_MODE_ENV } = await import(
    '../src/gateway/gateway-lifecycle.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  process.env[GATEWAY_TOOLS_MODE_ENV] = 'none';
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });

  try {
    const result = await handleGatewayMessage({
      sessionId: 'session-gateway-tools-mode-none',
      guildId: null,
      channelId: 'web',
      userId: 'user-1',
      username: 'alice',
      content: 'Hi!',
      model: 'test-model',
      chatbotId: 'bot-1',
    });

    expect(result.status).toBe('success');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0]?.[0]?.allowedTools).toEqual([]);
  } finally {
    delete process.env[GATEWAY_TOOLS_MODE_ENV];
  }
});

test('setGatewayAdminSkillEnabled stores per-channel disabled skills separately', async () => {
  setupHome();

  const { getRuntimeConfig, updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { setGatewayAdminSkillEnabled } = await import(
    '../src/gateway/gateway-service.ts'
  );

  updateRuntimeConfig((draft) => {
    draft.skills.disabled = ['pdf'];
    draft.skills.channelDisabled = {
      discord: ['docx'],
    };
  });

  const result = setGatewayAdminSkillEnabled({
    name: 'pptx',
    enabled: false,
    channel: 'teams',
  });

  expect(getRuntimeConfig().skills.disabled).toEqual(['pdf']);
  expect(getRuntimeConfig().skills.channelDisabled).toEqual({
    discord: ['docx'],
    msteams: ['pptx'],
  });
  expect(result.disabled).toEqual(['pdf']);
  expect(result.channelDisabled).toEqual({
    discord: ['docx'],
    msteams: ['pptx'],
  });
});
