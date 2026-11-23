import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/gateway/provider-status.js');
  vi.doUnmock('../src/providers/local-discovery.js');
  vi.doUnmock('../src/providers/task-routing.js');
  vi.doUnmock('../src/providers/factory.js');
});

function mockHybridAIRuntime(): void {
  vi.doMock('../src/gateway/provider-status.js', () => ({
    buildGatewayProviderHealth: vi.fn(),
    getGatewayAdminProviderStatus: vi.fn(async () => ({})),
  }));
  vi.doMock('../src/providers/local-discovery.js', async () => ({
    ...(await vi.importActual<
      typeof import('../src/providers/local-discovery.js')
    >('../src/providers/local-discovery.js')),
    discoverAllLocalModels: vi.fn(async () => []),
  }));
  vi.doMock('../src/providers/task-routing.js', async () => ({
    ...(await vi.importActual<
      typeof import('../src/providers/task-routing.js')
    >('../src/providers/task-routing.js')),
    resolveTaskModelPolicy: vi.fn(async () => undefined),
  }));
  vi.doMock('../src/providers/factory.js', async () => ({
    ...(await vi.importActual<typeof import('../src/providers/factory.js')>(
      '../src/providers/factory.js',
    )),
    resolveModelRuntimeCredentials: vi.fn(async () => ({
      provider: 'hybridai' as const,
      apiKey: 'test-key',
      baseUrl: 'https://hybridai.example.com',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: false,
      contextWindow: 200_000,
      maxTokens: 1024,
      thinkingFormat: undefined,
    })),
  }));
}

test.each([
  undefined,
  0,
  0.1,
])('auxiliary HybridAI calls send no adaptive thinking (temperature %s)', async (temperature) => {
  mockHybridAIRuntime();
  let sentBody: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );

  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  await callAuxiliaryModel({
    task: 'compression',
    agentId: 'main',
    model: 'hybridai/anthropic/claude-sonnet-5',
    messages: [{ role: 'user', content: 'Summarize this.' }],
    temperature,
  });

  expect(sentBody).not.toHaveProperty('thinking');
  expect(sentBody.temperature).toBe(temperature);
});
