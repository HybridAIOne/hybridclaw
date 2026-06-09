import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/providers/local-discovery.js');
  vi.doUnmock('../src/providers/local-health.js');
  vi.doUnmock('../src/providers/task-routing.js');
  vi.doUnmock('../src/providers/factory.js');
});

function setupProviderMocks({
  runtimeDefaultModel,
  activeRemoteProviders,
  activeLocalBackends,
  resolveTaskModelPolicy,
  resolveDefaultAuxiliaryModelForProvider,
  resolveModelRuntimeCredentials,
}: {
  runtimeDefaultModel?: string;
  activeRemoteProviders?: string[];
  activeLocalBackends?: Partial<Record<string, boolean>>;
  resolveTaskModelPolicy: ReturnType<typeof vi.fn>;
  resolveDefaultAuxiliaryModelForProvider?: ReturnType<typeof vi.fn>;
  resolveModelRuntimeCredentials: ReturnType<typeof vi.fn>;
}): void {
  if (runtimeDefaultModel !== undefined || activeRemoteProviders) {
    vi.doMock('../src/config/runtime-config.js', async () => {
      const actual = await vi.importActual<
        typeof import('../src/config/runtime-config.js')
      >('../src/config/runtime-config.js');
      return {
        ...actual,
        getRuntimeConfig: () => {
          const config = actual.getRuntimeConfig();
          const remoteProviders = [
            'anthropic',
            'openrouter',
            'mistral',
            'huggingface',
            'gemini',
            'deepseek',
            'xai',
            'zai',
            'kimi',
            'minimax',
            'dashscope',
            'xiaomi',
            'kilo',
          ] as const;
          if (activeRemoteProviders) {
            const active = new Set(activeRemoteProviders);
            for (const provider of remoteProviders) {
              config[provider].enabled = active.has(provider);
            }
          }
          return {
            ...config,
            hybridai: {
              ...config.hybridai,
              ...(runtimeDefaultModel !== undefined
                ? { defaultModel: runtimeDefaultModel }
                : {}),
            },
          };
        },
      };
    });
  }

  if (activeLocalBackends) {
    vi.doMock('../src/providers/local-health.js', () => ({
      localBackendsProbe: {
        get: async () =>
          new Map(
            Object.entries(activeLocalBackends).map(([backend, reachable]) => [
              backend,
              { backend, reachable },
            ]),
          ),
        peek: () => null,
        invalidate: vi.fn(),
      },
    }));
  }

  const remoteProviderKeys = [
    'anthropic',
    'openrouter',
    'codex',
    'mistral',
    'huggingface',
    'gemini',
    'deepseek',
    'xai',
    'zai',
    'kimi',
    'minimax',
    'dashscope',
    'xiaomi',
    'kilo',
  ];
  const activeRemoteSet = new Set(activeRemoteProviders ?? remoteProviderKeys);
  vi.doMock('../src/gateway/provider-status.js', () => ({
    buildGatewayProviderHealth: vi.fn(),
    getGatewayAdminProviderStatus: vi.fn(async () => {
      const status: Record<
        string,
        { kind: 'local' | 'remote'; reachable: boolean }
      > = {};
      for (const provider of remoteProviderKeys) {
        status[provider] = {
          kind: 'remote',
          reachable: activeRemoteSet.has(provider),
        };
      }
      for (const [backend, reachable] of Object.entries(
        activeLocalBackends ?? {},
      )) {
        status[backend] = { kind: 'local', reachable: Boolean(reachable) };
      }
      return status;
    }),
  }));
  vi.doMock('../src/providers/local-discovery.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/local-discovery.js')
    >('../src/providers/local-discovery.js');
    return {
      ...actual,
      discoverAllLocalModels: vi.fn(async () => []),
    };
  });

  vi.doMock('../src/providers/task-routing.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js');
    return {
      ...actual,
      resolveTaskModelPolicy,
      resolveDefaultAuxiliaryModelForProvider:
        resolveDefaultAuxiliaryModelForProvider ??
        actual.resolveDefaultAuxiliaryModelForProvider,
    };
  });
  vi.doMock('../src/providers/factory.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/factory.js')
    >('../src/providers/factory.js');
    return {
      ...actual,
      resolveModelRuntimeCredentials,
    };
  });
}

