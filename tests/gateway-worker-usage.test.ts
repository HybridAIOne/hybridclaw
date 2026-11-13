import { expect, test, vi } from 'vitest';
import type { ModelCallUsage } from '@hybridclaw/shared/token-usage';
import {
  createTokenUsageStats,
  finalizeTokenUsage,
} from '@hybridclaw/shared/token-usage';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent }));
vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: async () => ({
    provider: 'hybridai',
    model: 'example/helper',
    content: '',
  }),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'gateway-worker-usage-',
  cleanup: async () => {
    const { stopTokenUsageBuffer } = await import(
      '../src/usage/token-usage-buffer.js'
    );
    await stopTokenUsageBuffer();
    runAgent.mockReset();
  },
});

test('chat persists primary and worker helper charges once under their own models', async () => {
  setupHome();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('No network in fixture.')),
  );
  const primary = {
    ...createTokenUsageStats(),
    modelCalls: 1,
    apiUsageAvailable: true,
    apiPromptTokens: 100,
    apiCompletionTokens: 25,
    apiTotalTokens: 125,
  };
  const calls: ModelCallUsage[] = [
    {
      provider: 'lmstudio',
      model: 'lmstudio/sample',
      status: 'success',
      durationMs: 1,
      usage: primary,
      costUsd: 0.01,
    },
    {
      provider: 'openrouter',
      model: 'openrouter/example/helper',
      task: 'vision',
      status: 'success',
      durationMs: 1,
      usage: primary,
      costUsd: 0.03,
    },
  ];
  runAgent.mockResolvedValue({
    status: 'success',
    result: 'The neutral sample is complete.',
    toolsUsed: [],
    toolExecutions: [],
    tokenUsage: finalizeTokenUsage({
      ...primary,
      modelCalls: 2,
      apiPromptTokens: 200,
      apiCompletionTokens: 50,
      apiTotalTokens: 250,
      modelUsage: calls,
    }),
  });
  const { initDatabase, listUsageByModel } = await import(
    '../src/memory/db.js'
  );
  initDatabase({ quiet: true });
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  updateRuntimeConfig((draft) => {
    draft.local.backends.lmstudio.enabled = true;
    draft.routing.enabled = false;
    draft.routing.showRoutingInfo = true;
  });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const result = await handleGatewayMessage({
    sessionId: 'worker-usage-session',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'user_a',
    content: 'Inspect the neutral sample.',
    model: 'lmstudio/sample',
  });
  const { flushTokenUsageBuffer } = await import(
    '../src/usage/token-usage-buffer.js'
  );
  await flushTokenUsageBuffer();

  expect(result.status).toBe('success');
  expect(result.cost).toMatchObject({ requests: 2, free: false });
  expect(result.routingTrace?.attempts).toHaveLength(2);
  expect(listUsageByModel()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: 'lmstudio/sample',
        total_tokens: 125,
        total_cost_usd: 0.01,
        call_count: 1,
      }),
      expect.objectContaining({
        model: 'openrouter/example/helper',
        total_tokens: 125,
        total_cost_usd: 0.03,
        call_count: 1,
      }),
    ]),
  );
  expect(listUsageByModel()).toHaveLength(2);
});
