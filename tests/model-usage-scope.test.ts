import { expect, test, vi } from 'vitest';
import { readReportedUsageCost } from '../container/shared/reported-usage-cost.js';
import {
  finalizeTokenUsage,
  primaryTokenUsage,
  validateTokenUsage,
} from '../container/shared/token-usage.js';
import { withModelTask, withModelUsage } from '../container/src/model-usage.js';
import { callRoutedModel } from '../container/src/providers/router.js';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('model-usage-scope-');
useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });
const owner = () => new TurnToolHistory('sample', temp(), undefined, 'run-a');

test('only documented USD fields become reported charges', () => {
  expect(readReportedUsageCost({ cost: 0.02 }, 'openrouter')).toBe(0.02);
  expect(readReportedUsageCost({ cost: 0.02 }, 'vllm')).toBeNull();
  expect(readReportedUsageCost({ cost_usd: 0.02 }, 'vllm')).toBe(0.02);
  expect(
    readReportedUsageCost(
      { cost: 0, cost_details: { upstream_inference_cost: 0.02 } },
      'openrouter',
    ),
  ).toBe(0);
});
const context = (model = 'vllm/primary-model') => ({
  provider: 'vllm' as const,
  isLocal: true,
  model,
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'test-key',
  chatbotId: '',
  messages: [{ role: 'user' as const, content: 'private-prompt-marker' }],
  tools: [],
});
function response(tokens = 100, cost?: number) {
  return Response.json({
    choices: [
      {
        message: { role: 'assistant', content: 'private-response-marker' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: tokens,
      completion_tokens: 25,
      total_tokens: tokens + 25,
      ...(cost !== undefined ? { cost_usd: cost } : {}),
    },
  });
}

test('reported charges and helper identities survive normalization without storing content', async () => {
  const history = owner();
  const fetch = vi
    .fn()
    .mockImplementationOnce(async () => response(100, 0))
    .mockImplementationOnce(async () => response(300, 0.02));
  vi.stubGlobal('fetch', fetch);
  await withModelUsage(history, async () => {
    await callRoutedModel(context());
    await withModelTask('vision', () =>
      callRoutedModel(context('vllm/helper-model')),
    );
  });
  const usage = finalizeTokenUsage(history.tokenUsage);
  expect(usage).toMatchObject({
    modelCalls: 2,
    apiPromptTokens: 400,
    apiCompletionTokens: 50,
    apiTotalTokens: 450,
    costUsd: 0.02,
  });
  expect(usage.modelUsage).toMatchObject([
    { model: 'vllm/primary-model', status: 'success', costUsd: 0 },
    {
      model: 'vllm/helper-model',
      task: 'vision',
      status: 'success',
      costUsd: 0.02,
    },
  ]);
  expect(primaryTokenUsage(usage)).toMatchObject({
    modelCalls: 1,
    apiTotalTokens: 125,
    costUsd: 0,
  });
  expect(validateTokenUsage(usage)).toEqual(usage);
  const json = JSON.stringify(usage);
  for (const secret of [
    'test-key',
    'private-prompt-marker',
    'private-response-marker',
  ])
    expect(json).not.toContain(secret);
});

test('parallel request scopes retain their own helper and model counters', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) =>
      response(
        JSON.parse(String(init?.body)).model.includes('first') ? 10 : 20,
      ),
    ),
  );
  const first = owner();
  const second = owner();
  await Promise.all([
    withModelUsage(first, () =>
      withModelTask('vision', () => callRoutedModel(context('vllm/first'))),
    ),
    withModelUsage(second, () =>
      withModelTask('session_search', () =>
        callRoutedModel(context('vllm/second')),
      ),
    ),
  ]);
  expect(first.tokenUsage).toMatchObject({
    modelCalls: 1,
    apiPromptTokens: 10,
    modelUsage: [{ task: 'vision', model: 'vllm/first' }],
  });
  expect(second.tokenUsage).toMatchObject({
    modelCalls: 1,
    apiPromptTokens: 20,
    modelUsage: [{ task: 'session_search', model: 'vllm/second' }],
  });
});

test('a late response cannot mutate its closed owner or a later request', async () => {
  let release: (value: Response) => void = () => {
    throw new Error('No pending response.');
  };
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementationOnce(async () => response(20));
  vi.stubGlobal('fetch', fetch);
  const first = owner();
  const second = owner();
  let pending: Promise<unknown> = Promise.resolve();
  await withModelUsage(first, async () => {
    pending = callRoutedModel(context('vllm/first'));
  });
  const saved = finalizeTokenUsage(first.tokenUsage);
  await withModelUsage(second, () => callRoutedModel(context('vllm/second')));
  release(response(10));
  await pending;
  expect(finalizeTokenUsage(first.tokenUsage)).toEqual(saved);
  expect(saved.modelUsage?.[0]).toMatchObject({
    status: 'running',
    usage: { apiUsageAvailable: false },
  });
  expect(saved.costUsd).toBeUndefined();
  expect(second.tokenUsage).toMatchObject({
    modelCalls: 1,
    apiPromptTokens: 20,
  });
});

test('a failed usage checkpoint prevents an unrecorded provider request', async () => {
  const history = owner();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(history, 'checkpointUsage').mockImplementationOnce(() => {
    throw new Error('Fixture storage failure.');
  });
  await expect(
    withModelUsage(history, () => callRoutedModel(context())),
  ).rejects.toThrow('Fixture storage failure.');
  expect(fetch).not.toHaveBeenCalled();
});

test('invalid per-call metadata and inconsistent aggregate counters fail validation', async () => {
  const history = owner();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(100, 0.01)),
  );
  await withModelUsage(history, () => callRoutedModel(context()));
  const valid = finalizeTokenUsage(history.tokenUsage);
  const changes: Array<(value: typeof valid) => void> = [
    (value) => {
      value.apiTotalTokens++;
    },
    (value) => {
      if (value.modelUsage?.[0]) value.modelUsage[0].usage.modelCalls = 2;
    },
    (value) => {
      value.modelUsage = {} as never;
    },
    (value) => {
      if (value.modelUsage?.[0]) value.modelUsage[0].model = '';
    },
    (value) => {
      if (value.modelUsage?.[0])
        value.modelUsage[0].provider = 'unknown' as never;
    },
    (value) => {
      if (value.modelUsage?.[0]) value.modelUsage[0].durationMs = -1;
    },
    (value) => {
      if (value.modelUsage?.[0]) value.modelUsage[0].costUsd = Number.NaN;
    },
    (value) => {
      if (value.modelUsage?.[0])
        Object.assign(value.modelUsage[0].usage, { modelUsage: [] });
    },
  ];
  for (const change of changes) {
    const invalid = structuredClone(valid);
    change(invalid);
    expect(() => validateTokenUsage(invalid)).toThrow();
  }
  const unknown = structuredClone(valid);
  if (unknown.modelUsage?.[0]) delete unknown.modelUsage[0].costUsd;
  expect(finalizeTokenUsage(unknown).costUsd).toBeUndefined();
});
