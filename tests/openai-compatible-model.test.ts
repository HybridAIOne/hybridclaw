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
