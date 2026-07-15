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

test('handleGatewayMessage hardens shared user runs and records the principal', async () => {
  setupHome();

  const {
    getRecentStructuredAuditForSession,
    initDatabase,
    listSemanticMemoriesForSession,
    upsertAgent,
  } = await import('../src/memory/db.ts');
  const { getAllJobs } = await import('../src/memory/jobs.ts');
  const { shareAgent } = await import('../src/agents/agent-sharing.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  upsertAgent({
    id: 'lexware',
    name: 'Lexware',
    model: 'test-model',
    chatbotId: 'bot-1',
  });
  shareAgent({
    agentId: 'lexware',
    principal: 'guest.user@hybridai',
    grantedBy: 'admin@hybridai',
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: ['audio_transcribe'],
    toolExecutions: [
      {
        name: 'audio_transcribe',
        arguments: '{}',
        result: JSON.stringify({
          success: true,
          text: 'private guest transcript',
        }),
        durationMs: 1,
      },
    ],
    sideEffects: {
      schedules: [
        {
          action: 'add',
          everyMs: 60_000,
          prompt: 'Read every transcript later.',
        },
      ],
      delegations: [
        {
          action: 'delegate',
          prompt: 'Read every transcript in a child run.',
        },
      ],
    },
  });
  const sessionId =
    'agent:lexware:channel:web:chat:dm:peer:guest.user@hybridai:thread:turn-1';

  const request = {
    sessionId,
    executionSessionId: 'spoofed-execution-session',
    guildId: 'spoofed-guild',
    channelId: 'discord',
    userId: 'spoofed-user',
    username: 'spoofed-name',
    content: 'Summarize the latest entries.',
    agentId: 'lexware',
    principal: 'guest.user@hybridai.one',
    chatbotId: 'spoofed-chatbot',
    model: 'spoofed-model',
    enableRag: true,
    executorModeOverride: 'host' as const,
    autoApproveTools: true,
    workspacePathOverride: '/tmp/spoofed-workspace',
    workspaceDisplayRootOverride: '/spoofed-workspace',
    maxTokens: 999_999,
    maxWallClockMs: null,
    inactivityTimeoutMs: null,
    bashProxy: {
      mode: 'docker-exec' as const,
      containerName: 'spoofed-container',
    },
    promptMode: 'none' as const,
    source: 'fullauto',
    appBuild: true,
  };

  const result = await handleGatewayMessage(request);

  expect(result.status).toBe('success');
  expect(result.delegation).toBeUndefined();
  expect(
    getAllJobs({
      kind: 'scheduled_task',
      sessionId: result.sessionId || sessionId,
    }),
  ).toEqual([]);
  expect(
    listSemanticMemoriesForSession(result.sessionId || sessionId).filter(
      (memory) => memory.source === 'audio_transcribe',
    ),
  ).toEqual([]);
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      agentId: 'lexware',
      sessionId: result.sessionId,
      channelId: 'web',
      model: 'test-model',
      chatbotId: 'bot-1',
      executorModeOverride: 'container',
      isolateSessionTranscripts: true,
      memoryWritesEnabled: false,
      scheduleSideEffectsEnabled: false,
      workspacePathOverride: undefined,
      workspaceDisplayRootOverride: undefined,
      maxTokens: undefined,
      maxWallClockMs: undefined,
      inactivityTimeoutMs: undefined,
      bashProxy: undefined,
      skipContainerSystemPrompt: false,
      blockedTools: expect.arrayContaining([
        'session_search',
        'delegate',
        'cron',
      ]),
    }),
  );
  expect(request).toMatchObject({
    principal: 'guest.user@hybridai',
    guildId: null,
    channelId: 'web',
    userId: 'guest.user@hybridai',
    username: 'guest.user@hybridai',
    model: undefined,
    chatbotId: undefined,
    enableRag: undefined,
    autoApproveTools: false,
    source: undefined,
    appBuild: undefined,
  });
  const principalEvents = getRecentStructuredAuditForSession(
    result.sessionId || sessionId,
    20,
  ).filter((event) =>
    ['session.start', 'turn.start'].includes(event.event_type),
  );
  expect(principalEvents).toHaveLength(2);
  expect(principalEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event_type: 'session.start',
        actor_type: 'user',
        actor_id: 'guest.user@hybridai',
      }),
      expect.objectContaining({
        event_type: 'turn.start',
        actor_type: 'user',
        actor_id: 'guest.user@hybridai',
      }),
    ]),
  );
});