test('host auxiliary caller uses the configured compression task model', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    provider: 'lmstudio' as const,
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    requestHeaders: {},
    isLocal: true,
    model: 'lmstudio/qwen/qwen2.5-instruct',
    chatbotId: '',
    maxTokens: 321,
  }));
  const resolveModelRuntimeCredentials = vi.fn();
  setupProviderMocks({
    activeLocalBackends: { vllm: true },
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });
  const info = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      info,
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:1234/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'qwen/qwen2.5-instruct',
      });
      expect(body.max_tokens).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Compressed via auxiliary task model.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    fallbackModel: 'gpt-5-nano',
    fallbackChatbotId: 'bot_123',
    messages: [
      { role: 'system', content: 'Compress this conversation.' },
      { role: 'user', content: 'Here is the transcript.' },
    ],
  });

  expect(result).toEqual({
    provider: 'lmstudio',
    model: 'lmstudio/qwen/qwen2.5-instruct',
    content: 'Compressed via auxiliary task model.',
  });
  expect(resolveModelRuntimeCredentials).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      provider: 'lmstudio',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      messages: 2,
      tools: 0,
      maxTokens: undefined,
    }),
    '[aux-model] call start',
  );
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      provider: 'lmstudio',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      durationMs: expect.any(Number),
    }),
    '[aux-model] call success',
  );
});

test('host auxiliary caller falls back to resolved runtime credentials', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'vllm' as const,
    apiKey: '',
    baseUrl: 'http://127.0.0.1:8000/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: true,
    contextWindow: 32_768,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    activeLocalBackends: { vllm: true },
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'mistral-small',
      });
      expect(body.max_tokens).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Fallback compression response.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    fallbackModel: 'vllm/mistral-small',
    fallbackChatbotId: '',
    fallbackMaxTokens: 222,
    messages: [{ role: 'user', content: 'Summarize this.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/mistral-small',
    content: 'Fallback compression response.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith({
    model: 'vllm/mistral-small',
    chatbotId: '',
    enableRag: false,
    agentId: 'main',
  });
});

test('host auxiliary caller strips the HybridAI display prefix from request models', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: 'hybridai-key',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot_123',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    maxTokens: 2048,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://hybridai.one/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'gpt-5-nano',
        chatbot_id: 'bot_123',
        enable_rag: false,
        temperature: 0.1,
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'HybridAI cleanup response.',
              },
            },
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 8,
            total_tokens: 50,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'flush_memories',
    agentId: 'main',
    provider: 'hybridai',
    model: 'gpt-5-nano',
    fallbackChatbotId: 'bot_123',
    maxTokens: 2048,
    temperature: 0.1,
    messages: [{ role: 'user', content: 'Rewrite this memory.' }],
  });

  expect(result).toEqual({
    provider: 'hybridai',
    model: 'gpt-5-nano',
    content: 'HybridAI cleanup response.',
    usage: {
      inputTokens: 42,
      outputTokens: 8,
      totalTokens: 50,
    },
  });
});

test('host auxiliary caller avoids empty tools for HybridAI providers', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: 'hybridai-key',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot_123',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'HybridAI response without empty tools.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'session_title',
    provider: 'hybridai',
    model: 'Qwen/Qwen3.6-27B-FP8',
    fallbackChatbotId: 'bot_123',
    messages: [{ role: 'user', content: 'Name this session.' }],
  });

  expect(result).toEqual({
    provider: 'hybridai',
    model: 'Qwen/Qwen3.6-27B-FP8',
    content: 'HybridAI response without empty tools.',
  });
});

test('host auxiliary caller supports HybridAI-routed vendor model hints', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: 'hybridai-key',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot_123',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    maxTokens: 2048,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://hybridai.one/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'anthropic/claude-haiku-4-5',
        chatbot_id: 'bot_123',
        enable_rag: false,
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'HybridAI vendor model response.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    model: 'hybridai/anthropic/claude-haiku-4-5',
    fallbackChatbotId: 'bot_123',
    messages: [{ role: 'user', content: 'Summarize this.' }],
  });

  expect(result).toEqual({
    provider: 'hybridai',
    model: 'hybridai/anthropic/claude-haiku-4-5',
    content: 'HybridAI vendor model response.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith({
    model: 'hybridai/anthropic/claude-haiku-4-5',
    chatbotId: 'bot_123',
    enableRag: false,
    agentId: 'main',
  });
});

