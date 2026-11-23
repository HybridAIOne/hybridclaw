import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/providers/task-routing.js');
  vi.doUnmock('../src/providers/factory.js');
});

function mockCredentials(provider: 'hybridai' | 'openrouter'): void {
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
      provider,
      apiKey: 'test-key',
      baseUrl:
        provider === 'hybridai'
          ? 'https://hybridai.example.com'
          : 'https://openrouter.example.com/api/v1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: { 'X-Existing': 'kept' },
      agentId: 'main',
      isLocal: false,
      contextWindow: 200_000,
      thinkingFormat: undefined,
    })),
  }));
}

async function sentHeaders(
  provider: 'hybridai' | 'openrouter',
  ids: { sessionId?: string; agentId?: string },
): Promise<Headers> {
  mockCredentials(provider);
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'A title' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
  await callAuxiliaryModel({
    task: 'session_title',
    provider,
    model: provider === 'hybridai' ? 'gpt-5-nano' : 'openrouter/test-model',
    allowFallback: false,
    messages: [{ role: 'user', content: 'Name this session.' }],
    ...ids,
  });
  const init = fetchMock.mock.calls.at(-1)?.[1];
  return new Headers(init?.headers);
}

test('a helper call names its conversation to HybridAI', async () => {
  const headers = await sentHeaders('hybridai', {
    sessionId: 'main-0123456789abcdef-hy',
    agentId: 'hy',
  });

  expect(headers.get('X-HybridClaw-Session-Id')).toBe(
    'main-0123456789abcdef-hy',
  );
  expect(headers.get('X-HybridClaw-Agent-Id')).toBe('hy');
  expect(headers.get('X-Existing')).toBe('kept');
  expect(headers.get('Authorization')).toBe('Bearer test-key');
});

test('a helper call outside a conversation sends no session id', async () => {
  const headers = await sentHeaders('hybridai', { agentId: 'hy' });

  expect(headers.get('X-HybridClaw-Session-Id')).toBeNull();
  expect(headers.get('X-HybridClaw-Agent-Id')).toBe('hy');
});

test('correlation headers go to HybridAI only', async () => {
  const headers = await sentHeaders('openrouter', {
    sessionId: 'main-0123456789abcdef-hy',
    agentId: 'hy',
  });

  expect(headers.get('X-HybridClaw-Session-Id')).toBeNull();
  expect(headers.get('X-HybridClaw-Agent-Id')).toBeNull();
  expect(headers.get('X-Existing')).toBe('kept');
});
