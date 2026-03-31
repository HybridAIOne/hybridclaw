import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

const {
  stopSessionExecutionMock,
  getActiveExecutorSessionIdsMock,
  getSandboxDiagnosticsMock,
} = vi.hoisted(() => ({
  stopSessionExecutionMock: vi.fn(() => false),
  getActiveExecutorSessionIdsMock: vi.fn(() => []),
  getSandboxDiagnosticsMock: vi.fn(() => ({
    mode: 'host' as const,
    modeExplicit: true,
    runningInsideContainer: false,
    image: null,
    network: null,
    memory: null,
    memorySwap: null,
    cpus: null,
    securityFlags: ['workspace fencing'],
    mountAllowlistPath: '/tmp/mount-allowlist.json',
    additionalMountsConfigured: 0,
    activeSessions: 0,
    warning: 'Running in host mode without container isolation.',
  })),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/agent/executor.js', () => ({
  getActiveExecutorSessionIds: getActiveExecutorSessionIdsMock,
  getSandboxDiagnostics: getSandboxDiagnosticsMock,
  stopSessionExecution: stopSessionExecutionMock,
}));

vi.mock('../src/providers/hybridai-health.js', () => ({
  hybridAIProbe: {
    get: vi.fn(async () => ({
      reachable: false,
      latencyMs: 0,
      error: 'mocked',
    })),
    peek: vi.fn(() => null),
    invalidate: vi.fn(),
  },
}));

vi.mock('../src/providers/local-health.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/providers/local-health.js')
  >('../src/providers/local-health.js');
  return {
    ...actual,
    localBackendsProbe: {
      get: vi.fn(async () => new Map()),
      peek: vi.fn(() => null),
      invalidate: vi.fn(),
    },
  };
});

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-gateway-fullauto-'),
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

function buildLearningState(params: {
  objectiveAlignment: string;
  durableLearnings: string;
  constraints?: string;
  supervisedInterventions?: string;
  strategy: string;
  openQuestions?: string;
  nextStep: string;
}): string {
  return [
    '# Learning State',
    '',
    '## Objective alignment',
    params.objectiveAlignment,
    '',
    '## Durable learnings',
    params.durableLearnings,
    '',
    '## Active constraints and preferences',
    params.constraints || '- None recorded.',
    '',
    '## Recent supervised interventions',
    params.supervisedInterventions || '- None recorded.',
    '',
    '## Current strategy',
    params.strategy,
    '',
    '## Open questions',
    params.openQuestions || '- None recorded.',
    '',
    '## Next step',
    params.nextStep,
  ].join('\n');
}

