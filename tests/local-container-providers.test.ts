import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callOllamaProvider,
  callOllamaProviderStream,
} from '../container/src/providers/local-ollama.js';
import {
  callLocalOpenAICompatProvider,
  callLocalOpenAICompatProviderStream,
  estimateLocalOpenAICompatPromptOverheadTokens,
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
// What small Liquid browser models receive: same tools with the call-shape
// example appended to the description (see compactBrowserTool).
const toolsWithExamples = tools.map((tool) => ({
  ...tool,
  function: {
    ...tool.function,
    description: `${tool.function.description} Example: shell(command="...")`,
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local container providers', () => {
  test('Gemma models do not add prompt tool overhead', () => {
    expect(
      estimateLocalOpenAICompatPromptOverheadTokens({
        provider: 'vllm',
        model: 'vllm/google/gemma-4-e4b-it',
        tools,
      }),
    ).toBe(0);
    expect(
      estimateLocalOpenAICompatPromptOverheadTokens({
        provider: 'vllm',
        model: 'vllm/google/embeddinggemma-300m',
        tools,
      }),
    ).toBe(0);
    expect(
      estimateLocalOpenAICompatPromptOverheadTokens({
        provider: 'vllm',
        model: 'vllm/example/plain-model',
        tools,
      }),
    ).toBe(0);
  });

  test('browser models compact tool schemas (strip param prose, keep structure)', async () => {
    const verboseTool: ToolDefinition = {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: `Snapshot the page. ${'detail '.repeat(80)}`,
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['default', 'full'],
              description: `Mode. ${'explanation '.repeat(40)}`,
            },
            frame: { type: 'string', description: 'Optional frame selector.' },
          },
          required: ['mode'],
        },
      },
    };
    let sentTools: Array<{
      function: {
        description: string;
        parameters: {
          properties: Record<string, { description?: string; enum?: string[] }>;
        };
      };
    }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentTools = (
        JSON.parse(String(init?.body || '{}')) as { tools: typeof sentTools }
      ).tools;
      return new Response(
        JSON.stringify({
          id: 'r',
          model: 'm',
          choices: [
            { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLocalOpenAICompatProvider({
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/huggingworld/Qwen3.5-4B-ONNX',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: [verboseTool],
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    const fn = sentTools[0]?.function;
    // Tool description capped to the one-line budget.
    expect(fn.description.length).toBeLessThanOrEqual(240);
    // Per-parameter description prose stripped...
    expect(fn.parameters.properties.mode.description).toBeUndefined();
    expect(fn.parameters.properties.frame.description).toBeUndefined();
    // ...but structure (enums) preserved so calls stay valid.
    expect(fn.parameters.properties.mode.enum).toEqual(['default', 'full']);
  });

  test('small Liquid models get call examples in tool descriptions; others do not', async () => {
    const sentDescriptionsFor = async (model: string): Promise<string[]> => {
      let descriptions: string[] = [];
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          tools?: Array<{ function: { description: string } }>;
        };
        descriptions = (body.tools || []).map(
          (tool) => tool.function.description,
        );
        return new Response(
          JSON.stringify({
            id: 'r',
            model: 'm',
            choices: [
              { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      await callLocalOpenAICompatProvider({
        provider: 'browser',
        baseUrl: 'http://127.0.0.1:8789/v1',
        apiKey: '',
        model,
        chatbotId: '',
        enableRag: false,
        requestHeaders: undefined,
        messages: baseMessages,
        tools,
        maxTokens: 128,
        isLocal: true,
        contextWindow: 32_768,
      });
      return descriptions;
    };

    // A 350M needs the call shape spelled out to produce argument values...
    expect(
      (await sentDescriptionsFor('browser/LiquidAI/LFM2.5-350M-ONNX'))[0],
    ).toContain('Example: shell(command="...")');
    // ...larger models keep the plain compacted description.
    expect(
      (await sentDescriptionsFor('browser/LiquidAI/LFM2.5-8B-A1B-ONNX'))[0],
    ).not.toContain('Example:');
  });

  test('vision browser model preserves image content in messages', async () => {
    const imageMessages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
          { type: 'text', text: 'What animal is this?' },
        ],
      },
    ];
    let body: {
      tools?: unknown[];
      messages: Array<{ role: string; content: unknown }>;
    } = { messages: [] };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          id: 'r',
          model: 'm',
          choices: [
            { message: { role: 'assistant', content: 'Cat' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLocalOpenAICompatProvider({
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/onnx-community/LFM2.5-VL-450M-ONNX',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: imageMessages,
      tools: [
        {
          type: 'function',
          function: {
            name: 'bash',
            description: 'Run a shell command.',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        },
      ],
      maxTokens: 32,
      isLocal: true,
      contextWindow: 32_768,
    });

    // The image content part survives to the bridge (not flattened to text).
    const userMessage = body.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const parts = userMessage?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });

  test('tight-budget model bounds the TOTAL prompt as tool results accumulate', async () => {
    // Regression: after a successful tool call, the follow-up turn carries the
    // whole conversation + a large tool result. The total content must stay
    // bounded so the rendered prompt fits under Gemma's token guard;
    // previously only per-message caps existed and the sum blew past the guard.
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command and return its output.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: 'cmd' } },
            required: ['command'],
          },
        },
      },
    ];
    const hugeToolResult = Array.from(
      { length: 400 },
      (_, i) => `drwxr-xr-x@ ${i} bkoehler staff ${i * 32} Jun 30 entry_${i}`,
    ).join('\n');
    const accumulated: ChatMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help you today?' },
      { role: 'user', content: 'Run ls -la as bash command' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"ls -la"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: hugeToolResult },
    ];
    let body: { messages: Array<{ content: string }> } = { messages: [] };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          id: 'r',
          model: 'm',
          choices: [
            { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLocalOpenAICompatProvider({
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/onnx-community/gemma-4-E2B-it-ONNX',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: accumulated,
      tools,
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    const totalContentChars = body.messages.reduce(
      (sum, message) => sum + String(message.content || '').length,
      0,
    );
    // Even with a 20k+ char tool result, the total content is bounded well under
    // the ~3400 chars that render to Gemma's 1740-token guard.
    expect(hugeToolResult.length).toBeGreaterThan(15_000);
    expect(totalContentChars).toBeLessThanOrEqual(3400);
  });

  test('small LFM and Gemma models get a short native tool list; large ones keep more', async () => {
    const manyTools: ToolDefinition[] = Array.from({ length: 40 }, (_, i) => ({
      type: 'function',
      function: {
        name: i === 0 ? 'bash' : `tool_${i}`,
        description: `Tool number ${i}`,
        parameters: {
          type: 'object',
          properties: { arg: { type: 'string' } },
          required: [],
        },
      },
    }));
    const sentToolCountFor = async (model: string): Promise<number> => {
      let count = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          tools?: unknown[];
        };
        count = (body.tools || []).length;
        return new Response(
          JSON.stringify({
            id: 'r',
            model: 'm',
            choices: [
              { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      await callLocalOpenAICompatProvider({
        provider: 'browser',
        baseUrl: 'http://127.0.0.1:8789/v1',
        apiKey: '',
        model,
        chatbotId: '',
        enableRag: false,
        requestHeaders: undefined,
        messages: baseMessages,
        tools: manyTools,
        maxTokens: 128,
        isLocal: true,
        contextWindow: 32_768,
      });
      return count;
    };

    // A 350M gets a short list (Liquid guidance) to avoid hallucinating tools,
    // Gemma's cap keeps the rendered declarations inside its token guard...
    expect(await sentToolCountFor('browser/LiquidAI/LFM2.5-350M-ONNX')).toBe(16);
    expect(
      await sentToolCountFor('browser/onnx-community/gemma-4-E2B-it-ONNX'),
    ).toBe(12);
    // ...while a large LFM keeps the full compacted set.
    expect(
      await sentToolCountFor('browser/LiquidAI/LFM2.5-8B-A1B-ONNX'),
    ).toBeGreaterThan(16);
  });

  test('tight-budget model bounds verbose tool declarations by chars and discloses drops', async () => {
    // Twelve verbose tools would render past Gemma's token guard even under
    // the count cap, so the list must shrink by serialized size too, and the
    // system prompt must tell the model that tools were omitted.
    const verboseTools: ToolDefinition[] = Array.from({ length: 30 }, (_, i) => ({
      type: 'function',
      function: {
        name: i === 0 ? 'bash' : `mcp__service__operation_${i}`,
        description: `Operation ${i}. ${'It does many detailed things. '.repeat(6)}`,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 4 }, (_, p) => [
              `parameter_${p}`,
              { type: 'string' },
            ]),
          ),
          required: ['parameter_0'],
        },
      },
    }));
    let body: {
      tools?: unknown[];
      messages: Array<{ role: string; content: string }>;
    } = { messages: [] };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          id: 'r',
          model: 'm',
          choices: [
            { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLocalOpenAICompatProvider({
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/onnx-community/gemma-4-E2B-it-ONNX',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: verboseTools,
      maxTokens: 128,
      isLocal: true,
      contextWindow: 32_768,
    });

    // Rendered tool share (~0.6x serialized) stays within half the content
    // budget so system + tools + messages fit under the worker's token guard;
    // the list shrank below the 12-tool count cap but kept the core tools.
    const serialized = JSON.stringify(body.tools || []).length;
    expect(Math.floor(serialized * 0.6)).toBeLessThanOrEqual(1500);
    expect((body.tools || []).length).toBeGreaterThanOrEqual(4);
    expect((body.tools || []).length).toBeLessThan(12);
    // The model is told the list was cut, so it won't deny real capabilities.
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('more tools exist');
  });

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

  test('vLLM Gemma provider uses native tools', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
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
    } satisfies Parameters<typeof callLocalOpenAICompatProvider>[0];

    const result = await callLocalOpenAICompatProvider(args);

    expect(result.choices[0]?.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body || '{}'),
    ) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.some((message) => message.role === 'tool')).toBe(true);
    expect(messages[1]).toHaveProperty('tool_calls');
  });

  test('vLLM provider surfaces native tool config errors without retry', async () => {
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
        model: 'vllm/example/plain-model',
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

  test('vLLM Gemma stream uses native tools', async () => {
    const deltas: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
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
    });

    expect(deltas).toEqual(['ok']);
    expect(result.choices[0]?.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  test('browser provider keeps compact prompts and emits tool calls', async () => {
    expect(
      estimateLocalOpenAICompatPromptOverheadTokens({
        provider: 'browser',
        model: 'browser/LiquidAI/LFM2.5-230M-ONNX',
        tools,
      }),
    ).toBe(0);

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(body.model).toBe('LiquidAI/LFM2.5-230M-ONNX');
      expect(body.tools).toEqual(toolsWithExamples);
      expect(body.tool_choice).toBe('auto');
      expect(body.hybridclaw_debug_model_responses).toBe(true);
      expect(messages).toEqual([
        {
          role: 'system',
          content:
            'You are HybridClaw, a concise helpful assistant. Answer directly. ' +
            'Use a tool only when it helps, and only tools that are explicitly ' +
            'listed — never invent tool or function names. If no listed tool ' +
            'fits, answer normally without a tool call.',
        },
        { role: 'user', content: 'old question' },
        {
          role: 'assistant',
          content: 'old answer',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'shell', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'tool result', tool_call_id: 'call_1' },
        { role: 'user', content: 'hello' },
      ]);
      expect(JSON.stringify(messages)).not.toContain('Full HybridClaw prompt');
      expect(JSON.stringify(messages)).not.toContain('List of tools:');
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'Working <|tool_call_start|>[tools.shell(command="ls -la")]<|tool_call_end|>',
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
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/LiquidAI/LFM2.5-230M-ONNX',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [
        { role: 'system', content: 'Full HybridClaw prompt' },
        { role: 'user', content: 'old question' },
        {
          role: 'assistant',
          content: 'old answer',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'shell', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'tool result', tool_call_id: 'call_1' },
        { role: 'user', content: 'hello' },
      ],
      tools,
      maxTokens: 128,
      debugModelResponses: true,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('Working');
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'shell',
          arguments: '{"command":"ls -la"}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('browser provider compacts large tool catalogs before sending to bridge', async () => {
    const largeTools: ToolDefinition[] = Array.from(
      { length: 80 },
      (_, index) => ({
        type: 'function',
        function: {
          name: index === 40 ? 'bash' : `tool_${index}`,
          description: `Tool ${index} ${'with a long description '.repeat(20)}`,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Array.from({ length: 24 }, (_unused, propertyIndex) => [
                `param_${propertyIndex}`,
                {
                  type: 'string',
                  description: `Parameter ${propertyIndex} ${'details '.repeat(20)}`,
                },
              ]),
            ),
            required: ['param_0', 'param_1'],
          },
        },
      }),
    );

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      const sentTools = body.tools as ToolDefinition[];
      expect(body.max_tokens).toBe(256);
      expect(sentTools.length).toBeLessThanOrEqual(64);
      expect(JSON.stringify(sentTools).length).toBeLessThanOrEqual(20_500);
      expect(sentTools[0]?.function.name).toBe('bash');
      expect(
        Object.keys(sentTools[0]?.function.parameters.properties || {}),
      ).toHaveLength(24);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'LiquidAI/LFM2.5-230M-ONNX',
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
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/LiquidAI/LFM2.5-230M-ONNX',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: baseMessages,
      tools: largeTools,
      maxTokens: 1024,
      isLocal: true,
      contextWindow: 32_768,
    });

    expect(result.choices[0]?.message.content).toBe('ok');
  });

  test('browser provider stream filters Liquid tool markup from visible deltas', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.tools).toEqual(toolsWithExamples);
        expect(body.tool_choice).toBe('auto');
        return makeEventStreamResponse([
          'data: {"id":"resp_1","model":"LiquidAI/LFM2.5-230M-ONNX","choices":[{"delta":{"content":"Thinking <|tool_call_start|>[tools."}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"shell(command=\\"pwd\\")]<|tool_call_end|>"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/LiquidAI/LFM2.5-230M-ONNX',
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

    expect(deltas).toEqual(['Thinking ']);
    expect(result.choices[0]?.message.content).toBe('Thinking');
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

  test('browser provider stream filters compact call-style tool markup', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.tools).toEqual(toolsWithExamples);
        expect(body.tool_choice).toBe('auto');
        return makeEventStreamResponse([
          'data: {"id":"resp_1","model":"LiquidAI/LFM2.5-230M-ONNX","choices":[{"delta":{"content":"Checking call:shell{command:"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"ls -la}"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }),
    );

    const result = await callLocalOpenAICompatProviderStream({
      provider: 'browser',
      baseUrl: 'http://127.0.0.1:8789/v1',
      apiKey: '',
      model: 'browser/LiquidAI/LFM2.5-230M-ONNX',
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

    expect(deltas).toEqual(['Checking ']);
    expect(result.choices[0]?.message.content).toBe('Checking');
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: '',
        type: 'function',
        function: {
          name: 'shell',
          arguments: '{"command":"ls -la"}',
        },
      },
    ]);
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
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
