import { afterEach, expect, test, vi } from 'vitest';

import { callOpenAICompatibleModel } from '../src/gateway/openai-compatible-model.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('openai-compatible Codex calls strip the provider prefix from request models', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://chatgpt.com/backend-api/codex/responses');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('gpt-5.4');
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'gpt-5.4',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }),
  );

  const result = await callOpenAICompatibleModel({
    runtime: {
      provider: 'openai-codex',
      apiKey: 'codex-key',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      chatbotId: '',
      enableRag: false,
      requestHeaders: { 'OpenAI-Beta': 'responses=experimental' },
      agentId: 'main',
      isLocal: false,
      contextWindow: 200_000,
      thinkingFormat: undefined,
    },
    model: 'openai-codex/gpt-5.4',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  });

  expect(result.choices[0]?.message.content).toBe('ok');
});

test('openai-compatible HybridAI calls omit empty tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://hybridai.one/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('Qwen/Qwen3.6-27B-FP8');
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'Qwen/Qwen3.6-27B-FP8',
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }),
  );

  const result = await callOpenAICompatibleModel({
    runtime: {
      provider: 'hybridai',
      apiKey: 'hybridai-key',
      baseUrl: 'https://hybridai.one',
      chatbotId: 'bot_123',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: false,
      contextWindow: 200_000,
      thinkingFormat: undefined,
    },
    model: 'hybridai/Qwen/Qwen3.6-27B-FP8',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  });

  expect(result.choices[0]?.message.content).toBe('ok');
});

test('openai-compatible remote calls omit empty tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('google/gemini-2.5-flash-lite');
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'google/gemini-2.5-flash-lite',
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }),
  );

  const result = await callOpenAICompatibleModel({
    runtime: {
      provider: 'openrouter',
      apiKey: 'openrouter-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: false,
      contextWindow: 200_000,
      thinkingFormat: undefined,
    },
    model: 'openrouter/google/gemini-2.5-flash-lite',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  });

  expect(result.choices[0]?.message.content).toBe('ok');
});
