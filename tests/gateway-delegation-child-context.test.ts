import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-child-context-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

async function setup() {
  const home = setupHome();
  const runtime = await import('../src/gateway/gateway-delegation.js');
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'web', 'main');
  return runtime;
}

const success = { status: 'success', result: 'report', toolsUsed: [] };
const effect = { action: 'delegate' as const, prompt: 'Inspect the report.' };

test('parallel children keep their own model when delegating again', async () => {
  const { runDelegationNow } = await setup();
  const expected = new Map<string, string>();
  runAgentMock.mockImplementation(
    async (params: { sessionId: string; model: string }) => {
      if (params.sessionId.startsWith('delegate:d1:')) {
        expected.set(params.sessionId, params.model);
        await runDelegationNow({ sessionId: params.sessionId, effect });
      }
      return success;
    },
  );
  await runDelegationNow({
    sessionId: 'parent',
    effect: {
      action: 'delegate',
      mode: 'parallel',
      tasks: [
        { prompt: 'First report.', model: 'model-a' },
        { prompt: 'Second report.', model: 'model-b' },
      ],
    },
  });
  const childCalls = runAgentMock.mock.calls
    .map(([params]) => params)
    .filter((p) => p.sessionId.startsWith('delegate:d2:'));
  expect(childCalls.map((p) => p.model).sort()).toEqual(['model-a', 'model-b']);
  expect(expected.size).toBe(2);
});

test('a lookalike child ID cannot borrow an active child context', async () => {
  const { runDelegationNow } = await setup();
  let forged: unknown;
  runAgentMock.mockImplementation(async (params: { sessionId: string }) => {
    if (params.sessionId.startsWith('delegate:d1:')) {
      forged = await runDelegationNow({
        sessionId: `${params.sessionId}-other`,
        effect,
      });
    }
    return success;
  });
  await runDelegationNow({ sessionId: 'parent', effect });
  expect(forged).toEqual({ error: 'Unknown delegating session.', status: 404 });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
});

test.each(['success', 'throw'] as const)(
  'child context is released after %s',
  async (outcome) => {
    const { runDelegationNow } = await setup();
    let childId = '';
    runAgentMock.mockImplementation(async (params: { sessionId: string }) => {
      childId = params.sessionId;
      if (outcome === 'throw') throw new Error('Invalid request (400).');
      return success;
    });
    await runDelegationNow({ sessionId: 'parent', effect });
    expect(childId).not.toBe('');
    expect(await runDelegationNow({ sessionId: childId, effect })).toEqual({
      error: 'Unknown delegating session.',
      status: 404,
    });
  },
);

test('nested children still stop at the configured depth limit', async () => {
  const { runDelegationNow } = await setup();
  let refused: unknown;
  runAgentMock.mockImplementation(async (params: { sessionId: string }) => {
    const nested = await runDelegationNow({
      sessionId: params.sessionId,
      effect,
    });
    if (params.sessionId.startsWith('delegate:d2:')) refused = nested;
    return success;
  });
  await runDelegationNow({ sessionId: 'parent', effect });
  expect(refused).toMatchObject({ error: expect.any(String), status: 400 });
  expect(runAgentMock).toHaveBeenCalledTimes(2);
});

test('an explicit nested model still overrides the child model', async () => {
  const { runDelegationNow } = await setup();
  runAgentMock.mockImplementation(async (params: { sessionId: string }) => {
    if (params.sessionId.startsWith('delegate:d1:')) {
      await runDelegationNow({
        sessionId: params.sessionId,
        effect: { ...effect, model: 'model-explicit' },
      });
    }
    return success;
  });
  await runDelegationNow({
    sessionId: 'parent',
    effect: { ...effect, model: 'model-parent' },
  });
  expect(runAgentMock.mock.calls.map(([params]) => params.model)).toEqual([
    'model-parent',
    'model-explicit',
  ]);
});

test('a completed child cannot delegate again while its sibling is still running', async () => {
  const { runDelegationNow } = await setup();
  let finishedId = '';
  let releaseSibling!: () => void;
  const sibling = new Promise<void>((resolve) => {
    releaseSibling = resolve;
  });
  runAgentMock.mockImplementation(
    async (params: { sessionId: string; model: string }) => {
      if (params.model === 'model-finished') finishedId = params.sessionId;
      else await sibling;
      return success;
    },
  );
  const parent = runDelegationNow({
    sessionId: 'parent',
    effect: {
      action: 'delegate',
      mode: 'parallel',
      tasks: [
        { prompt: 'Short report.', model: 'model-finished' },
        { prompt: 'Long report.', model: 'model-running' },
      ],
    },
  });
  try {
    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(2));
    expect(finishedId).not.toBe('');
    expect(await runDelegationNow({ sessionId: finishedId, effect })).toEqual({
      error: 'Unknown delegating session.',
      status: 404,
    });
    expect(runAgentMock).toHaveBeenCalledTimes(2);
  } finally {
    releaseSibling();
    await parent;
  }
});
