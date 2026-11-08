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
vi.mock('../src/agent/delegation-manager.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/agent/delegation-manager.js')
  >()),
  enqueueDelegation: enqueueMock,
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'delegation-write-guard-',
  cleanup: () => {
    runAgentMock.mockReset();
    enqueueMock.mockReset();
  },
});
const success = { status: 'success', result: 'Fixture report', toolsUsed: [] };
const effect = { action: 'delegate' as const, prompt: 'Inspect a fixture.' };
const rootPrompt = 'Create release notes in report.md.';
async function setup() {
  const home = setupHome();
  const delegation = await import('../src/gateway/gateway-delegation.js');
  const requests = await import('../src/gateway/gateway-request-runtime.js');
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'openai', 'main');
  runAgentMock.mockResolvedValue(success);
  enqueueMock.mockReturnValue(true);
  return { ...delegation, ...requests, ...db };
}

test('nested and sibling children inherit the exact worker root, not tool-supplied lineage', async () => {
  const runtime = await setup();
  const request = runtime.registerActiveGatewayRequest({
    sessionId: 'parent',
    executionSessionId: 'root-worker',
  });
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    if (params.sessionId.startsWith('delegate:d1:'))
      await runtime.runDelegationNow({ sessionId: params.sessionId, effect });
    return success;
  });
  try {
    for (let index = 0; index < 2; index++)
      await runtime.runDelegationNow({
        sessionId: 'root-worker',
        fileWriteGuardUserPrompt: rootPrompt,
        effect: {
          ...effect,
          fileWriteGuardSessionId: 'untrusted',
          fileWriteGuardUserPrompt: 'Replace unrelated files.',
        } as typeof effect,
      });
    expect(runAgentMock).toHaveBeenCalledTimes(4);
    for (const [params] of runAgentMock.mock.calls) {
      expect(params.fileWriteGuardSessionId).toBe('root-worker');
      expect(params.fileWriteGuardUserPrompt).toBe(rootPrompt);
    }
  } finally {
    request.release();
  }
});

test('separate parents on one agent retain separate write guards', async () => {
  const runtime = await setup();
  runtime.getOrCreateSession('other', null, 'openai', 'main');
  const requests = ['parent', 'other'].map((sessionId) =>
    runtime.registerActiveGatewayRequest({
      sessionId,
      executionSessionId: sessionId + '-worker',
    }),
  );
  try {
    await Promise.all(
      ['parent-worker', 'other-worker'].map((sessionId) =>
        runtime.runDelegationNow({
          sessionId,
          effect,
          fileWriteGuardUserPrompt: sessionId + '-request',
        }),
      ),
    );
    expect(
      runAgentMock.mock.calls
        .map(([params]) => params.fileWriteGuardSessionId)
        .sort(),
    ).toEqual(['other-worker', 'parent-worker']);
    expect(
      runAgentMock.mock.calls
        .map(([params]) => params.fileWriteGuardUserPrompt)
        .sort(),
    ).toEqual(['other-worker-request', 'parent-worker-request']);
  } finally {
    for (const request of requests) request.release();
  }
});

test('queued children retain their trusted worker root after the parent ends', async () => {
  const runtime = await setup();
  const request = runtime.registerActiveGatewayRequest({
    sessionId: 'parent',
    executionSessionId: 'root-worker',
  });
  runtime.enqueueDelegationBatchFromSideEffects({
    parentSessionId: 'parent',
    fileWriteGuardSessionId: 'root-worker',
    channelId: 'openai',
    chatbotId: '',
    enableRag: false,
    fileWriteGuardUserPrompt: rootPrompt,
    agentId: 'main',
    parentDepth: 0,
    runParentTurn: async () => success,
    plans: [
      {
        mode: 'single',
        tasks: [
          { prompt: 'Inspect fixture.', model: 'openrouter/example/model' },
        ],
      },
    ],
  });
  request.release();
  await enqueueMock.mock.calls[0][0].run();
  expect(runAgentMock.mock.calls[0][0].fileWriteGuardSessionId).toBe(
    'root-worker',
  );
  expect(runAgentMock.mock.calls[0][0].fileWriteGuardUserPrompt).toBe(
    rootPrompt,
  );
});

test.each(['waiting', 'queued'])(
  'the chat entrypoint captures user intent for a %s delegation',
  async (mode) => {
    const runtime = await setup();
    const { handleGatewayMessage } = await import(
      '../src/gateway/gateway-chat-service.js'
    );
    let parents = 0;
    runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
      if (params.sessionId.startsWith('delegate:')) {
        return success;
      }
      if (parents++ === 0) {
        if (mode === 'waiting') {
          await runtime.runDelegationNow({
            sessionId: params.sessionId,
            effect,
            fileWriteGuardUserPrompt: rootPrompt,
          });
        } else
          return {
            ...success,
            fileWriteGuardSessionId: params.sessionId,
            fileWriteGuardUserPrompt: rootPrompt,
            sideEffects: { delegations: [effect] },
          };
      }
      return success;
    });
    await handleGatewayMessage({
      sessionId: 'parent',
      executionSessionId: 'root-worker',
      guildId: null,
      channelId: 'openai',
      userId: 'user_a',
      username: 'pat',
      content: rootPrompt,
      model: 'test-model',
      chatbotId: '',
    });
    if (mode === 'queued') await enqueueMock.mock.calls[0][0].run();
    const children = runAgentMock.mock.calls.filter(([params]) =>
      params.sessionId.startsWith('delegate:'),
    );
    expect(children).toHaveLength(1);
    expect(children[0][0].fileWriteGuardUserPrompt).toBe(rootPrompt);
  },
);