afterEach(() => {
  runAgentMock.mockReset();
  stopSessionExecutionMock.mockReset();
  stopSessionExecutionMock.mockImplementation(() => false);
  getActiveExecutorSessionIdsMock.mockReset();
  getActiveExecutorSessionIdsMock.mockImplementation(() => []);
  getSandboxDiagnosticsMock.mockReset();
  getSandboxDiagnosticsMock.mockImplementation(() => ({
    mode: 'host' as const,
    modeExplicit: true,
    runningInsideContainer: false,
    image: null,
    network: null,
    memory: null,
    memorySwap: null,
    cpus: null,
    securityFlags: ['workspace fencing'],
    mountAllowlistPath: '/tmp/mount-allowlist.json',
    additionalMountsConfigured: 0,
    activeSessions: 0,
    warning: 'Running in host mode without container isolation.',
  }));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fullauto command enables auto-turns, queues follow-up results, and can be disabled', async () => {
  vi.useFakeTimers();
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  runAgentMock
    .mockResolvedValueOnce({
      status: 'success',
      result: 'first background result',
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: buildLearningState({
        objectiveAlignment:
          'Stay focused on developer and tinkerer-oriented slogan exploration.',
        durableLearnings:
          '- Developers and tinkerers respond to tactile, builder-oriented language more than abstract branding.',
        strategy:
          '- Generate slogan batches, then sharpen phrasing toward more distinctive maker language.',
        openQuestions: '- How bold can the tone get before it feels gimmicky?',
        nextStep:
          '- Push harder on sharper, more characterful phrasing in the next batch.',
      }),
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: 'second background result',
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: buildLearningState({
        objectiveAlignment:
          'Keep the slogan work aimed at developers and tinkerers.',
        durableLearnings:
          '- Concrete maker/developer cues outperform vague speed claims for this audience.',
        strategy:
          '- Iterate toward bolder identity language while preserving clarity.',
        openQuestions:
          '- Which slogans feel bold without slipping into parody?',
        nextStep:
          '- Keep iterating toward bolder language without losing clarity.',
      }),
      toolsUsed: [],
      toolExecutions: [],
    });

  const { initDatabase, listQueuedProactiveMessages, updateSessionChatbot } =
    await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { DEFAULT_AGENT_ID } = await import('../src/agents/agent-types.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { configureFullAutoRuntime } = await import(
    '../src/gateway/fullauto.ts'
  );
  const { getGatewayAgents, handleGatewayCommand, handleGatewayMessage } =
    await import('../src/gateway/gateway-service.ts');
  const { initGatewayService } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );

  initDatabase({ quiet: true });
  configureFullAutoRuntime({ handleGatewayMessage });
  await initGatewayService({ handleGatewayMessage });

  const sessionId = 'session-fullauto';
  memoryService.getOrCreateSession(sessionId, null, 'tui');
  updateSessionChatbot(sessionId, 'bot-1');

  const enabled = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['fullauto', 'Write', 'tests', 'for', 'untested', 'functions'],
  });

  expect(enabled.kind).toBe('info');
  if (enabled.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${enabled.kind}`);
  }
  expect(enabled.title).toBe('Full-Auto Enabled');
  expect(enabled.text).toContain('run indefinitely');
  expect(enabled.text).toContain('fullauto/GOAL_');
  expect(enabled.text).toContain('fullauto/LEARNING_');
  expect(enabled.text).toContain('fullauto/RUN_LOG_');
  expect(
    (await getGatewayAgents()).sessions.find(
      (session) => session.sessionId === sessionId,
    )?.fullAutoEnabled,
  ).toBe(true);

  await vi.advanceTimersByTimeAsync(3_000);
  expect(runAgentMock).toHaveBeenCalledTimes(2);
  const firstMessages = (
    runAgentMock.mock.calls[0]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages;
  expect(firstMessages?.at(-1)?.content).toContain(
    'Write tests for untested functions',
  );
  expect(firstMessages?.at(-1)?.content).toContain(
    'FULLAUTO mode instructions:',
  );
  expect(firstMessages?.[0]?.content).toContain(
    'FULLAUTO mode is active for this session.',
  );
  expect(firstMessages?.[0]?.content).toContain('fullauto/LEARNING_');
  const checkpointMessages = (
    runAgentMock.mock.calls[1]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages;
  expect(checkpointMessages?.[0]?.content).toContain(
    'learning-writer subagent',
  );
  expect(checkpointMessages?.[1]?.content).toContain('Completed turn result:');
  expect(checkpointMessages?.[1]?.content).toContain('first background result');

  await vi.advanceTimersByTimeAsync(3_000);
  expect(runAgentMock).toHaveBeenCalledTimes(4);
  const secondMessages = (
    runAgentMock.mock.calls[2]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages;
  expect(secondMessages?.at(-1)?.content).toContain('Durable goal state:');
  expect(secondMessages?.at(-1)?.content).toContain('Current learning state:');
  expect(secondMessages?.at(-1)?.content).toContain(
    'Recent supervised interventions:',
  );
  expect(secondMessages?.at(-1)?.content).toContain(
    'Developers and tinkerers respond to tactile, builder-oriented language',
  );

  const fullAutoDir = path.join(
    agentWorkspaceDir(DEFAULT_AGENT_ID),
    'fullauto',
  );
  const fullAutoFiles = fs.readdirSync(fullAutoDir);
  const goalFilename = fullAutoFiles.find((entry) =>
    /^GOAL_.+\.md$/.test(entry),
  );
  const learningFilename = fullAutoFiles.find((entry) =>
    /^LEARNING_.+\.md$/.test(entry),
  );
  const runLogFilename = fullAutoFiles.find((entry) =>
    /^RUN_LOG_.+\.md$/.test(entry),
  );
  expect(goalFilename).toBeTruthy();
  expect(learningFilename).toBeTruthy();
  expect(runLogFilename).toBeTruthy();

  const learningsPath = path.join(fullAutoDir, learningFilename || '');
  const learningsText = fs.readFileSync(learningsPath, 'utf8');
  expect(learningsText).toContain('# Learning State');
  expect(learningsText).toContain('## Objective alignment');
  expect(learningsText).toContain('## Durable learnings');
  expect(learningsText).toContain('## Recent supervised interventions');
  expect(learningsText).toContain('## Current strategy');
  expect(learningsText).toContain('## Next step');
  expect(learningsText).toContain(
    'Concrete maker/developer cues outperform vague speed claims',
  );
  expect(learningsText).not.toContain(
    'Developers and tinkerers respond to tactile, builder-oriented language',
  );
  expect(learningsText).not.toContain('first background result');

  const runLogPath = path.join(fullAutoDir, runLogFilename || '');
  const runLogText = fs.readFileSync(runLogPath, 'utf8');
  expect(runLogText).toContain('# Full-Auto Run Log');
  expect(runLogText).toContain('run-started');
  expect(runLogText).toContain('turn-1');
  expect(runLogText).toContain('turn-2');
  expect(runLogText).toContain('first background result');
  expect(runLogText).toContain('second background result');

  const status = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['fullauto', 'status'],
  });

  expect(status.kind).toBe('info');
  if (status.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${status.kind}`);
  }
  expect(status.text).toContain('Enabled: yes');
  expect(status.text).toContain('Turns: 2/1000');

  const queued = listQueuedProactiveMessages(10);
  expect(queued.map((entry) => entry.text)).toEqual([
    'first background result',
    'second background result',
  ]);

  const disabled = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['fullauto', 'off'],
  });

  expect(disabled.kind).toBe('plain');
  expect(disabled.text).toContain('Full-auto mode disabled');

  const session = memoryService.getSessionById(sessionId);
  expect(session?.full_auto_enabled).toBe(0);
  expect(
    (await getGatewayAgents()).sessions.find(
      (session) => session.sessionId === sessionId,
    )?.fullAutoEnabled,
  ).toBe(false);
});

