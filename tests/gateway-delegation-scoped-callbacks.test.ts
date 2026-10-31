import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import type { RuntimeScope } from '../src/scopes/scope-runtime-auth.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-scoped-child-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});
const effect = { action: 'delegate' as const, prompt: 'Inspect the report.' };
const success = { status: 'success', result: 'report', toolsUsed: [] };

async function setup(scoped = true) {
  const home = setupHome();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'web', 'main');
  const store = await import('../src/scopes/scope-store.js');
  const { setSessionScopeOnce } = await import('../src/memory/sessions.js');
  const scope = store.createScope({
    agentId: 'main',
    name: 'Project',
    connectors: [],
  });
  if (scoped) setSessionScopeOnce('parent', scope.id);
  const runtimeScope = { agentId: 'main', scopeId: scope.id };
  const { scopedRuntimeRequestError } = await import(
    '../src/scopes/scope-runtime-auth.js'
  );
  const check = (
    sessionId: string,
    options: {
      pathname?: string;
      scope?: RuntimeScope;
      parentSessionId?: string;
    } = {},
  ) => {
    const req = Readable.from([
      Buffer.from(
        JSON.stringify({
          sessionId,
          parentSessionId: options.parentSessionId,
          effect,
        }),
      ),
    ]) as unknown as IncomingMessage;
    req.method = 'POST';
    return scopedRuntimeRequestError({
      req,
      pathname: options.pathname ?? '/api/delegate',
      scope: options.scope ?? runtimeScope,
      memoryToolNames: [],
    });
  };
  const { runDelegationNow } = await import(
    '../src/gateway/gateway-delegation.js'
  );
  return { check, runDelegationNow, runtimeScope, store, db };
}

test('live nested children keep the scope workspace, token and connector limits', async () => {
  const { check, runDelegationNow, runtimeScope } = await setup();
  const calls: ExecutorRequest[] = [];
  const refusals: Array<string | null> = [];
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    calls.push(params);
    if (params.sessionId.startsWith('delegate:d1:')) {
      refusals.push(await check(params.sessionId));
      await runDelegationNow({ sessionId: params.sessionId, effect });
    }
    return success;
  });
  await runDelegationNow({ sessionId: 'parent', effect });
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.runtimeScope).toEqual(runtimeScope);
    expect(call.workspacePathOverride).toBe(calls[0].workspacePathOverride);
    expect(call.workspacePathOverride).toEqual(expect.any(String));
    expect(call.blockedTools).toContain('hybridai__*__*');
    expect(call.blockedTools).toContain('device_data');
  }
  expect(refusals).toEqual([null]);
});

test.each(['success', 'throw'] as const)(
  'only the exact live scoped child is authorized until %s',
  async (outcome) => {
    const { check, runDelegationNow, runtimeScope, db } = await setup();
    let childId = '';
    let sessionRow: unknown;
    let allowed: string | null | undefined;
    let denied: Array<string | null> = [];
    runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
      childId = params.sessionId;
      sessionRow = db.getSessionById(childId);
      allowed = await check(childId);
      denied = [
        await check(`${childId}-other`),
        await check(childId, { scope: { ...runtimeScope, agentId: 'other' } }),
        await check(childId, { scope: { ...runtimeScope, scopeId: 'other' } }),
        await check(childId, { parentSessionId: 'unknown' }),
        await check(childId, { pathname: '/api/todo' }),
        await check(childId, { pathname: '/api/plugin/tool' }),
        await check(childId, { pathname: '/api/notes/runtime' }),
      ];
      if (outcome === 'throw') throw new Error('Invalid request (400).');
      return success;
    });
    await runDelegationNow({ sessionId: 'parent', effect });
    expect(childId).not.toBe('');
    expect(sessionRow).toBeUndefined();
    expect(allowed).toBeNull();
    expect(denied).toHaveLength(7);
    expect(denied.every((error) => typeof error === 'string')).toBe(true);
    expect(await check(childId)).toEqual(expect.any(String));
  },
);

test('deleting a live child scope denies callbacks and prevents nested execution', async () => {
  const { check, runDelegationNow, runtimeScope, store } = await setup();
  const calls: ExecutorRequest[] = [];
  let refusal: string | null | undefined;
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    calls.push(params);
    if (params.sessionId.startsWith('delegate:d1:')) {
      store.deleteScopeRow(runtimeScope.agentId, runtimeScope.scopeId);
      refusal = await check(params.sessionId);
      await runDelegationNow({ sessionId: params.sessionId, effect });
    }
    return success;
  });
  await runDelegationNow({ sessionId: 'parent', effect });
  expect(calls).toHaveLength(1);
  expect(refusal).toEqual(expect.any(String));
});

test('a live unscoped child cannot borrow a scope token', async () => {
  const { check, runDelegationNow } = await setup(false);
  let refusal: string | null | undefined;
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    refusal = await check(params.sessionId);
    return success;
  });
  await runDelegationNow({ sessionId: 'parent', effect });
  expect(refusal).toEqual(expect.any(String));
  expect(runAgentMock).toHaveBeenCalledTimes(1);
});
