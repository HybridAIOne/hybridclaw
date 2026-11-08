import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, enqueueMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  enqueueMock: vi.fn(),
}));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/infra/host-runner.js', () => ({ stopSessionHostProcess: vi.fn() }));
vi.mock('../src/agent/delegation-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/delegation-manager.js')>()),
  enqueueDelegation: enqueueMock,
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-delegated-workspace-',
  cleanup: () => {
    runAgentMock.mockReset();
    enqueueMock.mockReset();
    vi.unstubAllEnvs();
  },
});
const success = { status: 'success', result: 'child report', toolsUsed: [] };
const effect = { action: 'delegate' as const, prompt: 'Inspect the local report.' };

async function setup() {
  const home = setupHome();
  const delegation = await import('../src/gateway/gateway-delegation.js');
  const requests = await import('../src/gateway/gateway-request-runtime.js');
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'openai', 'main');
  runAgentMock.mockResolvedValue(success);
  enqueueMock.mockReturnValue(true);
  const workspace = {
    workspacePathOverride: path.join(home, 'task'),
    workspaceDisplayRootOverride: '/task',
  };
  const request = requests.registerActiveGatewayRequest({
    sessionId: 'parent',
    executionSessionId: 'worker',
    workspaceOverrides: workspace,
  });
  return { ...delegation, ...requests, ...db, home, workspace, request };
}

test.each(['single', 'parallel', 'chain'] as const)(
  '%s children inherit only the trusted execution workspace',
  async (mode) => {
    const runtime = await setup();
    try {
      const result = await runtime.runDelegationNow({
        sessionId: 'worker',
        effect: { ...effect, mode, [mode === 'chain' ? 'chain' : 'tasks']: [{ prompt: 'First' }, { prompt: 'Second' }] },
      });
      expect(result).toHaveProperty('result');
      expect(runAgentMock).toHaveBeenCalled();
      for (const [call] of runAgentMock.mock.calls) {
        expect(call).toMatchObject(runtime.workspace);
        expect(call.runtimeScope).toBeUndefined();
      }
    } finally { runtime.request.release(); }
  },
);

test('nested children keep their parent root until the child finishes', async () => {
  const runtime = await setup();
  let childId = '';
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    expect(params).toMatchObject(runtime.workspace);
    if (params.sessionId.startsWith('delegate:d1:')) {
      childId = params.sessionId;
      await runtime.runDelegationNow({ sessionId: childId, effect });
    }
    return success;
  });
  try {
    await runtime.runDelegationNow({ sessionId: 'worker', effect });
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(await runtime.runDelegationNow({ sessionId: childId, effect }))
      .toEqual({ error: 'Unknown delegating session.', status: 404 });
  } finally { runtime.request.release(); }
});

test.each(['workspacePathOverride', 'workspaceDisplayRootOverride'] as const)(
  'conflicting %s values on the same active worker fail closed', async (field) => {
    const runtime = await setup();
    const conflicting = runtime.registerActiveGatewayRequest({
      sessionId: 'parent', executionSessionId: 'worker',
      workspaceOverrides: { ...runtime.workspace, [field]: '/other' },
    });
    try {
      expect(await runtime.runDelegationNow({ sessionId: 'worker', effect }))
        .toEqual({ error: 'Unknown delegating session.', status: 404 });
      expect(runAgentMock).not.toHaveBeenCalled();
      conflicting.release();
      await runtime.runDelegationNow({ sessionId: 'worker', effect });
      expect(runAgentMock.mock.calls[0][0]).toMatchObject(runtime.workspace);
    } finally { conflicting.release(); runtime.request.release(); }
  },
);

test('ordinary sessions ignore eval environment and tool-supplied roots', async () => {
  const runtime = await setup();
  runtime.request.release();
  vi.stubEnv('HYBRIDCLAW_EVAL_WORKSPACE_ROOT', '/unrelated');
  await runtime.runDelegationNow({
    sessionId: 'parent', effect: { ...effect, workspacePathOverride: '/untrusted' } as typeof effect,
  });
  expect(runAgentMock.mock.calls[0][0].workspacePathOverride).toBeUndefined();
  expect(runAgentMock.mock.calls[0][0].workspaceDisplayRootOverride).toBeUndefined();
});

test('concurrent parents on one agent keep separate task roots', async () => {
  const runtime = await setup();
  runtime.getOrCreateSession('other-parent', null, 'openai', 'main');
  const otherRoot = path.join(runtime.home, 'other-task');
  const other = runtime.registerActiveGatewayRequest({
    sessionId: 'other-parent', executionSessionId: 'other-worker',
    workspaceOverrides: { workspacePathOverride: otherRoot },
  });
  try {
    await Promise.all(['worker', 'other-worker'].map(sessionId => runtime.runDelegationNow({ sessionId, effect })));
    expect(runAgentMock.mock.calls.map(([p]) => p.workspacePathOverride).sort())
      .toEqual([runtime.workspace.workspacePathOverride, otherRoot].sort());
  } finally { other.release(); runtime.request.release(); }
});

test.each([false, true])('scope selection stays authoritative (deleted: %s)', async deleted => {
  const runtime = await setup();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const { createScope, deleteScopeRow } = await import('../src/scopes/scope-store.js');
  const { setSessionScopeOnce } = await import('../src/memory/sessions.js');
  const scope = createScope({ agentId: 'main', name: 'Project', connectors: [] });
  setSessionScopeOnce('parent', scope.id);
  if (deleted) deleteScopeRow('main', scope.id);
  try {
    await runtime.runDelegationNow({ sessionId: 'worker', effect });
    if (deleted) expect(runAgentMock).not.toHaveBeenCalled();
    else {
      const call = runAgentMock.mock.calls[0][0];
      expect(call.workspacePathOverride).toContain(`/scopes/${scope.id}`);
      expect(call.workspaceDisplayRootOverride).toBeUndefined();
      expect(call.runtimeScope).toEqual({ agentId: 'main', scopeId: scope.id });
      expect(call.blockedTools).toContain('hybridai__*__*');
    }
  } finally { runtime.request.release(); }
});

test('queued children retain the trusted root after the parent request releases', async () => {
  const runtime = await setup();
  const runParentTurn = vi.fn(async () => success);
  runtime.enqueueDelegationBatchFromSideEffects({
    parentSessionId: 'parent', channelId: 'openai', chatbotId: '', enableRag: false,
    agentId: 'main', parentDepth: 0, runParentTurn,
    workspaceOverrides: runtime.workspace,
    plans: [{ mode: 'single', tasks: [{ prompt: 'Inspect report', model: 'openrouter/example/model' }] }],
  });
  runtime.request.release();
  expect(enqueueMock).toHaveBeenCalledOnce();
  await enqueueMock.mock.calls[0][0].run();
  expect(runAgentMock.mock.calls[0][0]).toMatchObject(runtime.workspace);
  expect(runParentTurn).toHaveBeenCalledOnce();
});
