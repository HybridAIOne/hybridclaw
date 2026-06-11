import { afterEach, expect, test, vi } from 'vitest';

import {
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
} from '../src/gateway/openai-compatible-model.js';

function makeEventStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'shell',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
];

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

test('openai-compatible HybridAI Gemma calls use native tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://hybridai.one/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('google/gemma-4-e4b-it');
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toBe('auto');
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'google/gemma-4-e4b-it',
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
    model: 'hybridai/google/gemma-4-e4b-it',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools,
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

test('openai-compatible non-vLLM Gemma calls use native tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:1234/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('google/gemma-4-e4b-it');
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toBe('auto');
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'google/gemma-4-e4b-it',
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
      provider: 'lmstudio',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1234/v1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: true,
      contextWindow: 32_768,
      thinkingFormat: undefined,
    },
    model: 'lmstudio/google/gemma-4-e4b-it',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools,
  });

  expect(result.choices[0]?.message.content).toBe('ok');
});

test('openai-compatible vLLM Gemma calls use native tools', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('http://haigpu2:8000/v1/chat/completions');
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe('google/gemma-4-e4b-it');
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('auto');
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.some((message) => message.role === 'tool')).toBe(true);
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'shell',
          arguments: '{"command":"pwd"}',
        },
      },
    ]);
    expect(messages[2]).toMatchObject({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: '',
    });
    return new Response(
      JSON.stringify({
        id: 'resp_1',
        model: 'google/gemma-4-e4b-it',
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
  });
  vi.stubGlobal('fetch', fetchMock);

  const params = {
    runtime: {
      provider: 'vllm',
      apiKey: '',
      baseUrl: 'http://haigpu2:8000/v1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: true,
      contextWindow: 32_768,
      thinkingFormat: undefined,
    },
    model: 'vllm/google/gemma-4-e4b-it',
    messages: [
      { role: 'user', content: 'run pwd' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: '',
            type: 'function',
            function: {
              name: 'shell',
              arguments: '{"command":"pwd"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"ok":true}',
        tool_call_id: '',
      },
    ],
    tools,
  } satisfies Parameters<typeof callOpenAICompatibleModel>[0];

  const result = await callOpenAICompatibleModel(params);

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('openai-compatible vLLM Gemma model names use native tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('google/gemma-4-e4b-it');
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toBe('auto');
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'google/gemma-4-e4b-it',
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );

  await callOpenAICompatibleModel({
    runtime: {
      provider: 'vllm',
      apiKey: '',
      baseUrl: 'http://haigpu2:8000/v1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: true,
      contextWindow: 32_768,
      thinkingFormat: undefined,
    },
    model: 'vllm/google/gemma-4-e4b-it',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools,
  });
});

test('openai-compatible vLLM surfaces native tool config errors without retry', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error:
            '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);

  await expect(
    callOpenAICompatibleModel({
      runtime: {
        provider: 'vllm',
        apiKey: '',
        baseUrl: 'http://plain-vllm:8000/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: true,
        contextWindow: 32_768,
        thinkingFormat: undefined,
      },
      model: 'vllm/example/plain-model',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools,
    }),
  ).rejects.toThrow('enable-auto-tool-choice');

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse(
    String(fetchMock.mock.calls[0]?.[1]?.body || '{}'),
  ) as Record<string, unknown>;
  expect(body.tools).toEqual(tools);
  expect(body.tool_choice).toBe('auto');
});

test('openai-compatible vLLM Gemma streams use native tools', async () => {
  const deltas: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('http://haigpu2-stream:8000/v1/chat/completions');
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe('google/gemma-4-e4b-it');
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('auto');
    return makeEventStreamResponse([
      'data: {"id":"resp_1","model":"google/gemma-4-e4b-it","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await callOpenAICompatibleModelStream({
    runtime: {
      provider: 'vllm',
      apiKey: '',
      baseUrl: 'http://haigpu2-stream:8000/v1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: true,
      contextWindow: 32_768,
      thinkingFormat: undefined,
    },
    model: 'vllm/google/gemma-4-e4b-it',
    messages: [{ role: 'user', content: 'hello' }],
    tools,
    onTextDelta: (delta) => deltas.push(delta),
  });

  expect(deltas).toEqual(['ok']);
  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
