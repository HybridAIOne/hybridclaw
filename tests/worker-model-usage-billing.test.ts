import { beforeEach, expect, test, vi } from 'vitest';
import type { ModelCallUsage } from '@hybridclaw/shared/token-usage';
import {
  createTokenUsageStats,
  finalizeTokenUsage,
  primaryTokenUsage,
} from '@hybridclaw/shared/token-usage';
import { withChatRoutingTrace } from '../src/gateway/chat-routing-trace.js';
import type { GatewayChatRequest } from '../src/gateway/gateway-types.js';
import {
  estimateModelUsageCostUsd,
  explicitUsageCostSource,
  extractExplicitUsageCostUsd,
  resolveUsageCostUsdAfterMetadataRefresh,
} from '../src/usage/model-cost.js';
import {
  finishRoutingTraceAttempt,
  startRoutingTraceAttempt,
} from '../src/usage/routing-trace.js';
import { taskCostFromUsage } from '../src/usage/task-cost.js';
import {
  buildTokenUsageAuditPayload,
  recordWorkerAuxiliaryUsage,
} from '../src/usage/worker-model-usage.js';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  audit: vi.fn(),
  persist: vi.fn(),
  metadata: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../src/usage/token-usage-buffer.js', () => ({
  enqueueTokenUsage: mocks.enqueue,
  readCacheTokenUsage: () => ({}),
}));
vi.mock('../src/audit/audit-events.js', () => ({
  makeAuditRunId: () => 'sample-run',
  recordAuditEvent: mocks.audit,
}));
vi.mock('../src/memory/messages.js', () => ({
  setMessageRoutingTrace: mocks.persist,
}));
vi.mock('../src/config/runtime-config.js', () => ({
  getRuntimeConfig: () => ({ routing: { showRoutingInfo: true } }),
}));
vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata: mocks.metadata,
  refreshModelCatalogMetadata: mocks.refresh,
}));
vi.mock('../src/providers/hybridai-discovery.js', () => ({
  isDiscoveredHybridAIFreeTierModel: () => false,
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
useCleanMocks();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadata.mockReturnValue({
    zone: 'cloud',
    pricingUsdPerToken: { input: 0.001, output: 0.002 },
  });
  mocks.refresh.mockResolvedValue(undefined);
});

function call(task?: string, costUsd?: number): ModelCallUsage {
  return {
    model: task ? 'openrouter/example/helper' : 'openrouter/example/primary',
    provider: 'openrouter',
    ...(task ? { task } : {}),
    status: 'success',
    durationMs: 10,
    usage: {
      ...createTokenUsageStats(),
      modelCalls: 1,
      apiUsageAvailable: true,
      apiPromptTokens: 100,
      apiCompletionTokens: 25,
      apiTotalTokens: 125,
    },
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
function stats(records: ModelCallUsage[]) {
  const known = records.filter(
    (record) => record.usage.apiUsageAvailable,
  ).length;
  return finalizeTokenUsage({
    ...createTokenUsageStats(),
    modelCalls: records.length,
    apiUsageAvailable: known > 0,
    apiPromptTokens: known * 100,
    apiCompletionTokens: known * 25,
    apiTotalTokens: known * 125,
    estimatedPromptTokens: (records.length - known) * 100,
    modelUsage: records,
  });
}

test('primary pricing excludes helper tokens and helper-reported charges', async () => {
  const usage = stats([call(undefined, 0.01), call('vision', 0.03)]);
  expect(usage.costUsd).toBe(0.04);
  expect(primaryTokenUsage(usage)).toMatchObject({
    apiTotalTokens: 125,
    modelCalls: 1,
    costUsd: 0.01,
  });
  expect(buildTokenUsageAuditPayload([], null, usage)).toMatchObject({
    totalTokens: 125,
    modelCalls: 1,
  });
  expect(extractExplicitUsageCostUsd(usage)).toBe(0.01);
  expect(
    await resolveUsageCostUsdAfterMetadataRefresh({
      model: 'openrouter/example/primary',
      tokenUsage: usage,
      usage: { promptTokens: 100, completionTokens: 25 },
    }),
  ).toBe(0.01);
  const records = await recordWorkerAuxiliaryUsage({
    sessionId: 'sample',
    agentId: 'main',
    auditRunId: 'run-a',
    usages: [usage],
  });
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'openrouter/example/helper',
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.03,
    }),
  );
  expect(mocks.enqueue.mock.calls[0][0]).not.toHaveProperty('tokenUsage');
  expect(records[0]).toMatchObject({
    costSource: 'reported',
    modelCalls: 1,
    usageSource: 'worker',
  });
});