test('host auxiliary caller streams Codex responses for auxiliary tasks', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    apiKey: 'codex-key',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    chatbotId: '',
    enableRag: false,
    requestHeaders: { 'OpenAI-Beta': 'responses=experimental' },
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const streamBody = [
    'event: response.output_text.delta\r\n',
    'data: {"type":"response.output_text.delta","delta":"Clean"}\r\n\r\n',
    'event: response.output_text.delta\r\n',
    'data: {"type":"response.output_text.delta","delta":" memory"}\r\n\r\n',
    'event: response.completed\r\n',
    'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Clean memory"}]}],"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}\r\n\r\n',
  ].join('');
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://chatgpt.com/backend-api/codex/responses');
      const headers = new Headers(init?.headers);
      expect(headers.get('Accept')).toBe('text/event-stream, application/json');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.stream).toBe(true);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
      expect(body.temperature).toBeUndefined();
      expect(body.max_output_tokens).toBeUndefined();
      return new Response(streamBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'flush_memories',
    agentId: 'main',
    provider: 'openai-codex',
    model: 'gpt-5-codex',
    fallbackChatbotId: '',
    maxTokens: 2048,
    temperature: 0.1,
    messages: [{ role: 'user', content: 'Rewrite this memory.' }],
  });

  expect(result).toEqual({
    provider: 'openai-codex',
    model: 'openai-codex/gpt-5-codex',
    content: 'Clean memory',
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    },
  });
});

test('host auxiliary caller supports explicit provider overrides and max_completion_tokens retry', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: 'openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: { 'HTTP-Referer': 'https://example.test' },
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockImplementationOnce(async (input, init) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 77,
        temperature: 0.25,
        user: 'aux-test',
      });
      expect(body.max_completion_tokens).toBeUndefined();
      expect(Array.isArray(body.tools)).toBe(true);
      return new Response('unsupported_parameter: max_tokens', { status: 400 });
    })
    .mockImplementationOnce(async (input, init) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBe(77);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Explicit override response.',
              },
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

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    maxTokens: 77,
    temperature: 0.25,
    extraBody: { user: 'aux-test' },
    tools: [
      {
        type: 'function',
        function: {
          name: 'emit_summary',
          description: 'Emit a summary.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
    ],
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/anthropic/claude-sonnet-4',
    content: 'Explicit override response.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith({
    model: 'openrouter/anthropic/claude-sonnet-4',
    chatbotId: undefined,
    enableRag: false,
    agentId: undefined,
  });
});

test('host auxiliary caller uses OpenAI-compatible routing for xAI models', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'xai' as const,
    apiKey: 'xai-key',
    baseUrl: 'https://api.x.ai/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://api.x.ai/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'grok-3',
      });
      expect(body.chatbot_id).toBeUndefined();
      expect(body.enable_rag).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'xAI title response.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'session_title',
    agentId: 'main',
    provider: 'xai',
    model: 'grok-3',
    fallbackChatbotId: '',
    messages: [{ role: 'user', content: 'Title this session.' }],
  });

  expect(result).toEqual({
    provider: 'xai',
    model: 'xai/grok-3',
    content: 'xAI title response.',
  });
});

test('host auxiliary caller avoids empty tools for OpenAI-compatible providers', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'vllm' as const,
    apiKey: '',
    baseUrl: 'http://127.0.0.1:8000/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: true,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        return new Response('tools must not be an empty array', {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'vLLM response without empty tools.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'cv_narration',
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    messages: [{ role: 'user', content: 'Write one CV entry.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: 'vLLM response without empty tools.',
  });
});

test('host auxiliary caller avoids oversized max tokens for non-Anthropic OpenRouter models', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: 'openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    maxTokens: 65_535,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('google/gemini-2.5-flash-lite');
      if (body.max_tokens === 65_535) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                'This request requires more credits, or fewer max_tokens.',
              code: 402,
            },
          }),
          { status: 402 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'OpenRouter small-model response.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'cv_narration',
    provider: 'openrouter',
    model: 'openrouter/google/gemini-2.5-flash-lite',
    maxTokens: 65_535,
    messages: [{ role: 'user', content: 'Write one CV entry.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/google/gemini-2.5-flash-lite',
    content: 'OpenRouter small-model response.',
  });
});

test('host auxiliary caller honors requested max tokens for OpenRouter Anthropic models', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: 'openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.max_tokens).toBe(77);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Fallback max tokens response.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    maxTokens: 77,
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/anthropic/claude-sonnet-4',
    content: 'Fallback max tokens response.',
  });
});

