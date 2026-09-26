import { expect, test, vi } from 'vitest';
import type { ChatMessage } from '../src/types/api.js';
import type { ToolProgressEvent } from '../src/types/execution.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-routed-error-turn-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

interface RunAgentParams {
  sessionId: string;
  model: string;
  messages: ChatMessage[];
  onToolProgress?: (event: ToolProgressEvent) => void;
}

const CHEAP_MODEL = 'lmstudio/test-cheap';
const STRONG_MODEL = 'lmstudio/test-strong';

function reportDelegateCall(params: RunAgentParams): void {
  params.onToolProgress?.({
    sessionId: params.sessionId,
    toolName: 'delegate',
    phase: 'start',
    preview: '{"prompt":"Summarize the release notes."}',
  });
  params.onToolProgress?.({
    sessionId: params.sessionId,
    toolName: 'delegate',
    phase: 'finish',
    durationMs: 1,
    preview: 'Delegation accepted (single): Summarize the release notes.',
  });
}

function chatRequest(sessionId: string, content: string) {
  // No pinned model, so the turn runs on the routing ladder.
  return {
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'alice',
    content,
    chatbotId: 'bot-1',
  };
}

async function loadRoutedGateway() {
  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.local.backends.lmstudio.enabled = true;
    draft.routing.enabled = true;
    draft.routing.defaultStart = 'economy';
    draft.routing.tiers = [
      { name: 'economy', models: [CHEAP_MODEL] },
      { name: 'general', models: [STRONG_MODEL] },
    ];
    draft.auxiliaryModels.session_title.provider = 'disabled';
  });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { INTERRUPTED_DELEGATIONS_NOTE } = await import(
    '../src/gateway/interrupted-delegations.ts'
  );
  return { handleGatewayMessage, INTERRUPTED_DELEGATIONS_NOTE };
}

test.each([
  ['throws a runner error', 'throw', 'container exited unexpectedly'],
  ['throws a provider error', 'throw', 'Provider returned HTTP 503'],
  // The runner's crash output has no executions, and the `(532ms)` in its
  // stderr tail classifies as an HTTP 5xx.
  [
    'crashes',
    'return',
    'Container exited before producing output (exit code 1). [tool] delegate result (532ms): Delegation accepted',
  ],
] as const)('a routed attempt that ran a tool and %s is final and tells the next turn what ran', async (_label, failure, error) => {
  setupHome();
  runAgentMock
    .mockImplementationOnce(async (params: RunAgentParams) => {
      reportDelegateCall(params);
      if (failure === 'throw') throw new Error(error);
      return { status: 'error', result: null, toolsUsed: [], error };
    })
    .mockResolvedValue({
      status: 'success',
      result: 'No summary is running.',
      toolsUsed: [],
      toolExecutions: [],
    });
  const gateway = await loadRoutedGateway();
  const sessionId = 'session-routed-error-turn';

  const first = await gateway.handleGatewayMessage(
    chatRequest(sessionId, 'Delegate a summary of the release notes.'),
  );
  expect(first.status).toBe('error');
  // Retrying on another rung would run the tool a second time.
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  await gateway.handleGatewayMessage(
    chatRequest(sessionId, 'Is the summary ready?'),
  );
  const nextTurn = runAgentMock.mock.calls[1]?.[0] as RunAgentParams;
  expect(nextTurn.model).toBe(CHEAP_MODEL);
  const placeholder = nextTurn.messages.find(
    (message) =>
      message.role === 'assistant' && String(message.content).includes(error),
  );
  expect(placeholder?.content).toContain('- delegate: completed');
  // A failed attempt never hands its queued delegations to the gateway.
  expect(placeholder?.content).toContain(gateway.INTERRUPTED_DELEGATIONS_NOTE);
});
