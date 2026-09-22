import { afterEach, expect, test, vi } from 'vitest';

const { configMock, getModelCatalogMetadataMock } = vi.hoisted(() => ({
  configMock: {
    SESSION_COMPACTION_BUDGET_RATIO: 0.7,
    SESSION_COMPACTION_TOKEN_BUDGET: 100_000,
  },
  getModelCatalogMetadataMock: vi.fn(),
}));

vi.mock('../src/config/config.js', () => configMock);

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata: getModelCatalogMetadataMock,
}));

afterEach(() => {
  getModelCatalogMetadataMock.mockReset();
  configMock.SESSION_COMPACTION_BUDGET_RATIO = 0.7;
  configMock.SESSION_COMPACTION_TOKEN_BUDGET = 100_000;
  vi.resetModules();
});

test('budget scales down to a small model context window', async () => {
  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: 32_000 });
  const { resolveSessionContextBudgetTokens } = await import(
    '../src/session/context-budget.js'
  );

  expect(resolveSessionContextBudgetTokens('local/small')).toBe(22_400);
  expect(getModelCatalogMetadataMock).toHaveBeenCalledWith('local/small');
});

test('budget is capped by the configured token budget for large windows', async () => {
  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: 1_000_000 });
  const { resolveSessionContextBudgetTokens } = await import(
    '../src/session/context-budget.js'
  );

  expect(resolveSessionContextBudgetTokens('gpt-4.1')).toBe(70_000);
});

test('budget falls back to the configured token budget for unknown models', async () => {
  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: null });
  const { resolveSessionContextBudgetTokens } = await import(
    '../src/session/context-budget.js'
  );

  expect(resolveSessionContextBudgetTokens('mystery-model')).toBe(70_000);
  expect(resolveSessionContextBudgetTokens('')).toBe(70_000);
  expect(resolveSessionContextBudgetTokens(null)).toBe(70_000);
});

test('history budget subtracts prompt overhead but keeps a floor', async () => {
  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: 128_000 });
  const { MIN_HISTORY_BUDGET_TOKENS, resolveHistoryBudgetTokens } =
    await import('../src/session/context-budget.js');

  expect(
    resolveHistoryBudgetTokens({ model: 'gpt-5', promptOverheadTokens: 10_000 }),
  ).toBe(60_000);
  expect(
    resolveHistoryBudgetTokens({ model: 'gpt-5', promptOverheadTokens: 90_000 }),
  ).toBe(MIN_HISTORY_BUDGET_TOKENS);
  expect(
    resolveHistoryBudgetTokens({
      model: 'gpt-5',
      promptOverheadTokens: Number.NaN,
    }),
  ).toBe(70_000);
});
