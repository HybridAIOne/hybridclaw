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

test('computeWorkerSignature changes when auxiliary task routing changes', () => {
  const baseline = computeWorkerSignature({
    agentId: 'main',
    provider: 'hybridai',
    baseUrl: 'https://hybridai.one',
    apiKey: 'main-secret',
    requestHeaders: {},
    taskModels: {
      compression: {
        provider: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: '',
        requestHeaders: {},
        model: 'lmstudio/qwen/qwen2.5-instruct',
        chatbotId: '',
        maxTokens: 222,
      },
    },
  });

  expect(
    computeWorkerSignature({
      agentId: 'main',
      provider: 'hybridai',
      baseUrl: 'https://hybridai.one',
      apiKey: 'main-secret',
      requestHeaders: {},
      taskModels: {
        compression: {
          provider: 'vllm',
          baseUrl: 'http://127.0.0.1:8000/v1',
          apiKey: '',
          requestHeaders: {},
          model: 'vllm/mistral-small',
          chatbotId: '',
          maxTokens: 222,
        },
      },
    }),
  ).not.toBe(baseline);
});

test('computeWorkerSignature changes when primary model routing changes', () => {
  const baseline = computeWorkerSignature({
    agentId: 'main',
    provider: 'hybridai',
    baseUrl: 'https://hybridai.one',
    apiKey: 'main-secret',
    requestHeaders: {},
    modelRouting: {
      routes: [
        {
          provider: 'hybridai',
          baseUrl: 'https://hybridai.one',
          apiKey: 'main-secret',
          requestHeaders: {},
          model: 'gpt-5-nano',
          chatbotId: 'bot_123',
          enableRag: false,
          maxTokens: 333,
          credentialPool: {
            rotation: 'least_used',
            entries: [
              {
                id: 'pool-a',
                label: 'primary',
                apiKey: 'secret-a',
              },
            ],
          },
        },
      ],
      adaptiveContextTierDowngradeOn429: true,
    },
  });

  expect(
    computeWorkerSignature({
      agentId: 'main',
      provider: 'hybridai',
      baseUrl: 'https://hybridai.one',
      apiKey: 'main-secret',
      requestHeaders: {},
      modelRouting: {
        routes: [
          {
            provider: 'hybridai',
            baseUrl: 'https://hybridai.one',
            apiKey: 'main-secret',
            requestHeaders: {},
            model: 'gpt-5-nano',
            chatbotId: 'bot_123',
            enableRag: false,
            maxTokens: 333,
            credentialPool: {
              rotation: 'least_used',
              entries: [
                {
                  id: 'pool-b',
                  label: 'secondary',
                  apiKey: 'secret-b',
                },
              ],
            },
          },
        ],
        adaptiveContextTierDowngradeOn429: true,
      },
    }),
  ).not.toBe(baseline);

  expect(
    computeWorkerSignature({
      agentId: 'main',
      provider: 'hybridai',
      baseUrl: 'https://hybridai.one',
      apiKey: 'main-secret',
      requestHeaders: {},
      modelRouting: {
        routes: [
          {
            provider: 'hybridai',
            baseUrl: 'https://hybridai.one',
            apiKey: 'main-secret',
            requestHeaders: {},
            model: 'gpt-5',
            chatbotId: 'bot_123',
            enableRag: false,
            maxTokens: 333,
          },
        ],
        adaptiveContextTierDowngradeOn429: true,
      },
    }),
  ).not.toBe(baseline);
});
