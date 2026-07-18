import { beforeEach, expect, test, vi } from 'vitest';

import type { TokenUsageStats } from '../src/types/usage.js';

const getModelCatalogMetadata = vi.hoisted(() => vi.fn());
const refreshModelCatalogMetadata = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata,
  refreshModelCatalogMetadata,
}));

const {
  estimateRoutingSavingsUsd,
  extractExplicitUsageCostUsd,
  resolveUsageCostUsd,
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

function mockPricing(input: number | null, output: number | null): void {
  getModelCatalogMetadata.mockReturnValue({
    pricingUsdPerToken: { input, output },
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

test('resolveUsageCostUsd keeps explicit provider cost authoritative', () => {
  mockPricing(0.00000003, 0.00000015);

  expect(
    resolveUsageCostUsd({
      model: 'xai/grok-4.20-0309-non-reasoning',
      tokenUsage: makeTokenUsage({ costUsd: 0 }),
      usage: { promptTokens: 1_000_000, completionTokens: 200_000 },
    }),
  ).toBe(0);
  expect(getModelCatalogMetadata).not.toHaveBeenCalled();
});

test('resolveUsageCostUsd estimates cost from model catalog pricing when usage has no cost', () => {
  mockPricing(0.00000003, 0.00000015);

  expect(
    resolveUsageCostUsd({
      model: 'xai/grok-4.20-0309-non-reasoning',
      tokenUsage: makeTokenUsage(),
      usage: { promptTokens: 1_000_000, completionTokens: 200_000 },
    }),
  ).toBeCloseTo(0.06, 8);
});

test('resolveUsageCostUsd falls back to zero when pricing is unavailable', () => {
  expect(
    resolveUsageCostUsd({
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

test('estimateRoutingSavingsUsd prices the same successful tokens at the reference model', () => {
  getModelCatalogMetadata.mockImplementation((model: string) => ({
    pricingUsdPerToken:
      model === 'frontier/model'
        ? { input: 10 / 1_000_000, output: 30 / 1_000_000 }
        : { input: 1 / 1_000_000, output: 3 / 1_000_000 },
  }));

  expect(
    estimateRoutingSavingsUsd({
      referenceModel: 'frontier/model',
      referenceUsage: {
        promptTokens: 1_000_000,
        completionTokens: 200_000,
      },
      attempts: [
        {
          model: 'small/model',
          promptTokens: 1_000_000,
          completionTokens: 200_000,
        },
      ],
    }),
  ).toEqual({
    actualCostUsd: 1.6,
    counterfactualCostUsd: 16,
    savedUsd: 14.4,
  });
});

test('estimateRoutingSavingsUsd includes escalation overhead and permits negative savings', () => {
  mockPricing(1 / 1_000_000, 1 / 1_000_000);

  const estimate = estimateRoutingSavingsUsd({
    referenceModel: 'frontier/model',
    referenceUsage: { promptTokens: 100, completionTokens: 100 },
    attempts: [
      {
        model: 'small/model',
        promptTokens: 100,
        completionTokens: 0,
        costUsd: 0.001,
      },
      {
        model: 'frontier/model',
        promptTokens: 100,
        completionTokens: 100,
        costUsd: 0.002,
      },
    ],
  });
  expect(estimate?.actualCostUsd).toBeCloseTo(0.003, 10);
  expect(estimate?.counterfactualCostUsd).toBeCloseTo(0.0002, 10);
  expect(estimate?.savedUsd).toBeCloseTo(-0.0028, 10);
});