test('worker helper billing is not queued again by chat routing collection', async () => {
  const request: GatewayChatRequest = {
    sessionId: 'sample',
    agentId: 'main',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'user_a',
    content: 'Inspect the neutral sample.',
  };
  const result = await withChatRoutingTrace(request, async () => {
    startRoutingTraceAttempt('openrouter/example/primary');
    finishRoutingTraceAttempt({
      model: 'openrouter/example/primary',
      status: 'success',
      durationMs: 1,
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.01,
      modelCalls: 1,
    });
    await recordWorkerAuxiliaryUsage({
      sessionId: 'sample',
      agentId: 'main',
      auditRunId: 'run-a',
      usages: [stats([call('vision', 0.03)])],
    });
    return {
      status: 'success' as const,
      result: 'Complete.',
      toolsUsed: [],
      sessionId: 'sample',
      agentId: 'main',
    };
  });
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  expect(result.routingTrace?.attempts).toHaveLength(2);
  expect(result.cost).toMatchObject({ requests: 2, free: false });
});

test('an auxiliary-only request has no inferred primary charge or call', () => {
  const usage = stats([call('eval_judge', 0.03)]);
  expect(
    buildTokenUsageAuditPayload(
      [{ role: 'user', content: 'A neutral approval reply.' }],
      'Reply.',
      usage,
    ),
  ).toMatchObject({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
  });
  expect(extractExplicitUsageCostUsd(usage)).toBe(0);
});

test('unreported helper and primary usage keep task cost unknown', async () => {
  const pending = {
    ...call('vision'),
    status: 'error' as const,
    usage: {
      ...createTokenUsageStats(),
      modelCalls: 1,
      estimatedPromptTokens: 100,
    },
  };
  const records = await recordWorkerAuxiliaryUsage({
    sessionId: 'sample',
    agentId: 'main',
    auditRunId: 'run-a',
    usages: [stats([pending])],
  });
  expect(records[0]).toMatchObject({
    costUsd: null,
    costSource: 'unknown',
    inputTokens: null,
  });
  expect(mocks.enqueue.mock.calls[0][0]).not.toHaveProperty('costUsd');
  expect(
    taskCostFromUsage({
      model: 'openrouter/example/primary',
      costUsd: 0,
      requests: 1,
      additionalCalls: records,
    }),
  ).toEqual({ eur: null, free: false, requests: 2 });
  expect(
    explicitUsageCostSource(stats([{ ...pending, task: undefined }])),
  ).toBe('unknown');
  expect(
    taskCostFromUsage({
      model: 'openrouter/example/primary',
      costUsd: null,
      requests: 1,
    }),
  ).toEqual({ eur: null, free: false, requests: 1 });
});

test('a paid helper makes a free primary task paid and adds its model request', async () => {
  const records = await recordWorkerAuxiliaryUsage({
    sessionId: 'sample',
    agentId: 'main',
    auditRunId: 'run-a',
    usages: [stats([call('vision', 0.03)])],
  });
  const cost = taskCostFromUsage({
    model: 'free-model',
    costUsd: 0,
    requests: 1,
    additionalCalls: records,
    isFree: (model) => model === 'free-model',
  });
  expect(cost).toMatchObject({ free: false, requests: 2 });
  expect(cost.eur).toBeGreaterThan(0);
});

test.each([
  { input: null, output: 0.002 },
  { input: 0.001, output: null },
])('a missing nonzero token price stays unknown (%j)', (pricing) => {
  mocks.metadata.mockReturnValue({
    zone: 'cloud',
    pricingUsdPerToken: pricing,
  });
  expect(
    estimateModelUsageCostUsd({
      model: 'openrouter/example/helper',
      promptTokens: 100,
      completionTokens: 25,
    }),
  ).toBeNull();
});
