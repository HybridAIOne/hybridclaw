import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-agent-budget-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../src/agent/executor.js', '../src/providers/model-catalog.js'],
});

async function setup(costUsd: number) {
  const root = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.stubEnv('HOME', root);
  const exec = vi.fn(async (_request: ExecutorRequest) => ({
    status: 'success',
    result: 'ok',
    toolsUsed: [],
  }));
  const executor = { exec, getWorkspacePath: () => root };
  vi.doMock('../src/agent/executor.js', () => ({
    getExecutor: () => executor,
  }));
  vi.doMock('../src/providers/model-catalog.js', async (original) => ({
    ...(await original<typeof import('../src/providers/model-catalog.js')>()),
    canModelAcceptVisualMedia: async () => false,
  }));
  const db = await import('../src/memory/db.js');
  const config = await import('../src/config/runtime-config.js');
  db.initDatabase({ quiet: true });
  config.updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', budget: { cap: 10, currency: 'USD', unit: 'USD' } },
    ];
  });
  db.recordUsageEvent({
    sessionId: 'earlier-session',
    agentId: 'main',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costUsd,
  });
  const { runAgent } = await import('../src/agent/agent.js');
  const request: ExecutorRequest = {
    sessionId: 'budget-session',
    chatbotId: 'test-bot',
    model: 'test-model',
    enableRag: false,
    messages: [{ role: 'user', content: 'Continue' }],
  };
  return { exec, config, runAgent, request };
}

test.each([10, 11])(
  'blocks execution at %s USD, including the default agent',
  async (cost) => {
    const { exec, runAgent, request } = await setup(cost);
    for (const agentId of [undefined, 'main']) {
      expect(await runAgent({ ...request, agentId })).toMatchObject({
        status: 'error',
        error: expect.stringContaining('Monthly budget exhausted'),
      });
    }
    expect(exec).not.toHaveBeenCalled();
  },
);

test('allows spending below the cap and agents without a cap', async () => {
  const { exec, runAgent, request } = await setup(9.99);
  for (const agentId of ['main', 'other']) {
    expect(await runAgent({ ...request, agentId })).toMatchObject({
      status: 'success',
    });
  }
  expect(exec).toHaveBeenCalledTimes(2);
});

test('checks the current cap on each run so raising it restores execution', async () => {
  const { exec, config, runAgent, request } = await setup(10);
  expect((await runAgent(request)).status).toBe('error');
  config.updateRuntimeConfig((draft) => {
    draft.agents.list[0].budget!.cap = 20;
  });
  expect((await runAgent(request)).status).toBe('success');
  expect(exec).toHaveBeenCalledOnce();
});

test('scheduled tasks report an exhausted cap without starting a worker', async () => {
  const { exec } = await setup(10);
  const { runIsolatedScheduledTask } = await import(
    '../src/scheduler/scheduled-task-runner.js'
  );
  const onResult = vi.fn();
  const onError = vi.fn();
  await runIsolatedScheduledTask({
    taskId: 999,
    prompt: 'Prepare a report',
    channelId: 'tui',
    chatbotId: 'test-bot',
    model: 'test-model',
    agentId: 'main',
    sessionId: 'budget-session',
    onResult,
    onError,
  });
  expect(exec).not.toHaveBeenCalled();
  expect(onResult).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(
    expect.stringContaining('Monthly budget exhausted'),
  );
});