test('bare fullauto shows status and does not enable background looping', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { configureFullAutoRuntime } = await import(
    '../src/gateway/fullauto.ts'
  );
  const { handleGatewayCommand, handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { initGatewayService } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );

  initDatabase({ quiet: true });
  configureFullAutoRuntime({ handleGatewayMessage });
  await initGatewayService({ handleGatewayMessage });

  const sessionId = 'session-fullauto-status-only';
  memoryService.getOrCreateSession(sessionId, null, 'tui');

  const result = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['fullauto'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Full-Auto Status');
  expect(result.text).toContain('Enabled: no');
  expect(runAgentMock).not.toHaveBeenCalled();
  expect(memoryService.getSessionById(sessionId)?.full_auto_enabled).toBe(0);
});

test('stop clears the full-auto running guard and ignores stale auto-turn completions', async () => {
  vi.useFakeTimers();
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  let firstAbortSignal: AbortSignal | undefined;

  runAgentMock
    .mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          firstAbortSignal = (
            args[0] as { abortSignal?: AbortSignal } | undefined
          )?.abortSignal;
          firstAbortSignal?.addEventListener(
            'abort',
            () => {
              resolve({
                status: 'error',
                result: null,
                toolsUsed: [],
                toolExecutions: [],
                error: 'Interrupted by user.',
              });
            },
            { once: true },
          );
        }),
    )
    .mockResolvedValueOnce({
      status: 'success',
      result: 'manual reply',
      toolsUsed: [],
      toolExecutions: [],
    });

  const { initDatabase, listQueuedProactiveMessages, updateSessionChatbot } =
    await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { configureFullAutoRuntime } = await import(
    '../src/gateway/fullauto.ts'
  );
  const { handleGatewayCommand, handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { initGatewayService } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );

  initDatabase({ quiet: true });
  configureFullAutoRuntime({ handleGatewayMessage });
  await initGatewayService({ handleGatewayMessage });

  const sessionId = 'session-fullauto-stop';
  memoryService.getOrCreateSession(sessionId, null, 'tui');
  updateSessionChatbot(sessionId, 'bot-1');

  await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['fullauto', 'ask', 'a', 'follow-up'],
  });

  await vi.advanceTimersByTimeAsync(3_000);
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  const stopped = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['stop'],
  });

  expect(stopped.kind).toBe('plain');
  expect(stopped.text).toContain('disabled full-auto mode');
  expect(firstAbortSignal?.aborted).toBe(true);

  const manual = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    content: 'Hi',
  });

  expect(manual.status).toBe('success');
  expect(manual.result).toBe('manual reply');
  expect(runAgentMock).toHaveBeenCalledTimes(2);
  await vi.runAllTimersAsync();
  await Promise.resolve();

  expect(
    listQueuedProactiveMessages(10).map((entry) => entry.text),
  ).not.toContain('stale full-auto reply');
});

