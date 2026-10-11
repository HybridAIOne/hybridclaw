import { beforeEach, expect, test, vi } from 'vitest';

import type { TokenUsageStats } from '../src/types/usage.js';

const getModelCatalogMetadata = vi.hoisted(() => vi.fn());
const refreshModelCatalogMetadata = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata,
  refreshModelCatalogMetadata,
}));

const {
  estimateModelUsageCostUsd,
  extractExplicitUsageCostUsd,
  promptTokensIncludeCacheTokens,
  resolveUsageCostUsdAfterMetadataRefresh,
} = await import('../src/usage/model-cost.js');

function makeTokenUsage(extras: Record<string, unknown> = {}): TokenUsageStats {
  return {
    modelCalls: 1,
    apiUsageAvailable: true,
    apiPromptTokens: 0,
    apiCompletionTokens: 0,
    apiTotalTokens: 0,
    apiCacheUsageAvailable: false,
    apiCacheReadTokens: 0,
    apiCacheWriteTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
    ...extras,
  } as TokenUsageStats;
}

function mockPricing(
  input: number | null,
  output: number | null,
  cache: { cacheRead?: number | null; cacheWrite?: number | null } = {},
): void {
  getModelCatalogMetadata.mockReturnValue({
    pricingUsdPerToken: {
      input,
      output,
      cacheRead: cache.cacheRead ?? null,
      cacheWrite: cache.cacheWrite ?? null,
    },
  });
}

beforeEach(() => {
  getModelCatalogMetadata.mockReset();
  refreshModelCatalogMetadata.mockReset();
  refreshModelCatalogMetadata.mockResolvedValue(undefined);
  mockPricing(null, null);
});

test('extractExplicitUsageCostUsd reads provider supplied usage cost', () => {
  expect(extractExplicitUsageCostUsd(makeTokenUsage({ costUsd: 0.42 }))).toBe(
    0.42,
  );
  expect(extractExplicitUsageCostUsd(makeTokenUsage({ costUsd: -1 }))).toBe(
    null,
  );
});

test('cost resolution keeps explicit provider cost authoritative', async () => {
  mockPricing(0.00000003, 0.00000015);

  expect(
    await resolveUsageCostUsdAfterMetadataRefresh({
      model: 'xai/grok-4.20-0309-non-reasoning',
      tokenUsage: makeTokenUsage({ costUsd: 0 }),
      usage: { promptTokens: 1_000_000, completionTokens: 200_000 },
    }),
  ).toBe(0);
  expect(getModelCatalogMetadata).not.toHaveBeenCalled();
});

test('cost resolution estimates cost from model catalog pricing when usage has no cost', async () => {
  mockPricing(0.00000003, 0.00000015);

  expect(
    await resolveUsageCostUsdAfterMetadataRefresh({
      model: 'xai/grok-4.20-0309-non-reasoning',
      tokenUsage: makeTokenUsage(),
      usage: { promptTokens: 1_000_000, completionTokens: 200_000 },
    }),
  ).toBeCloseTo(0.06, 8);
});

test('cost resolution falls back to zero when pricing is unavailable', async () => {
  expect(
    await resolveUsageCostUsdAfterMetadataRefresh({
      model: 'unknown/model',
      tokenUsage: makeTokenUsage(),
      usage: { promptTokens: 1_000_000, completionTokens: 200_000 },
    }),
  ).toBe(0);
});

test('resolveUsageCostUsdAfterMetadataRefresh refreshes catalog before estimating missing cost', async () => {
  mockPricing(0.00000003, 0.00000015);

  await expect(
    resolveUsageCostUsdAfterMetadataRefresh({
      model: 'xai/grok-4.20-0309-non-reasoning',
      tokenUsage: makeTokenUsage(),
      usage: { promptTokens: 1_000_000, completionTokens: 200_000 },
    }),
  ).resolves.toBeCloseTo(0.06, 8);
  expect(refreshModelCatalogMetadata).toHaveBeenCalledWith(
    'xai/grok-4.20-0309-non-reasoning',
  );
});

test('resolveUsageCostUsdAfterMetadataRefresh skips refresh when explicit cost exists', async () => {
  await expect(
    resolveUsageCostUsdAfterMetadataRefresh({
      model: 'xai/grok-4.20-0309-non-reasoning',
      tokenUsage: makeTokenUsage({ costUsd: 0.25 }),
      usage: { promptTokens: 1_000_000, completionTokens: 200_000 },
    }),
  ).resolves.toBe(0.25);
  expect(refreshModelCatalogMetadata).not.toHaveBeenCalled();
});

test('estimateModelUsageCostUsd carves cached tokens out of OpenAI-style prompt tokens', () => {
  mockPricing(2 / 1_000_000, 10 / 1_000_000, {
    cacheRead: 0.2 / 1_000_000,
  });
  expect(promptTokensIncludeCacheTokens('openrouter/openai/gpt-5')).toBe(true);

  expect(
    estimateModelUsageCostUsd({
      model: 'openrouter/openai/gpt-5',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
      cacheReadTokens: 800_000,
    }),
  ).toBeCloseTo(0.2 * 2 + 0.8 * 0.2 + 0.1 * 10, 8);
});

test('estimateModelUsageCostUsd adds cache tokens on top of native Anthropic prompt tokens', () => {
  mockPricing(5 / 1_000_000, 25 / 1_000_000, {
    cacheRead: 0.5 / 1_000_000,
    cacheWrite: 6.25 / 1_000_000,
  });
  expect(promptTokensIncludeCacheTokens('anthropic/claude-opus-5')).toBe(false);

  expect(
    estimateModelUsageCostUsd({
      model: 'anthropic/claude-opus-5',
      promptTokens: 100_000,
      completionTokens: 10_000,
      cacheReadTokens: 900_000,
      cacheWriteTokens: 50_000,
    }),
  ).toBeCloseTo(0.1 * 5 + 0.9 * 0.5 + 0.05 * 6.25 + 0.01 * 25, 8);
});

test('estimateModelUsageCostUsd bills cache tokens at the input price when no cache price is known', () => {
  mockPricing(2 / 1_000_000, 10 / 1_000_000);

  expect(
    estimateModelUsageCostUsd({
      model: 'hybridai/gpt-5-mini',
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 600_000,
    }),
  ).toBeCloseTo(2, 8);
});

test('cost resolution applies cache discounts from reported token usage', async () => {
  mockPricing(2 / 1_000_000, 10 / 1_000_000, { cacheRead: 0.2 / 1_000_000 });

  expect(
    await resolveUsageCostUsdAfterMetadataRefresh({
      model: 'hybridai/gpt-5',
      tokenUsage: makeTokenUsage({
        apiCacheUsageAvailable: true,
        apiCacheReadTokens: 500_000,
        apiCacheWriteTokens: 0,
      }),
      usage: { promptTokens: 1_000_000, completionTokens: 0 },
    }),
  ).toBeCloseTo(0.5 * 2 + 0.5 * 0.2, 8);
});
