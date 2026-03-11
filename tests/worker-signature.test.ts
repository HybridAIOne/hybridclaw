import { expect, test } from 'vitest';

import { computeWorkerSignature } from '../src/infra/worker-signature.js';

test('computeWorkerSignature is stable for equivalent worker routing', () => {
  const first = computeWorkerSignature({
    agentId: 'vllm',
    provider: 'vllm',
    baseUrl: 'http://haigpu1:8000/v1/',
    apiKey: '',
    requestHeaders: {
      B: 'two',
      A: 'one',
    },
  });
  const second = computeWorkerSignature({
    agentId: 'vllm',
    provider: 'vllm',
    baseUrl: 'http://haigpu1:8000/v1',
    apiKey: '',
    requestHeaders: {
      A: 'one',
      B: 'two',
    },
  });

  expect(first).toBe(second);
});

test('computeWorkerSignature changes when provider routing changes', () => {
  const baseline = computeWorkerSignature({
    agentId: 'lmstudio',
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    requestHeaders: {},
  });

  expect(
    computeWorkerSignature({
      agentId: 'vllm',
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      requestHeaders: {},
    }),
  ).not.toBe(baseline);

  expect(
    computeWorkerSignature({
      agentId: 'lmstudio',
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      requestHeaders: {},
    }),
  ).not.toBe(baseline);

  expect(
    computeWorkerSignature({
      agentId: 'lmstudio',
      provider: 'lmstudio',
      baseUrl: 'http://haigpu1:8000/v1',
      apiKey: '',
      requestHeaders: {},
    }),
  ).not.toBe(baseline);
});
