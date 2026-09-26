import fs from 'node:fs';
import path from 'node:path';

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
  tempHomePrefix: 'hybridclaw-gateway-interrupted-delegations-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

interface RunAgentParams {
  sessionId: string;
  messages: ChatMessage[];
  abortSignal?: AbortSignal;
  onToolProgress?: (event: ToolProgressEvent) => void;
}

const DELEGATE_PROMPT = 'Summarize the release notes.';
// What the container's `delegate` tool answers once it has queued the work.
const DELEGATE_ACCEPTED = `Delegation accepted (single; gateway will collect results for final synthesis, do not poll): ${DELEGATE_PROMPT}`;
// The output the runners return once a request is aborted.
const INTERRUPTED_OUTPUT = {
  status: 'error',
  result: null,
  toolsUsed: [],
  error: 'Interrupted by user.',
};
const QUEUED_DELEGATION = {
  action: 'delegate',
  mode: 'single',
  prompt: DELEGATE_PROMPT,
};
const TOOL_HISTORY: ChatMessage[] = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'delegate-accepted',
        type: 'function',
        function: {
          name: 'delegate',
          arguments: JSON.stringify({ prompt: DELEGATE_PROMPT }),
        },
      },
      {
        id: 'delegate-failed',
        type: 'function',
        function: { name: 'delegate', arguments: '{}' },
      },
      {
        id: 'read-notes',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"notes.md"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'delegate-accepted', content: DELEGATE_ACCEPTED },
  {
    role: 'tool',
    tool_call_id: 'delegate-failed',
    content: 'Error: prompt is required for mode="single".',
    is_error: true,
  },
  { role: 'tool', tool_call_id: 'read-notes', content: 'Release notes draft' },
];

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
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { INTERRUPTED_DELEGATIONS_NOTE } = await import(
    '../src/gateway/interrupted-delegations.ts'
  );
  initDatabase({ quiet: true });
  return {
    getDelegationJob,
    getRecentMessages,
    handleGatewayCommand,
    handleGatewayMessage,
    INTERRUPTED_DELEGATIONS_NOTE,
  };
}

test('a /stop after a delegate call tells the next turn that nothing was started', async () => {
  setupHome();
  let delegateReported: () => void = () => {};
  const delegated = new Promise<void>((resolve) => {
    delegateReported = resolve;
  });
  runAgentMock
    .mockImplementationOnce(
      (params: RunAgentParams) =>
        new Promise((resolve) => {
          params.abortSignal?.addEventListener(
            'abort',
            () => resolve(INTERRUPTED_OUTPUT),
            { once: true },
          );
          reportDelegateCall(params);
          delegateReported();
        }),
    )
    .mockResolvedValueOnce({
      status: 'success',
      result: 'No summary is running.',
      toolsUsed: [],
      toolExecutions: [],
    });
  const gateway = await loadGateway();
  const request = chatRequest('session-stop-after-delegate');

  const firstTurn = gateway.handleGatewayMessage({
    ...request,
    delegationPublicId: 'dlg_stopped',
  });
  await delegated;
  await gateway.handleGatewayCommand({
    sessionId: request.sessionId,
    guildId: null,
    channelId: request.channelId,
    userId: request.userId,
    username: request.username,
    args: ['stop'],
  });

  expect(await firstTurn).toMatchObject({
    status: 'error',
    error: 'Interrupted by user.',
  });
  expect(gateway.getDelegationJob('dlg_stopped')).toBeNull();

  await gateway.handleGatewayMessage({
    ...request,
    content: 'Is the summary ready?',
  });
  const nextTurn = runAgentMock.mock.calls[1]?.[0] as RunAgentParams;
  const placeholder = nextTurn.messages.find(
    (message) =>
      message.role === 'assistant' &&
      String(message.content).includes('Interrupted by user.'),
  );
  expect(placeholder?.content).toContain('- delegate: completed');
  expect(placeholder?.content).toContain(gateway.INTERRUPTED_DELEGATIONS_NOTE);
});

