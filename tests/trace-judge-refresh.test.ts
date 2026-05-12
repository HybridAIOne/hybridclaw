import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/providers/model-catalog.js');
});

test('judgeTrace fails fast when refreshed catalogs return no models without an explicit judge model', async () => {
  const refreshAvailableModelCatalogs = vi.fn(async () => ({
    attempted: 1,
    fulfilled: 0,
    rejected: 1,
    discoveredModelCount: 0,
    failures: [{ provider: 'hybridai', error: 'HTTP 503' }],
  }));
  const selectModelsByCapabilityAndCost = vi.fn(() => {
    throw new Error('model selection should not run after empty refresh');
  });

  vi.doMock('../src/providers/model-catalog.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/model-catalog.js')
    >('../src/providers/model-catalog.js');
    return {
      ...actual,
      refreshAvailableModelCatalogs,
      selectModelsByCapabilityAndCost,
    };
  });

  const { judgeTrace } = await import('../src/evals/trace-judge.js');

  await expect(
    judgeTrace({ answer: 'A' }, 'Pass correct answers.', {
      refreshCatalog: true,
    }),
  ).rejects.toThrow(
    'No judge model is available after catalog refresh. The refresh returned no discovered models. Failed providers: hybridai (HTTP 503).',
  );
  expect(refreshAvailableModelCatalogs).toHaveBeenCalledWith({
    includeHybridAI: true,
  });
  expect(selectModelsByCapabilityAndCost).not.toHaveBeenCalled();
});
