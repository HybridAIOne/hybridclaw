import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/providers/task-routing.js');
  vi.doUnmock('../src/providers/factory.js');
});

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
  vi.doMock('../src/providers/task-routing.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js');
    return {
      ...actual,
      resolveTaskModelPolicy,
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

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:1234/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'qwen/qwen2.5-instruct',
        max_tokens: 321,
      });
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
  vi.doMock('../src/providers/task-routing.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js');
    return {
      ...actual,
      resolveTaskModelPolicy,
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

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'mistral-small',
        max_tokens: 222,
      });
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
    thinkingFormat: undefined,
  }));
  vi.doMock('../src/providers/task-routing.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js');
    return {
      ...actual,
      resolveTaskModelPolicy,
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
    thinkingFormat: undefined,
  }));
  vi.doMock('../src/providers/task-routing.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js');
    return {
      ...actual,
      resolveTaskModelPolicy,
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

test('host auxiliary caller falls back to openrouter when task resolution fails', async () => {
  const resolveTaskModelPolicy = vi.fn(async () => ({
    model: 'anthropic/claude-3-7-sonnet',
    error: 'Anthropic provider is not implemented yet.',
  }));
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
  vi.doMock('../src/providers/task-routing.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js');
    return {
      ...actual,
      resolveTaskModelPolicy,
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
      expect(body.model).toBe('anthropic/claude-3-7-sonnet');
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
    model: 'openrouter/anthropic/claude-3-7-sonnet',
    content: 'Recovered through OpenRouter fallback.',
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'compression',
      primaryProvider: 'auto',
      fallbackProvider: 'openrouter',
      modelHint: 'anthropic/claude-3-7-sonnet',
      primaryError: expect.any(Error),
    }),
    'Auxiliary provider resolution failed; using OpenRouter fallback',
  );
});