test('an interrupted turn drops the delegations its shutdown output carries and corrects replayed delegate results', async () => {
  setupHome();
  const requester = new AbortController();
  runAgentMock
    .mockImplementationOnce(async (params: RunAgentParams) => {
      reportDelegateCall(params);
      // The requester goes away, e.g. a closed client connection.
      requester.abort();
      // A runner that surfaced the agent's shutdown output would hand back the
      // queued delegation and the tool calls that already ran.
      return {
        ...INTERRUPTED_OUTPUT,
        toolHistory: TOOL_HISTORY,
        toolHistoryForReplay: TOOL_HISTORY,
        sideEffects: { delegations: [QUEUED_DELEGATION] },
      };
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: 'No summary is running.',
      toolsUsed: [],
      toolExecutions: [],
    });
  const gateway = await loadGateway();
  const request = chatRequest('session-interrupted-replay');

  const first = await gateway.handleGatewayMessage({
    ...request,
    abortSignal: requester.signal,
    delegationPublicId: 'dlg_dropped',
  });

  expect(first.status).toBe('error');
  expect(gateway.getDelegationJob('dlg_dropped')).toBeNull();
  const corrected = {
    role: 'tool',
    tool_call_id: 'delegate-accepted',
    content: expect.stringContaining(gateway.INTERRUPTED_DELEGATIONS_NOTE),
    is_error: true,
  };
  const unchanged = TOOL_HISTORY.slice(2);

  await gateway.handleGatewayMessage({
    ...request,
    content: 'Is the summary ready?',
  });
  const nextTurn = runAgentMock.mock.calls[1]?.[0] as RunAgentParams;
  const replayed = nextTurn.messages.filter(
    (message) => message.role === 'tool',
  );
  expect(replayed).toEqual([corrected, ...unchanged]);
  expect(replayed[0]?.content).toContain(DELEGATE_ACCEPTED);

  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { sessionTranscriptFilename } = await import(
    '../container/shared/tool-history.js'
  );
  const transcriptRows = fs
    .readFileSync(
      path.join(
        agentWorkspaceDir('main'),
        '.session-transcripts',
        sessionTranscriptFilename(request.sessionId),
      ),
      'utf-8',
    )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(
    transcriptRows.find((row) => row.tool_call_id === 'delegate-accepted')
      ?.content,
  ).toContain(gateway.INTERRUPTED_DELEGATIONS_NOTE);
});

test('an agent error without an interrupt still starts its delegations', async () => {
  setupHome();
  runAgentMock
    .mockResolvedValueOnce({
      status: 'error',
      result: null,
      toolsUsed: ['delegate'],
      toolExecutions: [
        {
          name: 'delegate',
          arguments: JSON.stringify({ prompt: DELEGATE_PROMPT }),
          result: DELEGATE_ACCEPTED,
          durationMs: 1,
        },
      ],
      toolHistory: TOOL_HISTORY,
      toolHistoryForReplay: TOOL_HISTORY,
      error: 'Model request failed: HTTP 502',
      sideEffects: { delegations: [QUEUED_DELEGATION] },
    })
    // The delegate run and its synthesis.
    .mockResolvedValue({
      status: 'success',
      result: 'Release notes summarized.',
      toolsUsed: [],
      toolExecutions: [],
    });
  const gateway = await loadGateway();
  const request = chatRequest('session-error-still-delegates');

  const first = await gateway.handleGatewayMessage({
    ...request,
    delegationPublicId: 'dlg_started',
  });

  expect(first.status).toBe('error');
  expect(gateway.getDelegationJob('dlg_started')).not.toBeNull();
  const stored = gateway
    .getRecentMessages(request.sessionId)
    .find((message) => message.role === 'assistant');
  expect(stored?.content).toContain('Delegations were still started:');
  expect(stored?.content).not.toContain(gateway.INTERRUPTED_DELEGATIONS_NOTE);
  expect(JSON.parse(stored?.tool_history_json || '[]')).toEqual(TOOL_HISTORY);
  await vi.waitFor(() =>
    expect(['queued', 'in_progress']).not.toContain(
      gateway.getDelegationJob('dlg_started')?.status,
    ),
  );
});

test.each([
  ['an accepted', [{ name: 'delegate', outcome: 'completed' }], true],
  [
    'a cut-off',
    [{ name: 'delegate', outcome: 'started, outcome unknown' }],
    true,
  ],
  ['a failed', [{ name: 'delegate', outcome: 'failed' }], false],
  ['a blocked', [{ name: 'delegate', outcome: 'blocked' }], false],
  ['no', [{ name: 'read', outcome: 'completed' }], false],
] as const)('%s delegate call decides the interrupted-turn note', async (_label, tools, noted) => {
  const { INTERRUPTED_DELEGATIONS_NOTE, interruptedDelegationsNote } =
    await import('../src/gateway/interrupted-delegations.ts');

  expect(interruptedDelegationsNote(tools)).toBe(
    noted ? INTERRUPTED_DELEGATIONS_NOTE : null,
  );
});
