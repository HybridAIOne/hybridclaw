import { beforeEach, expect, test, vi } from 'vitest';
import { callAuxiliaryModel } from '../src/providers/auxiliary.js';
import { captureRoutingTrace } from '../src/usage/routing-trace.js';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({ logger: mocks }));
vi.mock('../src/providers/task-routing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/task-routing.js')>()),
  isAuxiliaryTaskDisabled: () => false,
  resolveDefaultAuxiliaryModelForProvider: () => undefined,
  resolveTaskModelPolicy: async () => ({
    provider: 'openrouter',
    model: 'openrouter/primary',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    chatbotId: '',
  }),
}));
vi.mock('../src/gateway/provider-status.js', () => ({
  getGatewayAdminProviderStatus: async () => ({
    openrouter: { reachable: true },
    anthropic: { reachable: true },
  }),
}));
vi.mock('../src/providers/local-health.js', () => ({
  localBackendsProbe: { get: async () => new Map(), peek: () => null },
}));
vi.mock('../src/providers/local-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/providers/local-discovery.js')
  >()),
  discoverAllLocalModels: async () => [],
}));
vi.mock('../src/providers/factory.js', () => ({
  resolveModelProvider: () => 'openrouter',
  resolveModelRuntimeCredentials: async ({ model }: { model: string }) => ({
    provider: model.startsWith('anthropic/') ? 'anthropic' : 'openrouter',
    model,
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    chatbotId: '',
    enableRag: false,
    isLocal: false,
  }),
}));

useCleanMocks({ unstubAllGlobals: true });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
});

const params = {
  task: 'session_title' as const,
  messages: [{ role: 'user' as const, content: 'Help me deploy' }],
};

function reply(content: string | null): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

test.each([null, '', ' \n\t '])(
  'uses a fallback for empty content %j and records the failed attempt',
  async (content) => {
    mocks.fetch
      .mockResolvedValueOnce(reply(content))
      .mockResolvedValueOnce(reply(' Deploy Plan '));

    const { result, trace } = await captureRoutingTrace(() =>
      callAuxiliaryModel(params),
    );

    expect(result).toMatchObject({ content: 'Deploy Plan' });
    expect(result.model).not.toBe('openrouter/primary');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(trace.attempts.map((attempt) => attempt.status)).toEqual([
      'error',
      'success',
    ]);
    expect(
      mocks.info.mock.calls.filter(
        (call) => call[1] === '[aux-model] call success',
      ),
    ).toHaveLength(1);
  },
);

test('continues past an empty fallback reply', async () => {
  mocks.fetch
    .mockResolvedValueOnce(reply(''))
    .mockResolvedValueOnce(reply(''))
    .mockResolvedValueOnce(
      Response.json({ content: [{ type: 'text', text: 'Deploy Plan' }] }),
    );

  const result = await callAuxiliaryModel(params);

  expect(result).toMatchObject({
    provider: 'anthropic',
    content: 'Deploy Plan',
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
});

test('fails after exhausting empty fallback replies', async () => {
  mocks.fetch.mockImplementation(async () => reply(''));

  await expect(callAuxiliaryModel(params)).rejects.toThrow(
    'Fallback chain failed',
  );
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
});

test.each([
  { allowFallback: false },
  { provider: 'openrouter' as const, model: 'openrouter/primary' },
])(
  'respects fallback restrictions %j for an empty reply',
  async (restriction) => {
    mocks.fetch.mockResolvedValueOnce(reply(''));

    await expect(
      callAuxiliaryModel({ ...params, ...restriction }),
    ).rejects.toThrow('session_title returned an empty response.');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  },
);

test('returns a nonempty primary reply without falling back', async () => {
  mocks.fetch.mockResolvedValueOnce(reply(' Deploy Plan '));

  await expect(callAuxiliaryModel(params)).resolves.toMatchObject({
    model: 'openrouter/primary',
    content: 'Deploy Plan',
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
