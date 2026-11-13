import { afterEach, expect, test, vi } from 'vitest';

const { configMock, getModelCatalogMetadataMock } = vi.hoisted(() => ({
  configMock: {
    SESSION_COMPACTION_BUDGET_RATIO: 0.7,
    SESSION_COMPACTION_TOKEN_BUDGET: 0,
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
  configMock.SESSION_COMPACTION_TOKEN_BUDGET = 0;
  vi.resetModules();
});

test('budget follows the model context window, small or large', async () => {
  const { resolveSessionContextBudgetTokens } = await import(
    '../src/session/context-budget.js'
  );

  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: 32_000 });
  expect(resolveSessionContextBudgetTokens('local/small')).toBe(22_400);
  expect(getModelCatalogMetadataMock).toHaveBeenCalledWith('local/small');

  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: 1_000_000 });
  expect(resolveSessionContextBudgetTokens('gpt-4.1')).toBe(700_000);
});

test('a configured token budget caps a large window', async () => {
  configMock.SESSION_COMPACTION_TOKEN_BUDGET = 100_000;
  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: 1_000_000 });
  const { resolveSessionContextBudgetTokens } = await import(
    '../src/session/context-budget.js'
  );

  expect(resolveSessionContextBudgetTokens('gpt-4.1')).toBe(70_000);
});

test('an unknown model gets the configured cap, or 100k without one', async () => {
  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: null });
  const { resolveSessionContextBudgetTokens } = await import(
    '../src/session/context-budget.js'
  );

  expect(resolveSessionContextBudgetTokens('mystery-model')).toBe(70_000);
  expect(resolveSessionContextBudgetTokens('')).toBe(70_000);
  expect(resolveSessionContextBudgetTokens(null)).toBe(70_000);

  configMock.SESSION_COMPACTION_TOKEN_BUDGET = 300_000;
  expect(resolveSessionContextBudgetTokens('mystery-model')).toBe(210_000);
});

test('history budget subtracts prompt overhead but keeps a floor', async () => {
  getModelCatalogMetadataMock.mockReturnValue({ contextWindow: 100_000 });
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
