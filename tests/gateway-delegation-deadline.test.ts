import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, enqueueMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  enqueueMock: vi.fn(),
}));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
}));
vi.mock('../src/agent/delegation-manager.js', async (original) => ({
  ...(await original<typeof import('../src/agent/delegation-manager.js')>()),
  enqueueDelegation: enqueueMock,
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'delegation-deadline-',
  cleanup: () => {
    runAgentMock.mockReset();
    enqueueMock.mockReset();
  },
});
const success = {
  status: 'success',
  result: 'Synthetic report.',
  toolsUsed: [],
};
const effect = {
  action: 'delegate' as const,
  prompt: 'Inspect synthetic notes.',
};
async function setup() {
  const home = setupHome();
  const delegation = await import('../src/gateway/gateway-delegation.js');
  const requests = await import('../src/gateway/gateway-request-runtime.js');
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'openai', 'main');
  runAgentMock.mockResolvedValue(success);
  enqueueMock.mockReturnValue(true);
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  updateRuntimeConfig((draft) => {
    draft.proactive.autoRetry.baseDelayMs = 100;
    draft.proactive.autoRetry.maxDelayMs = 100;
  });
  return { ...delegation, ...requests };
}

test('nested and sibling delegates inherit the trusted deadline despite model-supplied extensions', async () => {
  const runtime = await setup();
  const deadline = Date.now() + 60_000;
  const owner = runtime.registerActiveGatewayRequest({
    sessionId: 'parent',
    executionSessionId: 'root-worker',
    executionDeadlineAtMs: deadline,
  });
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    if (params.sessionId.startsWith('delegate:d1:'))
      await runtime.runDelegationNow({ sessionId: params.sessionId, effect });
    return success;
  });
  try {
    for (let i = 0; i < 2; i++)
      await runtime.runDelegationNow({
        sessionId: 'root-worker',
        effect: {
          ...effect,
          executionDeadlineAtMs: deadline + 600_000,
        } as typeof effect,
      });
    expect(runAgentMock).toHaveBeenCalledTimes(4);
    for (const [params] of runAgentMock.mock.calls)
      expect(params.executionDeadlineAtMs).toBe(deadline);
  } finally {
    owner.release();
  }
});

test.each(['active', 'expired'] as const)(
  'queued %s children and parent wakeups retain the original deadline after release',
  async (state) => {
    const runtime = await setup();
    const deadline = Date.now() + (state === 'active' ? 60_000 : -1);
    const parent = vi.fn(
      async (_params: { content: string; executionDeadlineAtMs?: number }) =>
        success,
    );
    const owner = runtime.registerActiveGatewayRequest({
      sessionId: 'parent',
      executionDeadlineAtMs: deadline,
    });
    runtime.enqueueDelegationBatchFromSideEffects({
      parentSessionId: 'parent',
      channelId: 'openai',
      chatbotId: '',
      enableRag: false,
      agentId: 'main',
      parentDepth: 0,
      executionDeadlineAtMs: deadline,
      runParentTurn: parent,
      plans: [
        {
          mode: 'single',
          tasks: [{ prompt: 'Read synthetic notes.', model: 'test-model' }],
        },
      ],
    });
    owner.release();
    await enqueueMock.mock.calls[0][0].run();
    expect(runAgentMock).toHaveBeenCalledTimes(state === 'active' ? 1 : 0);
    if (state === 'active')
      expect(runAgentMock.mock.calls[0][0].executionDeadlineAtMs).toBe(
        deadline,
      );
    expect(parent).toHaveBeenCalledOnce();
    expect(parent.mock.calls[0][0].executionDeadlineAtMs).toBe(deadline);
  },
);

test.each(['retry', 'expires'] as const)(
  'a transient child %s keeps its bound and cannot buy another lease',
  async (mode) => {
    const runtime = await setup();
    const deadline = Date.now() + 60_000;
    const owner = runtime.registerActiveGatewayRequest({
      sessionId: 'parent',
      executionSessionId: 'worker',
      executionDeadlineAtMs: deadline,
    });
    runAgentMock
      .mockImplementationOnce(async () => {
        if (mode === 'expires')
          vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
        return {
          status: 'error',
          result: null,
          toolsUsed: [],
          error: 'fetch failed',
        };
      })
      .mockResolvedValue(success);
    try {
      await runtime.runDelegationNow({ sessionId: 'worker', effect });
      expect(runAgentMock).toHaveBeenCalledTimes(mode === 'retry' ? 2 : 1);
      for (const [params] of runAgentMock.mock.calls)
        expect(params.executionDeadlineAtMs).toBe(deadline);
    } finally {
      owner.release();
    }
  },
);

test.each(['waiting', 'queued'] as const)(
  'the chat entrypoint carries the bound through a %s delegation',
  async (mode) => {
    const runtime = await setup();
    const { handleGatewayMessage } = await import(
      '../src/gateway/gateway-chat-service.js'
    );
    const deadline = Date.now() + 60_000;
    let parents = 0;
    runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
      if (params.sessionId.startsWith('delegate:')) return success;
      if (parents++ === 0) {
        if (mode === 'waiting')
          await runtime.runDelegationNow({
            sessionId: params.sessionId,
            effect,
          });
        else return { ...success, sideEffects: { delegations: [effect] } };
      }
      return success;
    });
    await handleGatewayMessage({
      sessionId: 'parent',
      executionSessionId: 'worker',
      executionDeadlineAtMs: deadline,
      guildId: null,
      channelId: 'openai',
      userId: 'user_a',
      username: 'pat',
      content: 'Read synthetic notes.',
      model: 'test-model',
      chatbotId: '',
    });
    if (mode === 'queued') await enqueueMock.mock.calls[0][0].run();
    expect(
      runAgentMock.mock.calls.filter(([params]) =>
        params.sessionId.startsWith('delegate:'),
      ),
    ).toHaveLength(1);
    for (const [params] of runAgentMock.mock.calls)
      expect(params.executionDeadlineAtMs).toBe(deadline);
  },
);