test('handleGatewayMessage aborts and discards an in-flight turn after grant revocation', async () => {
  setupHome();

  const { initDatabase, upsertAgent } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { shareAgent, unshareAgent } = await import(
    '../src/agents/agent-sharing.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  upsertAgent({
    id: 'lexware',
    name: 'Lexware',
    model: 'test-model',
    chatbotId: 'bot-1',
  });
  shareAgent({
    agentId: 'lexware',
    principal: 'guest.user@hybridai',
    grantedBy: 'admin@hybridai',
  });

  let observedSignal: AbortSignal | undefined;
  runAgentMock.mockImplementation(async (params) => {
    observedSignal = params.abortSignal;
    await new Promise<void>((resolve) => {
      if (observedSignal?.aborted) {
        resolve();
        return;
      }
      observedSignal?.addEventListener('abort', () => resolve(), {
        once: true,
      });
    });
    params.onTextDelta?.('must not be streamed');
    params.onThinkingDelta?.('must not be streamed');
    params.onToolProgress?.({
      toolName: 'session_search',
      phase: 'completed',
    });
    params.onApprovalProgress?.({
      approvalId: 'approval-after-revoke',
      intent: 'read private session',
      reason: 'must not be streamed',
    });
    return {
      status: 'success',
      result: 'must not be persisted',
      toolsUsed: [],
      toolExecutions: [],
    };
  });
  const sessionId =
    'agent:lexware:channel:web:chat:dm:peer:guest.user@hybridai:thread:revoked';
  const onTextDelta = vi.fn();
  const onThinkingDelta = vi.fn();
  const onToolProgress = vi.fn();
  const onApprovalProgress = vi.fn();
  const pending = handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'guest.user@hybridai',
    username: 'guest.user@hybridai',
    content: 'Summarize the latest entries.',
    agentId: 'lexware',
    principal: 'guest.user@hybridai',
    onTextDelta,
    onThinkingDelta,
    onToolProgress,
    onApprovalProgress,
  });
  await vi.waitFor(() => expect(observedSignal).toBeDefined());

  expect(
    unshareAgent({
      agentId: 'lexware',
      principal: 'guest.user@hybridai',
      revokedBy: 'admin@hybridai',
    }),
  ).not.toBeNull();
  const result = await pending;

  expect(observedSignal?.aborted).toBe(true);
  expect(onTextDelta).not.toHaveBeenCalled();
  expect(onThinkingDelta).not.toHaveBeenCalled();
  expect(onToolProgress).not.toHaveBeenCalled();
  expect(onApprovalProgress).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    status: 'error',
    error: 'Agent access grant was revoked or expired.',
  });
  expect(
    memoryService.getConversationHistory(result.sessionId || sessionId, 10),
  ).toEqual([]);
});

test('handleGatewayCommand canonicalizes scoped user request context', async () => {
  setupHome();

  const { getOrCreateSession, initDatabase, upsertAgent } = await import(
    '../src/memory/db.ts'
  );
  const { shareAgent } = await import('../src/agents/agent-sharing.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertAgent({ id: 'lexware', name: 'Lexware', model: 'test-model' });
  shareAgent({
    agentId: 'lexware',
    principal: 'guest.user@hybridai',
    grantedBy: 'admin@hybridai',
  });
  const session = getOrCreateSession(
    'agent:lexware:channel:web:chat:dm:peer:guest.user@hybridai:thread:command-context',
    null,
    'web',
    'lexware',
  );
  const request = {
    sessionId: session.id,
    agentId: 'lexware',
    guildId: 'spoofed-guild',
    channelId: 'discord',
    userId: 'spoofed-user',
    username: 'spoofed-name',
    args: ['help'],
    principal: 'guest.user@hybridai.one',
    onProactiveMessage: vi.fn(),
  };

  const result = await handleGatewayCommand(request);

  expect(result.kind).toBe('info');
  expect(request).toMatchObject({
    principal: 'guest.user@hybridai',
    guildId: null,
    channelId: 'web',
    userId: 'guest.user@hybridai',
    username: 'guest.user@hybridai',
    onProactiveMessage: undefined,
  });
});

test('handleGatewayMessage resets an expired shared-user session without a memory-flush run', async () => {
  setupHome();

  const { initDatabase, upsertAgent, withMemoryDatabase } = await import(
    '../src/memory/db.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { shareAgent } = await import('../src/agents/agent-sharing.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 1,
    };
    draft.sessionCompaction.preCompactionMemoryFlush.enabled = true;
  });
  upsertAgent({
    id: 'lexware',
    name: 'Lexware',
    model: 'test-model',
    chatbotId: 'bot-1',
  });
  shareAgent({
    agentId: 'lexware',
    principal: 'guest.user@hybridai',
    grantedBy: 'admin@hybridai',
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });
  const sessionId =
    'agent:lexware:channel:web:chat:dm:peer:guest.user@hybridai:thread:expired';
  const request = {
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'guest.user@hybridai',
    username: 'guest.user@hybridai',
    content: 'Summarize my entries.',
    agentId: 'lexware',
    principal: 'guest.user@hybridai',
  } as const;

  const initial = await handleGatewayMessage(request);
  expect(initial.status).toBe('success');
  const storedSessionId = initial.sessionId || sessionId;
  withMemoryDatabase((database) => {
    database
      .prepare(
        "UPDATE sessions SET last_active = datetime('now', '-2 hours') WHERE id = ?",
      )
      .run(storedSessionId);
  });
  runAgentMock.mockClear();

  const result = await handleGatewayMessage({
    ...request,
    sessionId: storedSessionId,
  });

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]?.sessionId).not.toContain(
    'memory-flush:',
  );
});

