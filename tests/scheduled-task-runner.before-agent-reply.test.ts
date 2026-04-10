import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const pluginManager = {
    runBeforeAgentReply: vi.fn(async () => undefined),
  };
  return {
    agentWorkspaceDir: vi.fn(() => '/tmp/hybridclaw-scheduled-task-workspace'),
    buildConversationContext: vi.fn(() => ({ messages: [] })),
    emitToolExecutionAuditEvents: vi.fn(),
    getChannel: vi.fn(() => ({
      kind: 'scheduler',
      id: 'scheduler',
      capabilities: {},
    })),
    makeAuditRunId: vi.fn(() => 'cron-run'),
    pluginManager,
    recordAuditEvent: vi.fn(),
    recordUsageEvent: vi.fn(),
    resolveModelProvider: vi.fn(() => 'test-provider'),
    runAgent: vi.fn(),
    tryEnsurePluginManagerInitializedForGateway: vi.fn(async () => ({
      pluginManager,
      pluginInitError: null,
    })),
  };
});

vi.mock('../src/agent/agent.js', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('../src/agent/conversation.js', () => ({
  buildConversationContext: mocks.buildConversationContext,
}));

vi.mock('../src/audit/audit-events.js', () => ({
  emitToolExecutionAuditEvents: mocks.emitToolExecutionAuditEvents,
  makeAuditRunId: mocks.makeAuditRunId,
  recordAuditEvent: mocks.recordAuditEvent,
}));

vi.mock('../src/channels/channel-registry.js', () => ({
  getChannel: mocks.getChannel,
}));

vi.mock('../src/gateway/gateway-plugin-runtime.js', () => ({
  tryEnsurePluginManagerInitializedForGateway:
    mocks.tryEnsurePluginManagerInitializedForGateway,
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

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

test('scheduled-task plugins can return a synthetic reply without running the agent', async () => {
  mocks.pluginManager.runBeforeAgentReply.mockResolvedValueOnce({
    handled: true,
    text: 'Synthetic scheduled reply',
    pluginId: 'scheduler-plugin',
  });

  const { runIsolatedScheduledTask } = await import(
    '../src/scheduler/scheduled-task-runner.ts'
  );
  const onResult = vi.fn();
  const onError = vi.fn();

  await runIsolatedScheduledTask({
    taskId: 42,
    prompt: 'Perform scheduled maintenance.',
    channelId: 'ops',
    chatbotId: 'bot-1',
    model: 'test-model',
    agentId: 'main',
    onResult,
    onError,
  });

  expect(mocks.pluginManager.runBeforeAgentReply).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'agent:main:channel:scheduler:chat:cron:peer:42',
      channelId: 'ops',
      trigger: 'scheduler',
      prompt: 'Perform scheduled maintenance.',
    }),
  );
  expect(mocks.runAgent).not.toHaveBeenCalled();
  expect(onResult).toHaveBeenCalledWith({ text: 'Synthetic scheduled reply' });
  expect(onError).not.toHaveBeenCalled();
});

test('scheduled-task plugins can swallow a run silently', async () => {
  mocks.pluginManager.runBeforeAgentReply.mockResolvedValueOnce({
    handled: true,
    pluginId: 'scheduler-plugin',
  });

  const { runIsolatedScheduledTask } = await import(
    '../src/scheduler/scheduled-task-runner.ts'
  );
  const onResult = vi.fn();
  const onError = vi.fn();

  await runIsolatedScheduledTask({
    taskId: 43,
    prompt: 'Perform scheduled maintenance.',
    channelId: 'ops',
    chatbotId: 'bot-1',
    model: 'test-model',
    agentId: 'main',
    onResult,
    onError,
  });

  expect(mocks.runAgent).not.toHaveBeenCalled();
  expect(onResult).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(
    mocks.recordAuditEvent.mock.calls.some(([entry]) => {
      const event = (
        entry as { event?: { type?: string; finishReason?: string } }
      ).event;
      return (
        event?.type === 'turn.end' && event.finishReason === 'plugin_silent'
      );
    }),
  ).toBe(true);
});