test('manual supervision preempts the active full-auto turn and keeps looping enabled', async () => {
  vi.useFakeTimers();
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  let firstAbortSignal: AbortSignal | undefined;

  runAgentMock
    .mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          firstAbortSignal = (
            args[0] as { abortSignal?: AbortSignal } | undefined
          )?.abortSignal;
          firstAbortSignal?.addEventListener(
            'abort',
            () => {
              resolve({
                status: 'error',
                result: null,
                toolsUsed: [],
                toolExecutions: [],
                error: 'Interrupted by user.',
              });
            },
            { once: true },
          );
        }),
    )
    .mockResolvedValueOnce({
      status: 'success',
      result: 'manual reply',
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: 'resumed full-auto reply',
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: buildLearningState({
        objectiveAlignment:
          'Shift the active loop toward release blockers after user supervision.',
        durableLearnings:
          '- The user intervention materially changed the priority order and should guide the next autonomous turn.',
        constraints:
          '- Prefer release-blocker discovery over open-ended preference questions.',
        supervisedInterventions: '- Actually focus on release blockers first.',
        strategy:
          '- Continue from the new release-blocker focus rather than the prior questionnaire track.',
        nextStep:
          '- Keep probing release blockers before returning to general discovery.',
      }),
      toolsUsed: [],
      toolExecutions: [],
    });

  const { initDatabase, listQueuedProactiveMessages, updateSessionChatbot } =
    await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { configureFullAutoRuntime } = await import(
    '../src/gateway/fullauto.ts'
  );
  const { handleGatewayCommand, handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { initGatewayService } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );

  initDatabase({ quiet: true });
  configureFullAutoRuntime({ handleGatewayMessage });
  await initGatewayService({ handleGatewayMessage });

  const sessionId = 'session-fullauto-supervise';
  memoryService.getOrCreateSession(sessionId, null, 'tui');
  updateSessionChatbot(sessionId, 'bot-1');

  await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['fullauto', 'ask', 'follow-up', 'questions'],
  });

  await vi.advanceTimersByTimeAsync(3_000);
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  const supervised = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    content: 'Actually focus on release blockers first.',
  });

  expect(supervised.status).toBe('success');
  expect(supervised.result).toBe('manual reply');
  expect(stopSessionExecutionMock).toHaveBeenCalledWith(sessionId);
  expect(firstAbortSignal?.aborted).toBe(true);
  expect(memoryService.getSessionById(sessionId)?.full_auto_enabled).toBe(1);
  await Promise.resolve();

  await vi.advanceTimersByTimeAsync(3_000);
  expect(runAgentMock).toHaveBeenCalledTimes(4);
  const supervisedLearningMessages = (
    runAgentMock.mock.calls[3]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages;
  expect(supervisedLearningMessages?.[1]?.content).toContain(
    'Recent supervised interventions:',
  );
  expect(supervisedLearningMessages?.[1]?.content).toContain(
    'Actually focus on release blockers first.',
  );
  expect(listQueuedProactiveMessages(10).map((entry) => entry.text)).toContain(
    'resumed full-auto reply',
  );
  expect(
    listQueuedProactiveMessages(10).map((entry) => entry.text),
  ).not.toContain('stale full-auto reply');
});

