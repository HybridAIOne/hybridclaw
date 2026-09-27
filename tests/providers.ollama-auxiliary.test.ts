import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/providers/local-discovery.js');
  vi.doUnmock('../src/providers/local-health.js');
  vi.doUnmock('../src/gateway/provider-status.js');
  vi.doUnmock('../src/providers/task-routing.js');
  vi.doUnmock('../src/providers/factory.js');
});

// Ollama reloads a model whenever a request's num_ctx differs from the loaded
// one, so auxiliary calls must send the window the agent loop sends.
test.each<[string, number | null]>([
  ['a discovered model', 16_384],
  ['an undiscovered model', null],
])('auxiliary Ollama calls for %s send the agent loop window', async (_label, discoveredWindow) => {
  vi.doMock('../src/providers/local-health.js', () => ({
    localBackendsProbe: {
      get: async () =>
        new Map([['ollama', { backend: 'ollama', reachable: true }]]),
      peek: () => null,
      invalidate: vi.fn(),
    },
  }));
  vi.doMock('../src/gateway/provider-status.js', () => ({
    buildGatewayProviderHealth: vi.fn(),
    getGatewayAdminProviderStatus: vi.fn(async () => ({
      ollama: { kind: 'local', reachable: true },
    })),
  }));
  vi.doMock('../src/providers/local-discovery.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/local-discovery.js')
    >('../src/providers/local-discovery.js');
    return {
      ...actual,
      discoverAllLocalModels: vi.fn(async () => []),
      getLocalModelInfo: vi.fn((model: string) =>
        discoveredWindow !== null && model.endsWith('qwen3')
          ? { id: 'qwen3', backend: 'ollama', contextWindow: discoveredWindow }
          : null,
      ),
    };
  });
  vi.doMock('../src/providers/task-routing.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js');
    return { ...actual, resolveTaskModelPolicy: vi.fn(async () => undefined) };
  });
  vi.doMock('../src/providers/factory.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/factory.js')
    >('../src/providers/factory.js');
    return {
      ...actual,
      resolveModelRuntimeCredentials: vi.fn(async () => ({
        provider: 'ollama' as const,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: true,
        contextWindow: discoveredWindow ?? 32_768,
      })),
    };
  });
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body || '{}')));
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  const { defaultOllamaContextWindow } = await import(
    '../src/providers/local-discovery.js'
  );
  const result = await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    fallbackModel: 'ollama/qwen3',
    fallbackChatbotId: '',
    fallbackMaxTokens: 128,
    messages: [{ role: 'user', content: 'Summarize this.' }],
  });

  expect(result.content).toBe('ok');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.options).toMatchObject({
    num_ctx: discoveredWindow ?? defaultOllamaContextWindow(),
    num_predict: 128,
  });
});
