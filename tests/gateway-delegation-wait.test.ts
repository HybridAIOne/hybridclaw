import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
}));

const makeTempHome = useTempDir('hybridclaw-delegation-wait-');

useCleanMocks({
  resetModules: true,
  cleanup: () => {
    runAgentMock.mockReset();
    vi.unstubAllEnvs();
  },
});

async function setup() {
  const homeDir = makeTempHome();
  vi.stubEnv('HOME', homeDir);
  const delegation = await import('../src/gateway/gateway-delegation.ts');
  const db = await import('../src/memory/db.ts');
  db.initDatabase({ quiet: true, dbPath: path.join(homeDir, 'hybridclaw.db') });
  return { ...delegation, ...db };
}

test('a waiting delegate call returns the child reports to the parent turn', async () => {
  const { runDelegationNow, getOrCreateSession } = await setup();
  getOrCreateSession('web-parent', null, 'web', 'main');
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'child found 3 errors',
    toolsUsed: ['tool_catalog'],
  });

  const outcome = await runDelegationNow({
    sessionId: 'web-parent',
    effect: { action: 'delegate', prompt: 'Scan the logs.', label: 'logs' },
  });

  expect(outcome).toEqual({
    result: expect.stringContaining('child found 3 errors'),
  });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
    sessionId: expect.stringMatching(/^delegate:d1:web-parent:/),
    agentId: 'main',
    channelId: 'web',
  });
  expect(runAgentMock.mock.calls[0]?.[0]).not.toHaveProperty('allowedTools');
});

test('a child waiting on its own delegate resolves the parent context', async () => {
  const { runDelegationNow, getOrCreateSession } = await setup();
  getOrCreateSession('web-parent', null, 'web', 'main');
  const nested: Array<Awaited<ReturnType<typeof runDelegationNow>>> = [];
  runAgentMock.mockImplementation(async (params: { sessionId: string }) => {
    if (params.sessionId.startsWith('delegate:d1:')) {
      nested.push(
        await runDelegationNow({
          sessionId: params.sessionId,
          effect: { action: 'delegate', prompt: 'Nested step.' },
        }),
      );
    }
    return { status: 'success', result: 'done', toolsUsed: [] };
  });

  await runDelegationNow({
    sessionId: 'web-parent',
    effect: { action: 'delegate', prompt: 'Outer step.' },
  });

  expect(nested).toEqual([{ result: expect.stringContaining('done') }]);
  expect(runAgentMock.mock.calls[1]?.[0]).toMatchObject({
    sessionId: expect.stringMatching(/^delegate:d2:/),
    agentId: 'main',
  });
});

test('a waiting delegate call from an unknown session is refused', async () => {
  const { runDelegationNow } = await setup();

  const outcome = await runDelegationNow({
    sessionId: 'no-such-session',
    effect: { action: 'delegate', prompt: 'Scan the logs.' },
  });

  expect(outcome).toEqual({ error: 'Unknown delegating session.', status: 404 });
  expect(runAgentMock).not.toHaveBeenCalled();
});

test('a child stopped by an approval gate reports blocked, not its prompt', async () => {
  const { runDelegationNow, getOrCreateSession } = await setup();
  getOrCreateSession('web-parent', null, 'web', 'main');
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'I need your approval before I run deploy.sh.',
    toolsUsed: [],
    pendingApproval: {
      approvalId: 'a1',
      prompt: 'I need your approval before I run deploy.sh.',
      intent: 'run deploy.sh',
      reason: 'shell command',
      toolName: 'bash',
      allowSession: true,
      allowAgent: true,
      allowAll: false,
      expiresAt: null,
    },
  });

  const outcome = await runDelegationNow({
    sessionId: 'web-parent',
    effect: { action: 'delegate', prompt: 'Deploy.' },
  });

  expect('result' in outcome && outcome.result).toContain('status: blocked');
  expect('result' in outcome && outcome.result).toContain(
    'needs user approval to run bash: run deploy.sh',
  );
  expect('result' in outcome && outcome.result).not.toContain(
    'I need your approval',
  );
});

test('background results never wake a parent session that was reset meanwhile', async () => {
  const {
    createFreshSessionInstance,
    enqueueDelegationBatchFromSideEffects,
    getDelegationJob,
    getOrCreateSession,
  } = await setup();
  getOrCreateSession('tui-parent', null, 'tui', 'main');
  runAgentMock.mockImplementation(async () => {
    createFreshSessionInstance('tui-parent');
    return { status: 'success', result: 'late report', toolsUsed: [] };
  });
  const runParentTurn = vi.fn();

  const descriptor = enqueueDelegationBatchFromSideEffects({
    plans: [
      {
        mode: 'single',
        tasks: [{ prompt: 'Slow task.', model: 'test-model' }],
      },
    ],
    parentSessionId: 'tui-parent',
    channelId: 'tui',
    chatbotId: 'test-bot',
    enableRag: false,
    agentId: 'main',
    parentDepth: 0,
    runParentTurn,
  });

  await vi.waitFor(() =>
    expect(getDelegationJob(descriptor?.publicId || '')?.status).toBe('failed'),
  );
  expect(getDelegationJob(descriptor?.publicId || '')?.error).toBe(
    'parent_session_gone',
  );
  expect(runParentTurn).not.toHaveBeenCalled();
});