test('host auxiliary caller falls back to 32000 max tokens for OpenRouter Anthropic models without request or discovery metadata', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: 'openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.max_tokens).toBe(32_000);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Fallback max tokens response.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/anthropic/claude-sonnet-4',
    content: 'Fallback max tokens response.',
  });
});

test('host auxiliary caller does not retry max_completion_tokens for unrelated unsupported parameters', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: 'openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    maxTokens: 48_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.max_tokens).toBe(77);
      expect(body.max_completion_tokens).toBeUndefined();
      return new Response('unsupported_parameter: tools', { status: 400 });
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');

  await expect(
    callAuxiliaryModel({
      task: 'compression',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      maxTokens: 77,
      tools: [
        {
          type: 'function',
          function: {
            name: 'emit_summary',
            description: 'Emit a summary.',
            parameters: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
        },
      ],
      messages: [{ role: 'user', content: 'Summarize this transcript.' }],
    }),
  ).rejects.toThrow(
    'Auxiliary provider call failed with 400: unsupported_parameter: tools',
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('host auxiliary caller falls back to the OpenRouter small model when task resolution fails', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: 'openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    activeRemoteProviders: ['openrouter'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('google/gemini-2.5-flash-lite');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered through OpenRouter fallback.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/google/gemini-2.5-flash-lite',
    content: 'Recovered through OpenRouter fallback.',
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      primaryProvider: 'auto',
      fallbackProvider: 'openrouter',
      modelHint: 'openrouter/google/gemini-2.5-flash-lite',
      primaryModelHint: 'anthropic/claude-3-7-sonnet',
      primaryError: expect.objectContaining({
        message: expect.any(String),
        type: expect.any(String),
      }),
    }),
    'Auxiliary provider resolution failed; using remote fallback',
  );
});

test('host auxiliary caller falls back remotely when a configured task model call times out', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    provider: 'hybridai' as const,
    baseUrl: 'https://hybrid.example',
    apiKey: 'hybrid-key',
    requestHeaders: {},
    isLocal: false,
    model: 'hybridai/anthropic/claude-haiku-4-5',
    chatbotId: 'bot_123',
    maxTokens: 1_200,
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('openrouter/google/gemini-2.5-flash-lite');
      return {
        provider: 'openrouter' as const,
        apiKey: 'openrouter-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 200_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['openrouter'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));

  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    )
    .mockImplementationOnce(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe('google/gemini-2.5-flash-lite');
        expect(body.max_tokens).toBeUndefined();
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Recovered after provider timeout.',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'cv_narration',
    agentId: 'main',
    maxTokens: 1_200,
    messages: [{ role: 'user', content: 'Write one CV entry.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/google/gemini-2.5-flash-lite',
    content: 'Recovered after provider timeout.',
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://hybrid.example/v1/chat/completions',
  );
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'openrouter/google/gemini-2.5-flash-lite',
    }),
  );
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'cv_narration',
      primaryProvider: 'hybridai',
      fallbackProvider: 'openrouter',
      modelHint: 'openrouter/google/gemini-2.5-flash-lite',
      primaryModelHint: 'hybridai/anthropic/claude-haiku-4-5',
      primaryError: expect.objectContaining({
        message: 'The operation was aborted due to timeout',
        type: 'TimeoutError',
      }),
    }),
    'Auxiliary provider call failed; using remote fallback',
  );
});

