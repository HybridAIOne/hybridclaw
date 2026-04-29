import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/providers/auxiliary.js');
  vi.doUnmock('../src/providers/model-catalog.js');
});

test('judgeTrace dispatches default judge calls through the eval_judge task', async () => {
  const callAuxiliaryModel = vi.fn(async () => ({
    provider: 'hybridai' as const,
    model: 'hybridai/cheap-json-model',
    content: JSON.stringify({
      score: 1,
      reasoning: 'The trace satisfies the criterion.',
      verdict: 'pass',
    }),
  }));

  vi.doMock('../src/providers/auxiliary.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/auxiliary.js')
    >('../src/providers/auxiliary.js');
    return {
      ...actual,
      callAuxiliaryModel,
    };
  });

  const { judgeTrace } = await import('../src/evals/trace-judge.js');

  await expect(
    judgeTrace({ answer: 'A' }, 'Pass correct answers.', {
      model: 'cheap-json-model',
    }),
  ).resolves.toMatchObject({
    score: 1,
    verdict: 'pass',
  });
  expect(callAuxiliaryModel).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'eval_judge',
      model: 'cheap-json-model',
    }),
  );
});
