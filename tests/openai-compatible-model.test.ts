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

test('openai-compatible vLLM Gemma calls use Gemma tool declarations without native tools', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('http://haigpu2:8000/v1/chat/completions');
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe('google/gemma-4-e4b-it');
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content || '')).toContain(
      '<|tool>declaration:shell',
    );
    expect(String(messages[0]?.content || '')).toContain(
      '<|tool_call>call:TOOL_NAME',
    );
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          function: {
            name: 'shell',
            arguments: { command: 'pwd' },
          },
        },
      ],
      tool_responses: [
        {
          name: 'shell',
          response: { ok: true },
        },
      ],
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

test('openai-compatible vLLM Gemma calls normalize text tool calls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'google/gemma-4-e4b-it',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'Running it.\n<|tool_call>call:shell{command:<|"|>pwd<|"|>}<tool_call|><|tool_response>',
              },
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

  expect(result.choices[0]?.message.content).toBe('Running it.');
  expect(result.choices[0]?.message.tool_calls).toEqual([
    {
      id: '',
      type: 'function',
      function: {
        name: 'shell',
        arguments: '{"command":"pwd"}',
      },
    },
  ]);
  expect(result.choices[0]?.finish_reason).toBe('tool_calls');
});

test('openai-compatible vLLM Gemma streams use Gemma tool declarations without native tools', async () => {
  const deltas: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('http://haigpu2-stream:8000/v1/chat/completions');
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe('google/gemma-4-e4b-it');
    expect(body.stream).toBe(true);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content || '')).toContain(
      '<|tool>declaration:shell',
    );
    expect(String(messages[0]?.content || '')).toContain(
      '<|tool_call>call:TOOL_NAME',
    );
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

test('openai-compatible vLLM Gemma streams normalize text tool calls without leaking markers', async () => {
  const deltas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      makeEventStreamResponse([
        `data: ${JSON.stringify({
          id: 'resp_1',
          model: 'google/gemma-4-e4b-it',
          choices: [
            {
              delta: {
                content:
                  'Running it.\n<|tool_call>call:shell{command:<|"|>pwd<|"|>}',
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: '<tool_call|><|tool_response>',
              },
              finish_reason: 'stop',
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    ),
  );

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
    messages: [{ role: 'user', content: 'run pwd' }],
    tools,
    onTextDelta: (delta) => deltas.push(delta),
  });

  expect(deltas).toEqual([]);
  expect(result.choices[0]?.message.content).toBe('Running it.');
  expect(result.choices[0]?.message.tool_calls).toEqual([
    {
      id: '',
      type: 'function',
      function: {
        name: 'shell',
        arguments: '{"command":"pwd"}',
      },
    },
  ]);
  expect(result.choices[0]?.finish_reason).toBe('tool_calls');
});