test('host auxiliary caller continues through remote fallback calls after a fallback timeout', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    provider: 'hybridai' as const,
    baseUrl: 'https://hybrid.example',
    apiKey: 'hybrid-key',
    requestHeaders: {},
    isLocal: false,
    model: 'hybridai/anthropic/claude-haiku-4-5',
    chatbotId: 'bot_123',
    maxTokens: 1_200,
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      if (model === 'openrouter/google/gemini-2.5-flash-lite') {
        return {
          provider: 'openrouter' as const,
          apiKey: 'openrouter-key',
          baseUrl: 'https://openrouter.ai/api/v1',
          chatbotId: '',
          enableRag: false,
          requestHeaders: {},
          agentId: 'main',
          isLocal: false,
          contextWindow: 200_000,
          thinkingFormat: undefined,
        };
      }
      if (model === 'anthropic/claude-haiku-4-5') {
        return {
          provider: 'anthropic' as const,
          apiKey: 'anthropic-key',
          baseUrl: 'https://api.anthropic.com/v1',
          chatbotId: '',
          enableRag: false,
          requestHeaders: {},
          agentId: 'main',
          isLocal: false,
          contextWindow: 200_000,
          thinkingFormat: undefined,
        };
      }
      throw new Error(`Provider is not configured for ${model}.`);
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['openrouter', 'anthropic'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));

  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    )
    .mockRejectedValueOnce(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    )
    .mockImplementationOnce(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('https://api.anthropic.com/v1/messages');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe('claude-haiku-4-5');
        expect(body.max_tokens).toBe(1_200);
        return new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: 'Recovered after second remote fallback.',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'cv_narration',
    agentId: 'main',
    maxTokens: 1_200,
    messages: [{ role: 'user', content: 'Write one CV entry.' }],
  });

  expect(result).toEqual({
    provider: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
    content: 'Recovered after second remote fallback.',
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://hybrid.example/v1/chat/completions',
  );
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    'https://openrouter.ai/api/v1/chat/completions',
  );
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'cv_narration',
      fallbackProvider: 'openrouter',
      modelHint: 'openrouter/google/gemini-2.5-flash-lite',
      error: expect.objectContaining({
        message: 'The operation was aborted due to timeout',
        type: 'TimeoutError',
      }),
    }),
    'Auxiliary fallback provider call failed; trying next fallback',
  );
});

test('host auxiliary caller preserves resolved task max tokens on provider-call fallback', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    provider: 'hybridai' as const,
    baseUrl: 'https://hybrid.example',
    apiKey: 'hybrid-key',
    requestHeaders: {},
    isLocal: false,
    model: 'hybridai/anthropic/claude-haiku-4-5',
    chatbotId: 'bot_123',
    maxTokens: 1_200,
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      if (model.startsWith('openrouter/') || model.startsWith('gemini/')) {
        throw new Error('Provider is not configured.');
      }
      expect(model).toBe('anthropic/claude-haiku-4-5');
      return {
        provider: 'anthropic' as const,
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 200_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['anthropic'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));

  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    )
    .mockImplementationOnce(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('https://api.anthropic.com/v1/messages');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe('claude-haiku-4-5');
        expect(body.max_tokens).toBe(1_200);
        return new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: 'Recovered with configured task max tokens.',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'cv_narration',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Write one CV entry.' }],
  });

  expect(result).toEqual({
    provider: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
    content: 'Recovered with configured task max tokens.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'anthropic/claude-haiku-4-5',
    }),
  );
});

test('host auxiliary caller falls through to Anthropic Haiku when OpenRouter fallback is unavailable', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      if (model.startsWith('openrouter/')) {
        throw new Error('OpenRouter provider is not configured.');
      }
      expect(model).toBe('anthropic/claude-haiku-4-5');
      return {
        provider: 'anthropic' as const,
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 1_000_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['openrouter', 'anthropic'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://api.anthropic.com/v1/messages');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('claude-haiku-4-5');
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'Recovered through Anthropic fallback.',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
    content: 'Recovered through Anthropic fallback.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      model: 'openrouter/google/gemini-2.5-flash-lite',
    }),
  );
  expect(resolveModelRuntimeCredentials).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      model: 'anthropic/claude-haiku-4-5',
    }),
  );
});

test('host auxiliary caller skips inactive remote fallback providers', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('anthropic/claude-haiku-4-5');
      return {
        provider: 'anthropic' as const,
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 1_000_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['anthropic'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://api.anthropic.com/v1/messages');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('claude-haiku-4-5');
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'Skipped inactive OpenRouter fallback.',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
    content: 'Skipped inactive OpenRouter fallback.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'anthropic/claude-haiku-4-5',
    }),
  );
});

test('host auxiliary caller falls through to Codex when OpenRouter and Anthropic are inactive', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('openai-codex/gpt-5.4-mini');
      return {
        provider: 'openai-codex' as const,
        apiKey: 'codex-key',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 200_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['codex'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://chatgpt.com/backend-api/codex/responses');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('gpt-5.4-mini');
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Recovered through Codex fallback.',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'openai-codex',
    model: 'openai-codex/gpt-5.4-mini',
    content: 'Recovered through Codex fallback.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'openai-codex/gpt-5.4-mini',
    }),
  );
});

