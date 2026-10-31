import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-delegation-execution-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

async function setup() {
  const home = setupHome();
  const delegation = await import('../src/gateway/gateway-delegation.js');
  const requests = await import('../src/gateway/gateway-request-runtime.js');
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('api-parent', null, 'openai', 'main');
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'child report',
    toolsUsed: [],
  });
  return { ...delegation, ...requests, ...db };
}

const effect = {
  action: 'delegate' as const,
  prompt: 'Inspect the local report.',
};

test('a waiting child uses the conversation behind its active execution session', async () => {
  const runtime = await setup();
  const request = runtime.registerActiveGatewayRequest({
    sessionId: 'api-parent',
    executionSessionId: 'api-worker',
  });
  try {
    const result = await runtime.runDelegationNow({
      sessionId: 'api-worker',
      effect,
    });
    expect(result).toEqual({ result: expect.stringContaining('child report') });
    expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionId: expect.stringMatching(/^delegate:d1:api-parent:/),
      channelId: 'openai',
      agentId: 'main',
    });
  } finally {
    request.release();
  }
});

test.each(['released', 'aborted'] as const)(
  'a %s execution alias cannot start a child',
  async (state) => {
    const runtime = await setup();
    const request = runtime.registerActiveGatewayRequest({
      sessionId: 'api-parent',
      executionSessionId: 'api-worker',
    });
    try {
      if (state === 'released') request.release();
      else runtime.abortActiveGatewayRequests('api-parent');
      const result = await runtime.runDelegationNow({
        sessionId: 'api-worker',
        effect,
      });
      expect(result).toEqual({
        error: 'Unknown delegating session.',
        status: 404,
      });
      expect(runAgentMock).not.toHaveBeenCalled();
    } finally {
      request.release();
    }
  },
);

test('a worker shared by two active conversations fails closed until its owner is unique', async () => {
  const runtime = await setup();
  runtime.getOrCreateSession('other-parent', null, 'web', 'main');
  const first = runtime.registerActiveGatewayRequest({
    sessionId: 'api-parent',
    executionSessionId: 'api-worker',
  });
  const second = runtime.registerActiveGatewayRequest({
    sessionId: 'other-parent',
    executionSessionId: 'api-worker',
  });
  try {
    expect(
      await runtime.runDelegationNow({ sessionId: 'api-worker', effect }),
    ).toEqual({ error: 'Unknown delegating session.', status: 404 });
    expect(runAgentMock).not.toHaveBeenCalled();
    second.release();
    expect(
      await runtime.runDelegationNow({ sessionId: 'api-worker', effect }),
    ).toEqual({ result: expect.stringContaining('child report') });
    expect(runAgentMock.mock.calls[0]?.[0].sessionId).toMatch(
      /^delegate:d1:api-parent:/,
    );
  } finally {
    first.release();
    second.release();
  }
});

test('an externally aborted owner does not make another live owner ambiguous', async () => {
  const runtime = await setup();
  runtime.getOrCreateSession('other-parent', null, 'web', 'main');
  const abort = new AbortController();
  const first = runtime.registerActiveGatewayRequest({
    sessionId: 'api-parent',
    executionSessionId: 'api-worker',
    abortSignal: abort.signal,
  });
  const second = runtime.registerActiveGatewayRequest({
    sessionId: 'other-parent',
    executionSessionId: 'api-worker',
  });
  try {
    abort.abort();
    expect(
      await runtime.runDelegationNow({ sessionId: 'api-worker', effect }),
    ).toEqual({ result: expect.stringContaining('child report') });
    expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionId: expect.stringMatching(/^delegate:d1:other-parent:/),
      channelId: 'web',
    });
  } finally {
    first.release();
    second.release();
  }
});

test('two active requests for one conversation keep the same delegation owner', async () => {
  const runtime = await setup();
  const first = runtime.registerActiveGatewayRequest({
    sessionId: 'api-parent',
    executionSessionId: 'api-worker',
  });
  const second = runtime.registerActiveGatewayRequest({
    sessionId: 'api-parent',
    executionSessionId: 'api-worker',
  });
  try {
    first.release();
    expect(
      await runtime.runDelegationNow({ sessionId: 'api-worker', effect }),
    ).toEqual({ result: expect.stringContaining('child report') });
    second.release();
    expect(
      await runtime.runDelegationNow({ sessionId: 'api-worker', effect }),
    ).toEqual({ error: 'Unknown delegating session.', status: 404 });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  } finally {
    first.release();
    second.release();
  }
});

test.each([false, true])(
  'the resolved owner keeps scope isolation (deleted: %s)',
  async (deleted) => {
    const runtime = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const { createScope, deleteScopeRow } = await import(
      '../src/scopes/scope-store.js'
    );
    const { setSessionScopeOnce } = await import('../src/memory/sessions.js');
    const scope = createScope({
      agentId: 'main',
      name: 'Project',
      connectors: [],
    });
    setSessionScopeOnce('api-parent', scope.id);
    if (deleted) deleteScopeRow('main', scope.id);
    const request = runtime.registerActiveGatewayRequest({
      sessionId: 'api-parent',
      executionSessionId: 'api-worker',
    });
    try {
      const result = await runtime.runDelegationNow({
        sessionId: 'api-worker',
        effect,
      });
      if (deleted) {
        expect(result).toEqual({
          result: expect.stringContaining('status: failed'),
        });
        expect(runAgentMock).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({
          result: expect.stringContaining('child report'),
        });
        expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
          runtimeScope: { agentId: 'main', scopeId: scope.id },
          workspacePathOverride: expect.stringContaining(`/scopes/${scope.id}`),
          blockedTools: expect.arrayContaining(['hybridai__*__*']),
        });
      }
    } finally {
      request.release();
    }
  },
);
