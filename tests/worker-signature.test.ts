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

test('computeWorkerSignature changes when session MCP routing changes', () => {
  const baseline = computeWorkerSignature({
    agentId: 'main',
    provider: 'hybridai',
    baseUrl: 'https://hybridai.one',
    apiKey: 'main-secret',
    requestHeaders: {},
    mcpServers: {
      filesystem: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
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
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    }),
  ).not.toBe(baseline);
});