test('persisted full-auto sessions resume on startup', async () => {
  vi.useFakeTimers();
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  runAgentMock
    .mockResolvedValueOnce({
      status: 'success',
      result: 'resumed result',
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: buildLearningState({
        objectiveAlignment:
          'Resume the prior research objective after restart.',
        durableLearnings:
          '- Persisted full-auto state is sufficient to continue work after a gateway restart.',
        strategy: '- Continue the planned work using the restored state.',
        nextStep: '- Keep progressing from the restored run state.',
      }),
      toolsUsed: [],
      toolExecutions: [],
    });

  const { initDatabase, updateSessionChatbot, updateSessionFullAuto } =
    await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });
  const sessionId = 'session-fullauto-resume';
  memoryService.getOrCreateSession(sessionId, null, 'tui');
  updateSessionChatbot(sessionId, 'bot-1');
  updateSessionFullAuto(sessionId, {
    enabled: true,
    prompt: 'Resume research',
    startedAt: '2026-03-12T09:00:00.000Z',
  });

  vi.resetModules();

  const { initDatabase: initDatabaseAfterRestart } = await import(
    '../src/memory/db.ts'
  );
  initDatabaseAfterRestart({ quiet: true });
  const { configureFullAutoRuntime } = await import(
    '../src/gateway/fullauto.ts'
  );
  const { handleGatewayMessage, resumeEnabledFullAutoSessions } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { initGatewayService } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );
  configureFullAutoRuntime({ handleGatewayMessage });
  await initGatewayService({ handleGatewayMessage });

  expect(resumeEnabledFullAutoSessions()).toBe(1);
  await vi.advanceTimersByTimeAsync(3_000);

  expect(runAgentMock).toHaveBeenCalledTimes(2);
  const resumedMessages = (
    runAgentMock.mock.calls[0]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages;
  expect(resumedMessages?.at(-1)?.content).toContain('Resume research');
  expect(resumedMessages?.at(-1)?.content).toContain(
    'FULLAUTO mode instructions:',
  );
  expect(resumedMessages?.[0]?.content).toContain(
    'FULLAUTO mode is active for this session.',
  );
  const resumedCheckpointMessages = (
    runAgentMock.mock.calls[1]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages;
  expect(resumedCheckpointMessages?.[0]?.content).toContain(
    'learning-writer subagent',
  );
});

test('watchdog interrupts stalled full-auto turns and retries after recovery delay', async () => {
  vi.useFakeTimers();
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  stopSessionExecutionMock.mockReturnValue(true);

  let resolveFirstRun:
    | ((value: {
        status: 'error';
        result: null;
        toolsUsed: never[];
        toolExecutions: never[];
        error: string;
      }) => void)
    | null = null;

  runAgentMock
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRun = resolve;
        }),
    )
    .mockResolvedValueOnce({
      status: 'success',
      result: 'recovered reply',
      toolsUsed: [],
      toolExecutions: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: buildLearningState({
        objectiveAlignment:
          'Keep digging after recovering from the stalled turn.',
        durableLearnings:
          '- The loop can recover from a stall without losing continuity.',
        constraints:
          '- Watchdog recovery should preserve context without replaying the stalled step.',
        strategy:
          '- Continue from the recovered state and watch for repeat stalls.',
        nextStep: '- Keep progressing while monitoring for another stall.',
      }),
      toolsUsed: [],
      toolExecutions: [],
    });

  const {
    FULLAUTO_STALL_POLL_MS,
    FULLAUTO_STALL_RECOVERY_DELAY_MS,
    FULLAUTO_STALL_TIMEOUT_MS,
  } = await import('../src/config/config.ts');
  const { initDatabase, listQueuedProactiveMessages, updateSessionChatbot } =
    await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { configureFullAutoRuntime } = await import(
    '../src/gateway/fullauto.ts'
  );
  const { handleGatewayCommand, handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { initGatewayService } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );

  initDatabase({ quiet: true });
  configureFullAutoRuntime({ handleGatewayMessage });
  await initGatewayService({ handleGatewayMessage });

  const sessionId = 'session-fullauto-watchdog';
  memoryService.getOrCreateSession(sessionId, null, 'tui');
  updateSessionChatbot(sessionId, 'bot-1');

  await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'tui-user',
    username: 'user',
    args: ['fullauto', 'keep', 'digging'],
  });

  await vi.advanceTimersByTimeAsync(3_000);
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(
    FULLAUTO_STALL_TIMEOUT_MS + FULLAUTO_STALL_POLL_MS,
  );
  expect(stopSessionExecutionMock).toHaveBeenCalledWith(sessionId);

  resolveFirstRun?.({
    status: 'error',
    result: null,
    toolsUsed: [],
    toolExecutions: [],
    error: 'interrupted by watchdog',
  });
  await Promise.resolve();

  await vi.advanceTimersByTimeAsync(FULLAUTO_STALL_RECOVERY_DELAY_MS);
  expect(runAgentMock).toHaveBeenCalledTimes(3);
  expect(listQueuedProactiveMessages(10).map((entry) => entry.text)).toContain(
    'recovered reply',
  );
});
