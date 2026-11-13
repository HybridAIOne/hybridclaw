import { expect, test, vi } from 'vitest';
import type { TokenUsageStats } from '@hybridclaw/shared/token-usage';
import { createTokenUsageStats } from '@hybridclaw/shared/token-usage';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('agent-usage-validation-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../src/agent/executor.js', '../src/providers/model-catalog.js'],
});

function usage(): TokenUsageStats {
  const counters = {
    ...createTokenUsageStats(),
    modelCalls: 1,
    apiUsageAvailable: true,
    apiPromptTokens: 100,
    apiCompletionTokens: 25,
    apiTotalTokens: 125,
  };
  return {
    ...counters,
    modelUsage: [
      {
        provider: 'vllm',
        model: 'vllm/sample-model',
        task: 'vision',
        status: 'success',
        durationMs: 1,
        usage: counters,
      },
    ],
  };
}

async function execute(tokenUsage: unknown) {
  const root = temp();
  vi.stubEnv('HOME', root);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  const exec = vi.fn(async () => ({
    status: 'success',
    result: 'Fixture complete.',
    toolsUsed: [],
    tokenUsage,
  }));
  vi.doMock('../src/agent/executor.js', () => ({
    getExecutor: () => ({ exec, getWorkspacePath: () => root }),
  }));
  vi.doMock('../src/providers/model-catalog.js', async (original) => ({
    ...(await original<typeof import('../src/providers/model-catalog.js')>()),
    canModelAcceptVisualMedia: async () => false,
  }));
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const { runAgent } = await import('../src/agent/agent.js');
  return runAgent({
    sessionId: 'sample',
    chatbotId: '',
    enableRag: false,
    model: 'vllm/sample-model',
    messages: [{ role: 'user', content: 'Inspect the neutral sample.' }],
  });
}

test('valid worker call records reach the gateway without dropping helper counters', async () => {
  const output = await execute(usage());
  expect(output.tokenUsage).toMatchObject({
    apiTotalTokens: 125,
    modelCalls: 1,
    modelUsage: [{ task: 'vision', model: 'vllm/sample-model' }],
  });
});

test.each([null, 0, ''])(
  'an invalid present usage snapshot is rejected (%j)',
  async (invalid) => {
    await expect(execute(invalid)).rejects.toThrow(
      'Worker returned invalid model usage metadata.',
    );
  },
);

test.each([
  (value: TokenUsageStats) => {
    value.apiTotalTokens = -1;
  },
  (value: TokenUsageStats) => {
    value.modelCalls++;
  },
  (value: TokenUsageStats) => {
    Object.assign(value, { modelUsage: 'invalid' });
  },
  (value: TokenUsageStats) => {
    if (value.modelUsage?.[0])
      value.modelUsage[0].costUsd = Number.POSITIVE_INFINITY;
  },
])(
  'malformed or inconsistent worker usage is rejected before billing',
  async (change) => {
    const invalid = usage();
    change(invalid);
    await expect(execute(invalid)).rejects.toThrow(
      'Worker returned invalid model usage metadata.',
    );
  },
);