test('handleGatewayMessage rejects a shared user resuming another user session', async () => {
  setupHome();

  const { getOrCreateSession, initDatabase, upsertAgent } = await import(
    '../src/memory/db.ts'
  );
  const { shareAgent } = await import('../src/agents/agent-sharing.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  upsertAgent({ id: 'lexware', name: 'Lexware', model: 'test-model' });
  shareAgent({
    agentId: 'lexware',
    principal: 'guest.user@hybridai',
    grantedBy: 'admin@hybridai',
  });
  const otherSession = getOrCreateSession(
    'agent:lexware:channel:web:chat:dm:peer:other.user@hybridai:thread:private',
    null,
    'web',
    'lexware',
  );

  await expect(
    handleGatewayMessage({
      sessionId: otherSession.id,
      guildId: null,
      channelId: 'web',
      userId: 'guest.user@hybridai',
      username: 'guest.user@hybridai',
      content: 'Show this session.',
      agentId: 'lexware',
      principal: 'guest.user@hybridai',
    }),
  ).rejects.toThrow('Session access is not granted for this user.');
  expect(runAgentMock).not.toHaveBeenCalled();
});

test('handleGatewayMessage keeps a shared user session bound to its agent', async () => {
  setupHome();

  const { getOrCreateSession, initDatabase, upsertAgent } = await import(
    '../src/memory/db.ts'
  );
  const { shareAgent } = await import('../src/agents/agent-sharing.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  for (const agentId of ['lexware', 'other']) {
    upsertAgent({ id: agentId, name: agentId, model: 'test-model' });
    shareAgent({
      agentId,
      principal: 'guest.user@hybridai',
      grantedBy: 'admin@hybridai',
    });
  }
  const ownSession = getOrCreateSession(
    'agent:lexware:channel:web:chat:dm:peer:guest.user@hybridai:thread:bound',
    null,
    'web',
    'lexware',
  );

  await expect(
    handleGatewayMessage({
      sessionId: ownSession.id,
      guildId: null,
      channelId: 'web',
      userId: 'guest.user@hybridai',
      username: 'guest.user@hybridai',
      content: 'Switch agents.',
      agentId: 'other',
      principal: 'guest.user@hybridai',
    }),
  ).rejects.toThrow('Forbidden.');
  await expect(
    handleGatewayMessage({
      sessionId: ownSession.id,
      guildId: null,
      channelId: 'web',
      userId: 'guest.user@hybridai',
      username: 'guest.user@hybridai',
      content: '@other Show this to the other agent.',
      agentId: 'lexware',
      principal: 'guest.user@hybridai',
    }),
  ).rejects.toThrow(
    'Agent switching is not available inside a shared-user session.',
  );
  await expect(
    handleGatewayMessage({
      sessionId: ownSession.id,
      guildId: null,
      channelId: 'web',
      userId: 'guest.user@hybridai',
      username: 'guest.user@hybridai',
      content: 'approve all',
      agentId: 'lexware',
      principal: 'guest.user@hybridai',
    }),
  ).rejects.toThrow('Forbidden.');
  await expect(
    handleGatewayMessage({
      sessionId: 'unscoped-draft-session',
      guildId: null,
      channelId: 'web',
      userId: 'guest.user@hybridai',
      username: 'guest.user@hybridai',
      content: 'Open a draft.',
      agentId: 'lexware',
      principal: 'guest.user@hybridai',
    }),
  ).rejects.toThrow('Forbidden.');
  expect(runAgentMock).not.toHaveBeenCalled();
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
