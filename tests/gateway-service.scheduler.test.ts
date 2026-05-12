import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-gateway-scheduler-');

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

test('admin scheduler includes db-backed tasks and can pause, resume, and delete them', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, createTask } = await import('../src/memory/db.ts');
  const {
    getGatewayAdminScheduler,
    moveGatewayAdminSchedulerJob,
    removeGatewayAdminSchedulerJob,
    setGatewayAdminSchedulerJobPaused,
    upsertGatewayAdminSchedulerJob,
  } = await import('../src/gateway/gateway-scheduled-task-service.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );

  initDatabase({ quiet: true });

  const runAt = new Date(Date.now() + 6 * 60_000).toISOString();
  const taskId = createTask(
    'dm:439508376087560193',
    '1475079601968648386',
    '',
    'Reply exactly with: Drink water',
    runAt,
  );

  const beforePause = getGatewayAdminScheduler().jobs.find(
    (job) => job.id === `task:${taskId}`,
  );
  expect(beforePause).toMatchObject({
    id: `task:${taskId}`,
    source: 'task',
    taskId,
    sessionId: 'dm:439508376087560193',
    channelId: '1475079601968648386',
    enabled: true,
    disabled: false,
    schedule: {
      kind: 'at',
      at: runAt,
    },
    action: {
      kind: 'agent_turn',
      message: 'Reply exactly with: Drink water',
    },
  });
  expect(beforePause?.nextRunAt).not.toBeNull();

  setGatewayAdminSchedulerJobPaused({
    jobId: String(taskId),
    paused: true,
    source: 'task',
  });
  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === `task:${taskId}`),
  ).toMatchObject({
    enabled: false,
    disabled: true,
    nextRunAt: null,
  });

  setGatewayAdminSchedulerJobPaused({
    jobId: String(taskId),
    paused: false,
    source: 'task',
  });
  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === `task:${taskId}`),
  ).toMatchObject({
    enabled: true,
    disabled: false,
  });

  removeGatewayAdminSchedulerJob(String(taskId), 'task');
  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === `task:${taskId}`),
  ).toBeUndefined();

  expect(() =>
    upsertGatewayAdminSchedulerJob({
      job: {
        id: 'invalid-board-status',
        schedule: {
          kind: 'at',
          at: runAt,
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Reply exactly with: Drink water',
        },
        delivery: {
          kind: 'channel',
          channel: '1475079601968648386',
          to: '',
          webhookUrl: '',
        },
        enabled: true,
        boardStatus: 'bogus',
      },
    }),
  ).toThrow(
    'Scheduler board status must be `backlog`, `in_progress`, `review`, `done`, or `cancelled`.',
  );

  updateRuntimeConfig((draft) => {
    draft.scheduler.jobs.push({
      id: 'board-status-job',
      schedule: {
        kind: 'every',
        everyMs: 60_000,
        at: null,
        expr: null,
        tz: 'UTC',
      },
      action: {
        kind: 'agent_turn',
        message: 'Ping',
      },
      delivery: {
        kind: 'channel',
        channel: '1475079601968648386',
        to: '1475079601968648386',
        webhookUrl: '',
      },
      enabled: true,
      boardStatus: 'review',
    });
  });

  moveGatewayAdminSchedulerJob({
    jobId: 'board-status-job',
    beforeJobId: null,
  });
  expect(
    getGatewayAdminScheduler().jobs.find(
      (job) => job.id === 'board-status-job',
    ),
  ).toMatchObject({
    boardStatus: 'review',
  });

  moveGatewayAdminSchedulerJob({
    jobId: 'board-status-job',
    beforeJobId: null,
    boardStatus: null,
  });
  expect(
    getGatewayAdminScheduler().jobs.find(
      (job) => job.id === 'board-status-job',
    ),
  ).toMatchObject({
    boardStatus: null,
  });
});

test('admin scheduler resolves config job session ids through legacy scheduler keys', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getOrCreateSession } = await import(
    '../src/memory/db.ts'
  );
  const { getGatewayAdminScheduler } = await import(
    '../src/gateway/gateway-scheduled-task-service.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );

  initDatabase({ quiet: true });

  updateRuntimeConfig((draft) => {
    draft.scheduler.jobs.push({
      id: 'release-notes',
      schedule: {
        kind: 'at',
        at: '2026-04-07T20:00:00.000Z',
        everyMs: null,
        expr: null,
        tz: 'UTC',
      },
      action: {
        kind: 'agent_turn',
        message: 'Draft release notes',
      },
      delivery: {
        kind: 'channel',
        channel: 'tui',
        to: 'tui',
        webhookUrl: '',
      },
      enabled: true,
      boardStatus: 'review',
      agentId: 'main',
    });
  });

  const session = getOrCreateSession(
    'scheduler:release-notes',
    null,
    'tui',
    'main',
  );

  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === 'release-notes'),
  ).toMatchObject({
    id: 'release-notes',
    source: 'config',
    createdAt: session.created_at,
    sessionId: session.id,
    channelId: 'tui',
  });
});

