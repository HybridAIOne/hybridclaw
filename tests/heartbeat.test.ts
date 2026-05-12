import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentWorkspaceDir: vi.fn(() => '/tmp/hybridclaw-heartbeat-workspace'),
  appendSessionTranscript: vi.fn(),
  buildConversationContext: vi.fn(() => ({ messages: [] })),
  emitToolExecutionAuditEvents: vi.fn(),
  estimateTokenCountFromMessages: vi.fn(() => 1),
  estimateTokenCountFromText: vi.fn(() => 1),
  getTasksForSession: vi.fn(() => []),
  isWithinActiveHours: vi.fn(() => true),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  makeAuditRunId: vi.fn(() => 'heartbeat-run'),
  maybeCompactSession: vi.fn(),
  memoryService: {
    buildPromptMemoryContext: vi.fn(() => ({ promptSummary: '' })),
    getConversationHistory: vi.fn(() => []),
    getOrCreateSession: vi.fn(() => ({ message_count: 0 })),
    storeTurn: vi.fn(),
  },
  modelRequiresChatbotId: vi.fn(() => false),
  processSideEffects: vi.fn(),
  proactiveWindowLabel: vi.fn(() => 'always-on'),
  recordAuditEvent: vi.fn(),
  formatCoworkerLivenessPage: vi.fn(
    (probe: { agentId: string; state: string }) =>
      `Agent liveness ${probe.state}: ${probe.agentId}`,
  ),
  getCoworkerLivenessSummary: vi.fn(() => ({ probes: [] })),
  heartbeatEnabled: true,
  resolveAgentForRequest: vi.fn(() => ({
    agentId: 'vllm',
    model: 'vllm/mistralai/Mistral-Small-3.2-24B-Instruct-2506',
    chatbotId: '',
  })),
  resolveModelProvider: vi.fn(() => 'vllm'),
  runAgent: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('../src/agents/agent-registry.js', () => ({
  resolveAgentForRequest: mocks.resolveAgentForRequest,
}));

vi.mock('../src/agent/conversation.js', () => ({
  buildConversationContext: mocks.buildConversationContext,
}));

vi.mock('../src/agent/proactive-policy.js', () => ({
  isWithinActiveHours: mocks.isWithinActiveHours,
  proactiveWindowLabel: mocks.proactiveWindowLabel,
}));

vi.mock('../src/agent/side-effects.js', () => ({
  processSideEffects: mocks.processSideEffects,
}));

vi.mock('../src/audit/audit-events.js', () => ({
  emitToolExecutionAuditEvents: mocks.emitToolExecutionAuditEvents,
  makeAuditRunId: mocks.makeAuditRunId,
  recordAuditEvent: mocks.recordAuditEvent,
}));

vi.mock('../src/config/config.js', () => ({
  HEARTBEAT_CHANNEL: '',
  get HEARTBEAT_ENABLED() {
    return mocks.heartbeatEnabled;
  },
  HYBRIDAI_CHATBOT_ID: '',
  HYBRIDAI_ENABLE_RAG: false,
  HYBRIDAI_MODEL: 'vllm/mistralai/Mistral-Small-3.2-24B-Instruct-2506',
}));

vi.mock('../src/gateway/coworker-liveness.js', () => ({
  formatCoworkerLivenessPage: mocks.formatCoworkerLivenessPage,
  getCoworkerLivenessSummary: mocks.getCoworkerLivenessSummary,
}));

vi.mock('../src/infra/ipc.js', () => ({
  agentWorkspaceDir: mocks.agentWorkspaceDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: mocks.logger,
}));

vi.mock('../src/memory/db.js', () => ({
  getTasksForSession: mocks.getTasksForSession,
  resetSessionIfExpired: vi.fn(() => null),
}));

vi.mock('../src/memory/memory-service.js', () => ({
  memoryService: mocks.memoryService,
}));

vi.mock('../src/providers/factory.js', () => ({
  modelRequiresChatbotId: mocks.modelRequiresChatbotId,
  resolveModelProvider: mocks.resolveModelProvider,
}));

vi.mock('../src/session/session-maintenance.js', () => ({
  maybeCompactSession: mocks.maybeCompactSession,
}));

vi.mock('../src/session/session-transcripts.js', () => ({
  appendSessionTranscript: mocks.appendSessionTranscript,
}));

