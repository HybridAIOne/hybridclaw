import { afterEach, describe, expect, test, vi } from 'vitest';

const {
  runAgentMock,
  getWorkflowMock,
  updateWorkflowRunStatusMock,
  deliverProactiveMessageMock,
  loggerWarnMock,
  resolveAgentForRequestMock,
  makeAuditRunIdMock,
} = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  getWorkflowMock: vi.fn(),
  updateWorkflowRunStatusMock: vi.fn(),
  deliverProactiveMessageMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  resolveAgentForRequestMock: vi.fn(),
  makeAuditRunIdMock: vi.fn(() => 'workflow-run-1'),
}));

vi.mock('../../../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../../../src/agents/agent-registry.js', () => ({
  resolveAgentForRequest: resolveAgentForRequestMock,
}));

vi.mock('../../../src/audit/audit-events.js', () => ({
  emitToolExecutionAuditEvents: vi.fn(),
  makeAuditRunId: makeAuditRunIdMock,
  recordAuditEvent: vi.fn(),
}));

vi.mock('../../../src/gateway/proactive-delivery.js', () => ({
  deliverProactiveMessage: deliverProactiveMessageMock,
  deliverWebhookMessage: vi.fn(),
}));

vi.mock('../../../src/infra/ipc.js', () => ({
  agentWorkspaceDir: vi.fn(() => '/tmp/hybridclaw-agent'),
}));

vi.mock('../../../src/logger.js', () => ({
  logger: {
    warn: loggerWarnMock,
  },
}));

vi.mock('../../../src/memory/db.js', () => ({
  getWorkflow: getWorkflowMock,
  recordUsageEvent: vi.fn(),
  updateWorkflowRunStatus: updateWorkflowRunStatusMock,
}));

vi.mock('../../../src/memory/memory-service.js', () => ({
  memoryService: {
    getOrCreateSession: vi.fn(() => ({ id: 'session-workflow' })),
  },
}));

vi.mock('../../../src/providers/factory.js', () => ({
  modelRequiresChatbotId: vi.fn(() => false),
  resolveModelProvider: vi.fn(() => 'hybridai'),
}));

vi.mock('../../../src/session/token-efficiency.js', () => ({
  estimateTokenCountFromMessages: vi.fn(() => 12),
  estimateTokenCountFromText: vi.fn(() => 8),
}));

vi.mock('../../../src/workflow/interpolation.js', () => ({
  buildWorkflowInterpolationContext: vi.fn(() => ({})),
  interpolateWorkflowTemplate: vi.fn((template: string) => template),
}));

function buildWorkflow() {
  return {
    id: 7,
    session_id: 'session-workflow',
    agent_id: 'agent-1',
    channel_id: 'channel-1',
    name: 'Daily digest',
    description: 'Summarize updates every morning.',
    natural_language: 'Every day at 9am summarize updates.',
    enabled: 1,
    companion_task_id: null,
    last_run: null,
    last_status: null,
    consecutive_errors: 0,
    run_count: 0,
    created_at: '2026-03-16 09:00:00',
    updated_at: '2026-03-16 09:00:00',
    spec: {
      version: 2 as const,
      trigger: {
        kind: 'schedule' as const,
        cronExpr: '*/5 * * * *',
      },
      steps: [
        {
          id: 'summarize',
          kind: 'agent' as const,
          prompt: 'Summarize the latest updates.',
        },
      ],
      delivery: {
        kind: 'originating' as const,
      },
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe.sequential('workflow execution overlap guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  test('skips starting a second run while the workflow is still executing', async () => {
    const deferred = createDeferred<{
      status: 'success';
      result: string;
      toolsUsed: string[];
      toolExecutions: [];
    }>();

    getWorkflowMock.mockReturnValue(buildWorkflow());
    resolveAgentForRequestMock.mockReturnValue({
      agentId: 'agent-1',
      chatbotId: 'bot-1',
      model: 'gpt-5',
    });
    runAgentMock.mockImplementationOnce(() => deferred.promise);
    deliverProactiveMessageMock.mockResolvedValue(undefined);

    const { executeWorkflow } = await import(
      '../../../src/workflow/executor.js'
    );

    const firstRun = executeWorkflow({
      workflowId: 7,
      agentId: 'agent-1',
      sessionId: 'session-workflow',
    });

    await executeWorkflow({
      workflowId: 7,
      agentId: 'agent-1',
      sessionId: 'session-workflow',
    });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 7,
        workflowName: 'Daily digest',
        triggerKind: 'schedule',
      }),
      'Skipping workflow execution because another run is still in progress',
    );

    deferred.resolve({
      status: 'success',
      result: 'Workflow summary',
      toolsUsed: [],
      toolExecutions: [],
    });
    await firstRun;
  });

  test('releases the running guard after a workflow completes', async () => {
    getWorkflowMock.mockReturnValue(buildWorkflow());
    resolveAgentForRequestMock.mockReturnValue({
      agentId: 'agent-1',
      chatbotId: 'bot-1',
      model: 'gpt-5',
    });
    runAgentMock.mockResolvedValue({
      status: 'success',
      result: 'Workflow summary',
      toolsUsed: [],
      toolExecutions: [],
    });
    deliverProactiveMessageMock.mockResolvedValue(undefined);

    const { executeWorkflow } = await import(
      '../../../src/workflow/executor.js'
    );

    await executeWorkflow({
      workflowId: 7,
      agentId: 'agent-1',
      sessionId: 'session-workflow',
    });
    await executeWorkflow({
      workflowId: 7,
      agentId: 'agent-1',
      sessionId: 'session-workflow',
    });

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(updateWorkflowRunStatusMock).toHaveBeenNthCalledWith(
      1,
      7,
      'success',
    );
    expect(updateWorkflowRunStatusMock).toHaveBeenNthCalledWith(
      2,
      7,
      'success',
    );
  });
});