test('admin scheduler saves one-shot config jobs with retry settings', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayAdminScheduler, upsertGatewayAdminSchedulerJob } =
    await import('../src/gateway/gateway-scheduled-task-service.ts');

  initDatabase({ quiet: true });

  upsertGatewayAdminSchedulerJob({
    job: {
      id: 'release-brief',
      name: 'Release brief',
      maxRetries: 2,
      schedule: {
        kind: 'one_shot',
        at: null,
        everyMs: null,
        expr: null,
        tz: 'UTC',
      },
      action: {
        kind: 'agent_turn',
        message: 'Draft the release brief.',
      },
      delivery: {
        kind: 'channel',
        channel: 'tui',
        to: 'tui',
        webhookUrl: '',
      },
      enabled: true,
    },
  });

  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === 'release-brief'),
  ).toMatchObject({
    id: 'release-brief',
    source: 'config',
    boardStatus: 'backlog',
    maxRetries: 2,
    schedule: {
      kind: 'one_shot',
      at: null,
      everyMs: null,
      expr: null,
      tz: 'UTC',
    },
  });
});

test('admin jobs context exposes full recent assistant outputs for scheduler sessions', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getOrCreateSession } = await import(
    '../src/memory/db.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { getGatewayAdminJobsContext } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const session = getOrCreateSession(
    'scheduler:release-notes',
    null,
    'tui',
    'main',
  );
  const resultText = [
    'HybridClaw 0.10.0 Release Notes',
    '',
    'Release: v0.10.0',
    'Status: Released',
    '',
    '**Highlights**',
    '- Added migration support for scheduler metadata and board reconciliation.',
  ].join('\n');

  memoryService.storeMessage({
    sessionId: session.id,
    userId: 'scheduler',
    username: 'scheduler',
    role: 'user',
    content: 'Draft the release notes.',
  });
  memoryService.storeMessage({
    sessionId: session.id,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: resultText,
  });

  expect(
    getGatewayAdminJobsContext().sessions.find(
      (entry) => entry.sessionId === session.id,
    ),
  ).toMatchObject({
    sessionId: session.id,
    output: [resultText],
  });
});

test('admin jobs context includes suspended sessions for the jobs board', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { createSuspendedSession } = await import(
    '../src/gateway/interactive-escalation.ts'
  );
  const { getGatewayAdminJobsContext } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  createSuspendedSession({
    sessionId: 'session-2fa',
    approvalId: 'approval-2fa',
    prompt: 'Enter the SMS verification code.',
    userId: 'operator-1',
    agentId: 'main',
    modality: 'sms',
    ttlMs: 600_000,
    frameSnapshot: {
      url: 'https://sap.example/login',
    },
    context: {
      host: 'sap.example',
    },
  });

  expect(getGatewayAdminJobsContext().suspendedSessions).toEqual([
    expect.objectContaining({
      sessionId: 'session-2fa',
      agentId: 'main',
      modality: 'sms',
      blockedLabel: 'blocked: needs sms',
    }),
  ]);
});

test('scheduled agent turns persist outputs for admin jobs detail', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result:
      'HybridClaw.io focuses on a personal AI assistant with a gateway, TUI, and sandboxed container runtime.',
    toolExecutions: [],
    artifacts: [],
  });

  const { initDatabase, getOrCreateSession } = await import(
    '../src/memory/db.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { getGatewayAdminJobsContext } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { runIsolatedScheduledTask } = await import(
    '../src/scheduler/scheduled-task-runner.ts'
  );

  initDatabase({ quiet: true });

  const session = getOrCreateSession(
    'scheduler:web-summary',
    null,
    'tui',
    'main',
  );
  const onResult = vi.fn(async () => {});
  const onError = vi.fn();

  await runIsolatedScheduledTask({
    taskId: 249,
    prompt: 'summarize the hybridclaw.io webpage',
    channelId: 'tui',
    chatbotId: 'test-chatbot',
    model: 'gpt-4o-mini',
    agentId: 'main',
    sessionId: session.id,
    sessionKey: 'scheduler:web-summary',
    mainSessionKey: session.main_session_key,
    onResult,
    onError,
  });

  expect(onError).not.toHaveBeenCalled();
  expect(onResult).toHaveBeenCalledWith({
    text: 'HybridClaw.io focuses on a personal AI assistant with a gateway, TUI, and sandboxed container runtime.',
    artifacts: [],
  });
  expect(
    memoryService.getRecentMessages(session.id).map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ).toEqual([
    {
      role: 'user',
      content: 'summarize the hybridclaw.io webpage',
    },
    {
      role: 'assistant',
      content:
        'HybridClaw.io focuses on a personal AI assistant with a gateway, TUI, and sandboxed container runtime.',
    },
  ]);
  expect(
    getGatewayAdminJobsContext().sessions.find(
      (entry) => entry.sessionId === session.id,
    ),
  ).toMatchObject({
    sessionId: session.id,
    output: [
      'HybridClaw.io focuses on a personal AI assistant with a gateway, TUI, and sandboxed container runtime.',
    ],
  });
});