vi.mock('../src/session/token-efficiency.js', () => ({
  estimateTokenCountFromMessages: mocks.estimateTokenCountFromMessages,
  estimateTokenCountFromText: mocks.estimateTokenCountFromText,
}));

beforeEach(() => {
  mocks.heartbeatEnabled = true;
});

afterEach(async () => {
  try {
    const { stopHeartbeat } = await import('../src/scheduler/heartbeat.ts');
    stopHeartbeat();
  } catch {
    // Module may not have loaded in a given test.
  }
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

test.each([
  'HEARTBEAT_OK',
  'HEARTBEAT_OK.',
  'heartbeat ok',
])('suppresses delivery for %s heartbeat acknowledgements', async (resultText) => {
  vi.useFakeTimers();
  mocks.runAgent.mockResolvedValue({
    status: 'success',
    result: resultText,
    toolExecutions: [],
  });

  const { startHeartbeat, stopHeartbeat } = await import(
    '../src/scheduler/heartbeat.ts'
  );
  const onMessage = vi.fn();

  startHeartbeat('vllm', 1_000, onMessage);
  await vi.advanceTimersByTimeAsync(1_000);
  stopHeartbeat();

  expect(onMessage).not.toHaveBeenCalled();
  expect(mocks.memoryService.storeTurn).not.toHaveBeenCalled();
  expect(mocks.appendSessionTranscript).not.toHaveBeenCalled();
  expect(mocks.maybeCompactSession).not.toHaveBeenCalled();
  expect(
    mocks.recordAuditEvent.mock.calls.some(([entry]) => {
      const event = (
        entry as { event?: { type?: string; finishReason?: string } }
      ).event;
      return (
        event?.type === 'turn.end' && event.finishReason === 'heartbeat_ok'
      );
    }),
  ).toBe(true);
});

test('delivers substantive heartbeat messages', async () => {
  vi.useFakeTimers();
  mocks.runAgent.mockResolvedValue({
    status: 'success',
    result: 'Review the queued tasks today.',
    toolExecutions: [],
  });

  const { startHeartbeat, stopHeartbeat } = await import(
    '../src/scheduler/heartbeat.ts'
  );
  const onMessage = vi.fn();

  startHeartbeat('vllm', 1_000, onMessage);
  await vi.advanceTimersByTimeAsync(1_000);
  stopHeartbeat();

  expect(onMessage).toHaveBeenCalledWith('Review the queued tasks today.');
  expect(mocks.memoryService.storeTurn).toHaveBeenCalledTimes(1);
  expect(mocks.appendSessionTranscript).toHaveBeenCalledTimes(2);
  expect(mocks.maybeCompactSession).toHaveBeenCalledTimes(1);
});

test('pages red agent liveness transitions through heartbeat delivery', async () => {
  vi.useFakeTimers();
  mocks.runAgent.mockResolvedValue({
    status: 'success',
    result: 'HEARTBEAT_OK',
    toolExecutions: [],
  });
  mocks.getCoworkerLivenessSummary.mockReturnValue({
    probes: [
      {
        agentId: 'ops',
        state: 'red',
        reasonCodes: ['process_unresponsive'],
      },
    ],
  });

  const { startHeartbeat, stopHeartbeat } = await import(
    '../src/scheduler/heartbeat.ts'
  );
  const onMessage = vi.fn();

  startHeartbeat('vllm', 1_000, onMessage);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  stopHeartbeat();

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith('Agent liveness red: ops');
});

test('pages red agent liveness when heartbeat agent is disabled', async () => {
  vi.useFakeTimers();
  mocks.heartbeatEnabled = false;
  mocks.getCoworkerLivenessSummary.mockReturnValue({
    probes: [
      {
        agentId: 'ops',
        state: 'red',
        reasonCodes: ['process_unresponsive'],
      },
    ],
  });

  const { startHeartbeat, stopHeartbeat } = await import(
    '../src/scheduler/heartbeat.ts'
  );
  const onMessage = vi.fn();

  startHeartbeat('vllm', 1_000, onMessage);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  stopHeartbeat();

  expect(mocks.runAgent).not.toHaveBeenCalled();
  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith('Agent liveness red: ops');
});
