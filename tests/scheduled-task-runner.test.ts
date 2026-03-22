import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentWorkspaceDir: vi.fn(() => '/tmp/hybridclaw-scheduler-workspace'),
  buildModelUsageAuditStats: vi.fn(() => ({
    promptTokens: 12,
    completionTokens: 6,
    totalTokens: 18,
    toolCallCount: 0,
  })),
  emitToolExecutionAuditEvents: vi.fn(),
  makeAuditRunId: vi.fn(() => 'cron-run'),
  onError: vi.fn(),
  onResult: vi.fn(),
  recordAuditEvent: vi.fn(),
  recordModelUsageAuditEvent: vi.fn(),
  recordUsageEvent: vi.fn(),
  resolveModelProvider: vi.fn(() => 'vllm'),
  runAgent: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('../src/audit/audit-events.js', () => ({
  emitToolExecutionAuditEvents: mocks.emitToolExecutionAuditEvents,
  makeAuditRunId: mocks.makeAuditRunId,
  recordAuditEvent: mocks.recordAuditEvent,
}));

vi.mock('../src/infra/ipc.js', () => ({
  agentWorkspaceDir: mocks.agentWorkspaceDir,
}));

vi.mock('../src/memory/db.js', () => ({
  recordUsageEvent: mocks.recordUsageEvent,
}));

vi.mock('../src/providers/factory.js', () => ({
  resolveModelProvider: mocks.resolveModelProvider,
}));

vi.mock('../src/scheduler/model-usage.js', () => ({
  buildModelUsageAuditStats: mocks.buildModelUsageAuditStats,
  recordModelUsageAuditEvent: mocks.recordModelUsageAuditEvent,
}));

afterEach(() => {
  mocks.runAgent.mockReset();
  mocks.emitToolExecutionAuditEvents.mockReset();
  mocks.recordAuditEvent.mockReset();
  mocks.recordModelUsageAuditEvent.mockReset();
  mocks.recordUsageEvent.mockReset();
  mocks.onError.mockReset();
  mocks.onResult.mockReset();
  vi.resetModules();
});

test('scheduled task runner uses the shared prompt assembly path', async () => {
  mocks.runAgent.mockResolvedValue({
    status: 'success',
    result: 'Scheduled task complete.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { runIsolatedScheduledTask } = await import(
    '../src/scheduler/scheduled-task-runner.ts'
  );

  await runIsolatedScheduledTask({
    taskId: 7,
    prompt: 'Summarize the nightly changes.',
    channelId: 'scheduler',
    chatbotId: 'bot-1',
    model: 'test-model',
    agentId: 'main',
    onResult: mocks.onResult,
    onError: mocks.onError,
  });

  const agentMessages = mocks.runAgent.mock.calls[0]?.[0]?.messages;
  expect(agentMessages?.[0]?.role).toBe('system');
  expect(agentMessages?.[0]?.content).toContain('## Runtime Metadata');
  expect(agentMessages?.[0]?.content).toContain('## Runtime Safety Guardrails');
  expect(agentMessages?.at(-1)).toEqual({
    role: 'user',
    content: 'Summarize the nightly changes.',
  });
});
