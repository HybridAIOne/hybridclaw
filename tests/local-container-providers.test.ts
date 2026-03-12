import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callOllamaProvider,
  callOllamaProviderStream,
} from '../container/src/providers/local-ollama.js';
import {
  callLocalOpenAICompatProvider,
  callLocalOpenAICompatProviderStream,
} from '../container/src/providers/local-openai-compat.js';
import type { ChatMessage, ToolDefinition } from '../container/src/types.js';

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

function makeNdjsonResponse(chunks: string[]): Response {
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
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
const tools: ToolDefinition[] = [
  {
    type: 'function',
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

describe('local container providers', () => {
  test('Ollama provider builds native /api/chat requests and extracts data URI images', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(body.model).toBe('llava:7b');
      expect(body.stream).toBe(false);
      expect(body.options).toEqual({ num_predict: 64 });
      expect(messages[0]?.images).toEqual(['ZmFrZQ==']);
      return new Response(
        JSON.stringify({
          model: 'llava:7b',
          message: {
            role: 'assistant',
            content: 'done',
          },
          prompt_eval_count: 5,
          eval_count: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOllamaProvider({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'ollama/llava:7b',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,ZmFrZQ==' },
            },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/image.png' },
            },
          ],
        },
      ],
      tools,
      maxTokens: 64,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('done');
    expect(result.usage?.total_tokens).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('Ollama provider preserves think blocks in NDJSON streams', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeNdjsonResponse([
          '{"model":"deepseek-r1","message":{"role":"assistant","content":"<think>plan"},"done":false}\n',
          '{"model":"deepseek-r1","message":{"role":"assistant","content":"</think>Hello"},"done":false}\n',
          '{"model":"deepseek-r1","message":{"role":"assistant","content":" world"},"done":false}\n',
          '{"model":"deepseek-r1","done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":4}\n',
        ]),
      ),
    );

    const result = await callOllamaProviderStream({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      model: 'ollama/deepseek-r1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      onTextDelta: (delta) => deltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 131_072,
    });

    expect(deltas).toEqual(['<think>plan', '</think>Hello', ' world']);
    expect(result.choices[0]?.message.content).toBe('Hello world');
    expect(result.usage?.total_tokens).toBe(14);
  });

  test('OpenAI-compatible local provider omits auth headers when apiKey is empty', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).not.toMatchObject({
        Authorization: expect.any(String),
      });
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('qwen2.5-coder');
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'qwen2.5-coder',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
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
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLocalOpenAICompatProvider({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'lmstudio/qwen2.5-coder',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('OpenAI-compatible local provider forwards native audio parts unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]?.content).toEqual([
        { type: 'text', text: 'transcribe this clip' },
        {
          type: 'audio_url',
          audio_url: {
            url: 'data:audio/ogg;base64,ZmFrZQ==',
          },
        },
      ]);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'Qwen/Qwen3.5-27B-FP8',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
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
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLocalOpenAICompatProvider({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/Qwen/Qwen3.5-27B-FP8',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'transcribe this clip' },
            {
              type: 'audio_url',
              audio_url: { url: 'data:audio/ogg;base64,ZmFrZQ==' },
            },
          ],
        },
      ],
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('Qwen-compatible local provider keeps native tool history format', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(body.stop).toEqual(['<|im_end|>', '<|im_start|>']);
      expect(messages).toEqual([
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
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
          content: '/workspace',
          tool_call_id: 'call_1',
        },
      ]);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'qwen/qwen3.5-9b',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLocalOpenAICompatProvider({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'lmstudio/qwen/qwen3.5-9b',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
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
          content: '/workspace',
          tool_call_id: 'call_1',
        },
      ],
      tools,
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      thinkingFormat: 'qwen',
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('Mistral-compatible local provider sanitizes tool call ids in history', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages).toEqual([
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'turn123to',
              type: 'function',
              function: {
                name: 'read',
                arguments: '{"path":"skills/xlsx/SKILL.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'skill body',
          tool_call_id: 'turn123to',
        },
      ]);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLocalOpenAICompatProvider({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/mistralai/Mistral-Small-3.2-24B-Instruct-2506',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'turn_123:tool:1',
              type: 'function',
              function: {
                name: 'read',
                arguments: '{"path":"skills/xlsx/SKILL.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'skill body',
          tool_call_id: 'turn_123:tool:1',
        },
      ],
      tools,
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('Qwen-compatible local provider collapses multiple system messages into one', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(body.stop).toEqual(['<|im_end|>', '<|im_start|>']);
      expect(messages).toEqual([
        {
          role: 'system',
          content: 'primary instructions\n\nruntime capabilities',
        },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'follow-up' },
      ]);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'qwen3.5-9b-mlx',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLocalOpenAICompatProvider({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'lmstudio/qwen3.5-9b-mlx',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [
        { role: 'system', content: 'primary instructions' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'system', content: 'runtime capabilities' },
        { role: 'user', content: 'follow-up' },
      ],
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      thinkingFormat: 'qwen',
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('non-qwen local provider does not send chat-template stop sequences', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.stop).toBeUndefined();
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'mistralai/ministral-3-3b',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLocalOpenAICompatProvider({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'lmstudio/mistralai/ministral-3-3b',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('OpenAI-compatible stream preserves think blocks and normalizes tool calls', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'data: {"id":"resp_1","model":"qwen2.5-coder","choices":[{"delta":{"content":"<think>plan</think>Hello "}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"tool_call","arguments":"{\\"name\\":\\"tools.shell\\",\\"arguments\\":{\\"command\\":\\"ls\\",}}"}}]}}]}\n\n',
          'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'lmstudio/qwen2.5-coder',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools,
      onTextDelta: (delta) => deltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(deltas).toEqual(['<think>plan</think>Hello ']);
    expect(result.choices[0]?.message.content).toBe('Hello');
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'shell',
          arguments: '{"command":"ls"}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('OpenAI-compatible stream reports hidden activity for tool-call-only chunks', async () => {
    const deltas: string[] = [];
    let activityCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'data: {"id":"resp_1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"tool_call","arguments":"{\\"name\\":\\"tools.shell\\",\\"arguments\\":{\\"command\\":\\"pwd\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
          'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/Qwen/Qwen3.5-27B-FP8',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools,
      onTextDelta: (delta) => deltas.push(delta),
      onActivity: () => {
        activityCount += 1;
      },
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(deltas).toEqual([]);
    expect(activityCount).toBeGreaterThan(0);
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'shell',
          arguments: '{"command":"pwd"}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('OpenAI-compatible provider recovers blank tool names from Mistral content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'write',
                    tool_calls: [
                      {
                        id: 'chatcmpl-tool-921c9d30caf9ecf9',
                        type: 'function',
                        function: {
                          name: '',
                          arguments:
                            '{"path":"scripts/create_excel.cjs","contents":"hi"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const result = await callLocalOpenAICompatProvider({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/mistralai/Mistral-Small-3.2-24B-Instruct-2506',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools,
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBeNull();
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'chatcmpl-tool-921c9d30caf9ecf9',
        type: 'function',
        function: {
          name: 'write',
          arguments: '{"path":"scripts/create_excel.cjs","contents":"hi"}',
        },
      },
    ]);
  });

  test('OpenAI-compatible provider surfaces structured qwen reasoning content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'qwen/qwen3.5-9b',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    reasoning_content: 'plan',
                    content: 'answer',
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    const result = await callLocalOpenAICompatProvider({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'lmstudio/qwen/qwen3.5-9b',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      thinkingFormat: 'qwen',
    });

    expect(result.choices[0]?.message.content).toBe('answer');
  });

  test('OpenAI-compatible stream throws provider-side SSE errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'event: error\n',
          'data: {"error":{"message":"No user query found in messages."}}\n\n',
        ]),
      ),
    );

    await expect(
      callLocalOpenAICompatProviderStream({
        provider: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: '',
        model: 'lmstudio/qwen/qwen3.5-9b',
        chatbotId: '',
        enableRag: false,
        requestHeaders: undefined,
        messages: baseMessages,
        tools,
        onTextDelta: () => undefined,
        maxTokens: 128,
        isLocal: true,
        contextWindow: 32_768,
        thinkingFormat: 'qwen',
      }),
    ).rejects.toThrow('No user query found in messages.');
  });
});
