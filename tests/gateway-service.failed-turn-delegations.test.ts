import { expect, test, vi } from 'vitest';
import type { ChatMessage } from '../src/types/api.js';
import type { ContainerOutput } from '../src/types/container.js';
import type { ToolProgressEvent } from '../src/types/execution.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-failed-turn-delegations-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

interface RunAgentParams {
  sessionId: string;
  messages: ChatMessage[];
  onToolProgress?: (event: ToolProgressEvent) => void;
}

const DELEGATE_PROMPT = 'Summarize the release notes.';
// What the container's `delegate` tool answers once it has queued the work.
const DELEGATE_ACCEPTED = `Delegation accepted (single; gateway will collect results for final synthesis, do not poll): ${DELEGATE_PROMPT}`;

function reportDelegateCall(params: RunAgentParams): void {
  params.onToolProgress?.({
    sessionId: params.sessionId,
    toolName: 'delegate',
    phase: 'start',
    preview: JSON.stringify({ prompt: DELEGATE_PROMPT }),
  });
  params.onToolProgress?.({
    sessionId: params.sessionId,
    toolName: 'delegate',
    phase: 'finish',
    durationMs: 1,
    preview: DELEGATE_ACCEPTED,
  });
}

// What a runner returns when the agent's own output never arrives: the IPC
// reader's timeout or dead-process error, without the agent's side effects.
async function readMissingOutput(
  sessionId: string,
  terminalError: string | null,
): Promise<ContainerOutput> {
  const { readOutput } = await import('../src/infra/ipc.ts');
  return readOutput(sessionId, 20, { terminalError: () => terminalError });
}

function chatRequest(sessionId: string) {
  return {
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'alice',
    content: 'Delegate a summary of the release notes.',
    model: 'test-model',
    chatbotId: 'bot-1',
  };
}

async function loadGateway() {
  const { getRecentMessages, initDatabase } = await import(
    '../src/memory/db.ts'
  );
  const { getDelegationJob } = await import(
    '../src/memory/delegation-jobs.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { INTERRUPTED_DELEGATIONS_NOTE } = await import(
    '../src/gateway/interrupted-delegations.ts'
  );
  initDatabase({ quiet: true });
  return {
    getDelegationJob,
    getRecentMessages,
    handleGatewayMessage,
    memoryService,
    INTERRUPTED_DELEGATIONS_NOTE,
  };
}

test.each<[string, (sessionId: string) => Promise<ContainerOutput>]>([
  [
    'timed out waiting for the agent',
    (sessionId) => readMissingOutput(sessionId, null),
  ],
  [
    'lost its agent process',
    (sessionId) =>
      readMissingOutput(
        sessionId,
        'Host agent process exited with code 137 before producing output.',
      ),
  ],
  [
    'crashed inside the agent',
    // The container's `main().catch` output, written before it exits.
    async () => ({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'Unhandled error: Cannot read properties of undefined',
    }),
  ],
  [
    'threw in the runner',
    async () => {
      throw new Error('Agent runner failed: write EPIPE');
    },
  ],
  [
    'had its delegation refused',
    // Single mode without a prompt: the gateway starts nothing.
    async () => ({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'Model request failed: HTTP 502',
      sideEffects: { delegations: [{ action: 'delegate', mode: 'single' }] },
    }),
  ],
])('an error turn that %s tells the next turn its delegation never started', async (label, endTurn) => {
  setupHome();
  runAgentMock
    .mockImplementationOnce(async (params: RunAgentParams) => {
      reportDelegateCall(params);
      return endTurn(params.sessionId);
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: 'No summary is running.',
      toolsUsed: [],
      toolExecutions: [],
    });
  const gateway = await loadGateway();
  const request = chatRequest(`session-${label.replaceAll(' ', '-')}`);

  const first = await gateway.handleGatewayMessage({
    ...request,
    delegationPublicId: 'dlg_never_started',
  });

  expect(first.status).toBe('error');
  expect(gateway.getDelegationJob('dlg_never_started')).toBeNull();

  await gateway.handleGatewayMessage({
    ...request,
    content: 'Is the summary ready?',
  });
  const nextTurn = runAgentMock.mock.calls[1]?.[0] as RunAgentParams;
  const placeholder = nextTurn.messages.find(
    (message) =>
      message.role === 'assistant' &&
      String(message.content).includes(String(first.error)),
  );
  expect(placeholder?.content).toContain('- delegate: completed');
  expect(placeholder?.content).toContain(gateway.INTERRUPTED_DELEGATIONS_NOTE);
});

test('a turn that throws after starting its delegation keeps saying it started', async () => {
  setupHome();
  runAgentMock
    .mockImplementationOnce(async (params: RunAgentParams) => {
      reportDelegateCall(params);
      return {
        status: 'success',
        result: 'Delegated the summary.',
        toolsUsed: ['delegate'],
        toolExecutions: [],
        sideEffects: {
          delegations: [
            { action: 'delegate', mode: 'single', prompt: DELEGATE_PROMPT },
          ],
        },
      };
    })
    // The delegate run and its synthesis.
    .mockResolvedValue({
      status: 'success',
      result: 'Release notes summarized.',
      toolsUsed: [],
      toolExecutions: [],
    });
  const gateway = await loadGateway();
  const request = chatRequest('session-throw-after-delegating');
  // Storing the reply fails once, after the delegation was enqueued.
  const storeTurn = gateway.memoryService.storeTurn.bind(gateway.memoryService);
  let failedStore = false;
  vi.spyOn(gateway.memoryService, 'storeTurn').mockImplementation((params) => {
    if (!failedStore && params.sessionId === request.sessionId) {
      failedStore = true;
      throw new Error('database is locked');
    }
    return storeTurn(params);
  });

  const first = await gateway.handleGatewayMessage({
    ...request,
    delegationPublicId: 'dlg_started_then_threw',
  });

  expect(first).toMatchObject({ status: 'error', error: 'database is locked' });
  const job = gateway.getDelegationJob('dlg_started_then_threw');
  expect(job?.ack_text).toBeTruthy();
  const stored = gateway
    .getRecentMessages(request.sessionId)
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.content.includes('database is locked'),
    );
  expect(stored?.content).toContain('- delegate: completed');
  expect(stored?.content).toContain(job?.ack_text);
  expect(stored?.content).not.toContain(gateway.INTERRUPTED_DELEGATIONS_NOTE);
  await vi.waitFor(() =>
    expect(['queued', 'in_progress']).not.toContain(
      gateway.getDelegationJob('dlg_started_then_threw')?.status,
    ),
  );
});