test('host auxiliary caller falls through to Gemini when earlier remote fallbacks are inactive', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('gemini/gemini-2.5-flash-lite');
      return {
        provider: 'gemini' as const,
        apiKey: 'gemini-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 1_000_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['gemini'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      );
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('gemini-2.5-flash-lite');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered through Gemini fallback.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'gemini',
    model: 'gemini/gemini-2.5-flash-lite',
    content: 'Recovered through Gemini fallback.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'gemini/gemini-2.5-flash-lite',
    }),
  );
});

test('host auxiliary caller uses the session model after local and remote fallbacks are unavailable', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('openrouter/meta-llama/llama-3.1-8b-instruct');
      return {
        provider: 'openrouter' as const,
        apiKey: 'openrouter-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 200_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: [],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('meta-llama/llama-3.1-8b-instruct');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered through session model.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    fallbackModel: 'openrouter/meta-llama/llama-3.1-8b-instruct',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/meta-llama/llama-3.1-8b-instruct',
    content: 'Recovered through session model.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
});

test('host auxiliary caller falls through to Anthropic Haiku when earlier remote fallbacks are unavailable', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      if (model.startsWith('openrouter/') || model.startsWith('gemini/')) {
        throw new Error('Provider is not configured.');
      }
      expect(model).toBe('anthropic/claude-haiku-4-5');
      return {
        provider: 'anthropic' as const,
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 200_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeRemoteProviders: ['openrouter', 'gemini', 'anthropic'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://api.anthropic.com/v1/messages');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('anthropic-key');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('claude-haiku-4-5');
      expect(body.max_tokens).toBe(32_000);
      return new Response(
        JSON.stringify({
          content: [
            { type: 'text', text: 'Recovered through Haiku fallback.' },
          ],
          usage: {
            input_tokens: 11,
            output_tokens: 7,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
    content: 'Recovered through Haiku fallback.',
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    },
  });
});

test('host auxiliary caller tries discovered local fallback before openrouter without explicit fallback model', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn((provider: string) =>
    provider === 'vllm' ? 'Qwen/Qwen3.6-27B-FP8' : undefined,
  );
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('vllm/Qwen/Qwen3.6-27B-FP8');
      return {
        provider: 'vllm' as const,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8000/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: true,
        contextWindow: 128_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeLocalBackends: { vllm: true },
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  const debug = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug,
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('Qwen/Qwen3.6-27B-FP8');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered through discovered local fallback.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: 'Recovered through discovered local fallback.',
  });
  expect(resolveDefaultAuxiliaryModelForProvider).toHaveBeenCalledWith('vllm');
  expect(debug).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      primaryProvider: 'auto',
      fallbackProvider: 'vllm',
      modelHint: 'vllm/Qwen/Qwen3.6-27B-FP8',
      primaryError: expect.objectContaining({
        message: expect.any(String),
        type: expect.any(String),
      }),
    }),
    'Auxiliary provider resolution failed; using local model fallback',
  );
});

test('host auxiliary caller ignores unprefixed remote fallback models before local defaults', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveDefaultAuxiliaryModelForProvider = vi.fn((provider: string) =>
    provider === 'vllm' ? 'Qwen/Qwen3.6-27B-FP8' : undefined,
  );
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('vllm/Qwen/Qwen3.6-27B-FP8');
      return {
        provider: 'vllm' as const,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8000/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: true,
        contextWindow: 128_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeLocalBackends: { vllm: true },
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('Qwen/Qwen3.6-27B-FP8');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Ignored non-local fallback model.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    fallbackModel: 'gpt-5-nano',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: 'Ignored non-local fallback model.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
  expect(resolveModelRuntimeCredentials).not.toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'gpt-5-nano',
    }),
  );
});

test('host auxiliary caller ignores the main default model when ordering local aux fallbacks', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn((provider: string) => {
    if (provider === 'lmstudio') return 'lmstudio/nvidia/nemotron-3-nano';
    if (provider === 'vllm') return 'vllm/Qwen/Qwen3.6-27B-FP8';
    return undefined;
  });
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('vllm/Qwen/Qwen3.6-27B-FP8');
      return {
        provider: 'vllm' as const,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8000/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: true,
        contextWindow: 128_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    runtimeDefaultModel: 'vllm/Qwen/Qwen3.6-27B-FP8',
    activeLocalBackends: { lmstudio: true, vllm: true },
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  const debug = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug,
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('Qwen/Qwen3.6-27B-FP8');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered through local discovery order.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: 'Recovered through local discovery order.',
  });
  expect(resolveDefaultAuxiliaryModelForProvider).toHaveBeenNthCalledWith(
    1,
    'vllm',
  );
  expect(resolveDefaultAuxiliaryModelForProvider).toHaveBeenNthCalledWith(
    2,
    'lmstudio',
  );
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
  expect(debug).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      primaryProvider: 'auto',
      fallbackProvider: 'vllm',
      modelHint: 'vllm/Qwen/Qwen3.6-27B-FP8',
      primaryError: expect.objectContaining({
        message: expect.any(String),
        type: expect.any(String),
      }),
    }),
    'Auxiliary provider resolution failed; using local model fallback',
  );
});

