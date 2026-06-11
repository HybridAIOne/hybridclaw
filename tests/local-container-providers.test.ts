import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callOllamaProvider,
  callOllamaProviderStream,
} from '../container/src/providers/local-ollama.js';
import {
  callLocalOpenAICompatProvider,
  callLocalOpenAICompatProviderStream,
} from '../container/src/providers/local-openai-compat.js';
import { normalizeOpenRouterRuntimeModelName } from '../container/src/providers/shared.js';
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
      expect(body.tools).toEqual(tools);
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
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.tools).toBeUndefined();
        return makeNdjsonResponse([
          '{"model":"deepseek-r1","message":{"role":"assistant","content":"<think>plan"},"done":false}\n',
          '{"model":"deepseek-r1","message":{"role":"assistant","content":"</think>Hello"},"done":false}\n',
          '{"model":"deepseek-r1","message":{"role":"assistant","content":" world"},"done":false}\n',
          '{"model":"deepseek-r1","done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":4}\n',
        ]);
      }),
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

  test('OpenAI-compatible local provider repairs malformed Unicode before sending prompt', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]?.content).toBe('remember �...[truncated]');
      expect(messages[1]?.content).toEqual([
        { type: 'text', text: 'look at �...[truncated]' },
      ]);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'Qwen/Qwen3.6-27B-FP8',
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
      model: 'vllm/Qwen/Qwen3.6-27B-FP8',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [
        { role: 'assistant', content: 'remember \ud83d...[truncated]' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'look at \ud83d...[truncated]' }],
        },
      ],
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('OpenRouter keeps native router ids and strips vendor-prefixed ids', () => {
    expect(
      normalizeOpenRouterRuntimeModelName(
        'openrouter/anthropic/claude-sonnet-4',
      ),
    ).toBe('anthropic/claude-sonnet-4');
    expect(normalizeOpenRouterRuntimeModelName('openrouter/hunter-alpha')).toBe(
      'openrouter/hunter-alpha',
    );
    expect(normalizeOpenRouterRuntimeModelName('openrouter/healer-alpha')).toBe(
      'openrouter/healer-alpha',
    );
    expect(normalizeOpenRouterRuntimeModelName('openrouter/free')).toBe(
      'openrouter/free',
    );
  });

  test('OpenRouter transport preserves router-native model ids in requests', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('openrouter/hunter-alpha');
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'openrouter/hunter-alpha',
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
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'openrouter/hunter-alpha',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {
        'HTTP-Referer': 'https://github.com/hybridaione/hybridclaw',
        'X-OpenRouter-Title': 'HybridClaw',
        'X-OpenRouter-Categories': 'cli-agent,general-chat',
        'X-Title': 'HybridClaw',
      },
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: false,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('Hugging Face transport strips the provider prefix in requests', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('meta-llama/Llama-3.1-8B-Instruct');
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'meta-llama/Llama-3.1-8B-Instruct',
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
      provider: 'huggingface',
      baseUrl: 'https://router.huggingface.co/v1',
      apiKey: 'hf-test-key',
      model: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: false,
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
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toBe('auto');
      const messages = body.messages as Array<Record<string, unknown>>;
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
      modelBehavior: { thinkingFormat: 'qwen' },
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
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toBe('auto');
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

  test('vLLM Gemma provider uses Gemma tool declarations without native tools', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
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
      expect(String(messages[0]?.content || '')).toContain(
        'type:<|"|>OBJECT<|"|>',
      );
      expect(String(messages[0]?.content || '')).toContain(
        'command:{type:<|"|>STRING<|"|>}',
      );
      expect(String(messages[0]?.content || '')).toContain(
        'Do not write a shell command',
      );
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'google/gemma-4-e4b-it',
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

    const args = {
      provider: 'vllm',
      baseUrl: 'http://haigpu2:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
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
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    } satisfies Parameters<typeof callLocalOpenAICompatProvider>[0];

    const result = await callLocalOpenAICompatProvider(args);

    expect(result.choices[0]?.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body || '{}'),
    ) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
    expect(messages[2]?.role).toBe('assistant');
    expect(String(messages[2]?.content || '')).toContain(
      '<|tool_call>call:shell{command:<|"|>pwd<|"|>}<tool_call|>',
    );
    expect(String(messages[2]?.content || '')).toContain(
      '<|tool_response>response:shell{ok:true}<tool_response|>',
    );
    expect(messages[2]).not.toHaveProperty('tool_calls');
    expect(messages[2]).not.toHaveProperty('tool_responses');
  });

  test('vLLM Gemma provider normalizes call-prefix tool calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'google/gemma-4-e4b-it',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content:
                      'Yes, list of running servers\ncall:hetzner-cloud{action:"list_servers",filters:{status:"running"}}',
                  },
                  finish_reason: 'stop',
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
      baseUrl: 'http://haigpu2:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    });

    expect(result.choices[0]?.message.content).toBe(
      'Yes, list of running servers',
    );
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'hetzner-cloud',
          arguments:
            '{"action":"list_servers","filters":{"status":"running"}}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('vLLM provider does not retry without tools when no prompt tool format is configured', async () => {
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
      callLocalOpenAICompatProvider({
        provider: 'vllm',
        baseUrl: 'http://plain-vllm:8000/v1',
        apiKey: '',
        model: 'vllm/google/gemma-4-e4b-it',
        chatbotId: '',
        enableRag: false,
        requestHeaders: undefined,
        messages: baseMessages,
        tools,
        maxTokens: 128,
        isLocal: true,
        contextWindow: 32_768,
      }),
    ).rejects.toThrow('enable-auto-tool-choice');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body || '{}'),
    ) as Record<string, unknown>;
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('auto');
  });

  test('vLLM Gemma provider normalizes call-prefix tool calls after markdown code spans', async () => {
    const command =
      'node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-servers --project acme';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'google/gemma-4-e4b-it',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: [
                      'The required command is:',
                      `\`${command}\`call:bash{command:${command}}`,
                    ].join('\n'),
                  },
                  finish_reason: 'stop',
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
      baseUrl: 'http://haigpu2:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    });

    expect(result.choices[0]?.message.content).toBe(
      ['The required command is:', `\`${command}\``].join('\n'),
    );
    expect(result.choices[0]?.message.content).not.toContain('call:bash');
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command }),
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('vLLM Gemma provider normalizes documented tool-call markers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'google/gemma-4-e4b-it',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content:
                      'Yes, list of running servers\n<|tool_call>call:hetzner-cloud{action:<|"|>list_servers<|"|>,filters:{status:<|"|>running<|"|>}}<tool_call|><|tool_response>',
                  },
                  finish_reason: 'stop',
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
      baseUrl: 'http://haigpu2:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    });

    expect(result.choices[0]?.message.content).toBe(
      'Yes, list of running servers',
    );
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'hetzner-cloud',
          arguments:
            '{"action":"list_servers","filters":{"status":"running"}}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('vLLM Gemma stream uses Gemma tool declarations without native tools', async () => {
    const deltas: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
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
      expect(String(messages[0]?.content || '')).toContain(
        'type:<|"|>OBJECT<|"|>',
      );
      return makeEventStreamResponse([
        'data: {"id":"resp_1","model":"google/gemma-4-e4b-it","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://haigpu2-stream:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools,
      onTextDelta: (delta) => deltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    });

    expect(deltas).toEqual(['ok']);
    expect(result.choices[0]?.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('vLLM Gemma stream normalizes and hides call-prefix tool calls', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'data: {"id":"resp_1","model":"google/gemma-4-e4b-it","choices":[{"delta":{"content":"Yes, list of running servers"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"\\ncall:hetzner-cloud{action:\\"list_servers\\",filters:{status:\\"running\\"}}"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://haigpu2:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      onTextDelta: (delta) => deltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    });

    expect(deltas).toEqual(['Yes, list of running servers']);
    expect(result.choices[0]?.message.content).toBe(
      'Yes, list of running servers',
    );
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'hetzner-cloud',
          arguments:
            '{"action":"list_servers","filters":{"status":"running"}}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('vLLM Gemma stream hides call-prefix tool calls after markdown code spans', async () => {
    const command =
      'node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-servers --project acme';
    const visibleContent = ['The required command is:', `\`${command}\``].join(
      '\n',
    );
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
                  content: visibleContent,
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: `call:bash{command:${command}}`,
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
              },
            ],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://haigpu2:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      onTextDelta: (delta) => deltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    });

    expect(deltas).toEqual([visibleContent]);
    expect(result.choices[0]?.message.content).toBe(visibleContent);
    expect(result.choices[0]?.message.content).not.toContain('call:bash');
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command }),
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('vLLM Gemma stream normalizes and hides documented tool-call markers', async () => {
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
                  content: 'Yes, list of running servers',
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content:
                    '\n<|tool_call>call:hetzner-cloud{action:<|"|>list_servers<|"|>,filters:{status:<|"|>running<|"|>}}',
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

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://haigpu2:8000/v1',
      apiKey: '',
      model: 'vllm/google/gemma-4-e4b-it',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [],
      onTextDelta: (delta) => deltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { toolCallFormat: 'gemma' },
    });

    expect(deltas).toEqual(['Yes, list of running servers']);
    expect(result.choices[0]?.message.content).toBe(
      'Yes, list of running servers',
    );
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'hetzner-cloud',
          arguments:
            '{"action":"list_servers","filters":{"status":"running"}}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('Qwen-compatible local provider collapses multiple system messages into one', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      const messages = body.messages as Array<Record<string, unknown>>;
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
      modelBehavior: { thinkingFormat: 'qwen' },
      thinkingFormat: 'qwen',
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('non-qwen local provider handles chat completions', async () => {
    const fetchMock = vi.fn(async () => {
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

  test('Liquid/LFM local provider injects List of tools in the system prompt', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toBe('auto');
      expect(messages[0]?.role).toBe('system');
      expect(String(messages[0]?.content || '')).toContain('List of tools:');
      expect(String(messages[0]?.content || '')).toContain('"name":"shell"');
      expect(String(messages[0]?.content || '')).not.toContain(
        'emit a JSON tool call only',
      );
      expect(String(messages[0]?.content || '')).not.toContain(
        'Do not emit Python-style function calls',
      );
      expect(messages[1]).toEqual({ role: 'user', content: 'hello' });
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'LiquidAI/LFM2.5-1.2B-Instruct',
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
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'llamacpp/LiquidAI/LFM2.5-1.2B-Instruct',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools,
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

  test('OpenAI-compatible stream does not duplicate chunks with message and delta content', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'data: {"id":"resp_1","model":"Qwen/Qwen3.6-27B-FP8","choices":[{"message":{"role":"assistant","content":"Straightforward one:"},"delta":{"role":"assistant","content":"Straightforward one:"}}]}\n\n',
          'data: {"choices":[{"message":{"role":"assistant","content":"Straightforward one: done"},"delta":{"content":" done"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/Qwen/Qwen3.6-27B-FP8',
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

    expect(deltas).toEqual(['Straightforward one:', ' done']);
    expect(result.choices[0]?.message.content).toBe(
      'Straightforward one: done',
    );
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

  test('OpenAI-compatible Qwen stream strips tool markup from structured reasoning', async () => {
    const deltas: string[] = [];
    const thinkingDeltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'data: {"id":"resp_1","model":"Qwen/Qwen3.6-27B-FP8","choices":[{"delta":{"reasoning":"Think"}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning":" first."}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"\\n\\n"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"I will read #t.<tool"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"_call>\\n<function=message>\\n<parameter=action>\\nread\\n</parameter>\\n"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"<parameter=channelId>\\n1412305847249535139\\n</parameter>\\n</function>\\n</tool_call>"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"message","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"action\\":\\"read\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"channelId\\":\\"1412305847249535139\\",\\"limit\\":20}"}}]}}]}\n\n',
          'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/Qwen/Qwen3.6-27B-FP8',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools,
      onTextDelta: (delta) => deltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { thinkingFormat: 'qwen' },
      thinkingFormat: 'qwen',
    });

    expect(thinkingDeltas.join('')).toBe('Think first.');
    expect(deltas.join('')).toBe('\n\nI will read #t.');
    expect(deltas.join('')).not.toContain('<think>');
    expect(deltas.join('')).not.toContain('<tool_call>');
    expect(deltas.join('')).not.toContain('<function=');
    expect(result.choices[0]?.message.content).toBe('I will read');
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'message',
          arguments:
            '{"action":"read","channelId":"1412305847249535139","limit":20}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('OpenAI-compatible Qwen stream extracts tool calls from reasoning-only markup', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'data: {"id":"resp_1","model":"Qwen/Qwen3.6-27B-FP8","choices":[{"delta":{"reasoning":"#hybridclaw. Let me read from #t.<tool_call>\\n<function=message>\\n<parameter=action>\\nchannel-info\\n</parameter>\\n"}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning":"<parameter=channelId>\\naidev\\n</parameter>\\n</function>\\n</tool_call>"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/Qwen/Qwen3.6-27B-FP8',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools,
      onTextDelta: (delta) => deltas.push(delta),
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
      modelBehavior: { thinkingFormat: 'qwen' },
      thinkingFormat: 'qwen',
    });

    expect(deltas.join('')).toBe(
      '<think>#hybridclaw. Let me read from #t.</think>',
    );
    expect(deltas.join('')).not.toContain('<tool_call>');
    expect(deltas.join('')).not.toContain('<function=');
    expect(result.choices[0]?.message.content).toBeNull();
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'message',
          arguments: '{"action":"channel-info","channelId":"aidev"}',
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
      modelBehavior: { thinkingFormat: 'qwen' },
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
        modelBehavior: { thinkingFormat: 'qwen' },
        thinkingFormat: 'qwen',
      }),
    ).rejects.toThrow('No user query found in messages.');
  });
});
