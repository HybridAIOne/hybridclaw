import { expect, test, vi } from 'vitest';

import { callAuxiliaryModel } from '../src/providers/auxiliary.js';
import { useCleanMocks } from './test-utils.js';

vi.mock('../src/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/factory.js')>()),
  resolveModelRuntimeCredentials: async () => ({
    provider: 'openrouter',
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'example/model',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 32000,
  }),
}));

useCleanMocks({ unstubAllGlobals: true });

test.each([0, 800])('keeps top-level cache hits (%i) on an auxiliary response', async (hit) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'Summary.' } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: 1000 - hit,
    },
  }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const result = await callAuxiliaryModel({
    task: 'compression',
    provider: 'openrouter',
    model: 'openrouter/example/model',
    allowFallback: false,
    messages: [{ role: 'user', content: 'Summarize this document.' }],
  });
  expect(result.usage).toEqual({
    inputTokens: 1000,
    outputTokens: 100,
    totalTokens: 1100,
    cacheReadTokens: hit,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