test('host auxiliary caller skips inactive local fallback candidates', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn((provider: string) => {
    if (provider === 'lmstudio') return 'lmstudio/nvidia/nemotron-3-nano';
    if (provider === 'vllm') return 'vllm/Qwen/Qwen3.6-27B-FP8';
    return undefined;
  });
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('vllm/Qwen/Qwen3.6-27B-FP8');
      return {
        provider: 'vllm' as const,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8000/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: true,
        contextWindow: 128_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeLocalBackends: { lmstudio: false, vllm: true },
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('Qwen/Qwen3.6-27B-FP8');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Skipped inactive LM Studio fallback.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: 'Skipped inactive LM Studio fallback.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
});

test('host auxiliary caller prefers healthy local auto routing before remote fallback models', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => undefined);
  const resolveDefaultAuxiliaryModelForProvider = vi.fn((provider: string) =>
    provider === 'vllm' ? 'vllm/Qwen/Qwen3.6-27B-FP8' : undefined,
  );
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model: string }) => {
      expect(model).toBe('vllm/Qwen/Qwen3.6-27B-FP8');
      return {
        provider: 'vllm' as const,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8000/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: true,
        contextWindow: 128_000,
        thinkingFormat: undefined,
      };
    },
  );
  setupProviderMocks({
    activeLocalBackends: { vllm: true },
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('Qwen/Qwen3.6-27B-FP8');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Narrated through local vLLM first.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'cv_narration',
    agentId: 'main',
    fallbackModel: 'openrouter/anthropic/claude-sonnet-4',
    maxTokens: 1_200,
    messages: [{ role: 'user', content: 'Write one CV entry.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: 'Narrated through local vLLM first.',
  });
  expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(1);
});

test('host auxiliary caller prefers local model fallback when task resolution fails', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'vllm' as const,
    apiKey: '',
    baseUrl: 'http://127.0.0.1:8000/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: true,
    contextWindow: 128_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    activeLocalBackends: { vllm: true },
    resolveTaskModelPolicy,
    resolveModelRuntimeCredentials,
  });
  const debug = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug,
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('Qwen/Qwen3.6-27B-FP8');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered through local fallback.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    fallbackModel: 'vllm/Qwen/Qwen3.6-27B-FP8',
    messages: [{ role: 'user', content: 'Summarize this transcript.' }],
  });

  expect(result).toEqual({
    provider: 'vllm',
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: 'Recovered through local fallback.',
  });
  expect(debug).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      primaryProvider: 'auto',
      fallbackProvider: 'vllm',
      modelHint: 'vllm/Qwen/Qwen3.6-27B-FP8',
      primaryError: expect.objectContaining({
        message: expect.any(String),
        type: expect.any(String),
      }),
    }),
    'Auxiliary provider resolution failed; using local model fallback',
  );
});

test('host auxiliary caller uses fixed OpenRouter small fallback instead of failed model hints', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'hybridai/anthropic/claude-haiku-4-5',
    error: 'HybridAI provider is unavailable.',
  }));
  const resolveDefaultAuxiliaryModelForProvider = vi.fn(() => undefined);
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: 'openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  }));
  setupProviderMocks({
    activeRemoteProviders: ['openrouter'],
    resolveTaskModelPolicy,
    resolveDefaultAuxiliaryModelForProvider,
    resolveModelRuntimeCredentials,
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body.model).toBe('google/gemini-2.5-flash-lite');
      expect(body.max_tokens).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered through OpenRouter fallback.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const result = await callAuxiliaryModel({
    task: 'cv_narration',
    agentId: 'main',
    maxTokens: 1_200,
    messages: [{ role: 'user', content: 'Write one CV entry.' }],
  });

  expect(result).toEqual({
    provider: 'openrouter',
    model: 'openrouter/google/gemini-2.5-flash-lite',
    content: 'Recovered through OpenRouter fallback.',
  });
});
