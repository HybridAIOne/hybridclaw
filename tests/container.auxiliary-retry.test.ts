import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({ delay: vi.fn(async (_ms: number) => {}) }));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));
useCleanMocks({
  restoreAllMocks: true,
  unstubAllGlobals: true,
  unstubAllEnvs: true,
  resetModules: true,
});
beforeEach(() => {
  mocks.delay.mockReset();
  vi.stubEnv('HYBRIDCLAW_RETRY_ENABLED', 'true');
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_ATTEMPTS', '3');
  vi.stubEnv('HYBRIDCLAW_RETRY_BASE_DELAY_MS', '100');
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_DELAY_MS', '400');
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

const fallbackContext = {
  provider: 'openrouter' as const,
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'openrouter/example/vision-model',
  chatbotId: '',
};
const reply = (finishReason = 'stop') =>
  Response.json({
    id: 'response-fixture',
    choices: [
      {
        message: { role: 'assistant', content: 'Verified content.' },
        finish_reason: finishReason,
      },
    ],
  });
async function invoke(task: 'vision' | 'web_extract' = 'vision') {
  const { callAuxiliaryModel } = await import(
    '../container/src/providers/auxiliary.js'
  );
  return task === 'vision'
    ? callAuxiliaryModel({
        task,
        fallbackContext,
        question: 'Describe the image.',
        imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      })
    : callAuxiliaryModel({
        task,
        fallbackContext,
        messages: [
          { role: 'user', content: 'Summarize the supplied release notes.' },
        ],
      });
}

test.each(['vision', 'web_extract'] as const)(
  'retries a transient %s failure with the same request and model',
  async (task) => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetch);
    const result = await invoke(task);
    expect(result.model).toBe(fallbackContext.model);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
    expect(mocks.delay.mock.calls.map((args) => args[0])).toEqual([100]);
  },
);

test('bounds repeated temporary failures and caps exponential backoff', async () => {
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_ATTEMPTS', '6');
  const fetch = vi.fn(
    async () => new Response('Temporary overload', { status: 503 }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(invoke()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(mocks.delay.mock.calls.map((args) => args[0])).toEqual([
    100, 200, 400, 400, 400,
  ]);
});

test.each([400, 401, 402, 403, 413])(
  'does not retry permanent provider status %i',
  async (status) => {
    const fetch = vi.fn(
      async () => new Response('Request rejected', { status }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(invoke()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.delay).not.toHaveBeenCalled();
  },
);

test.each([
  ['retry-after', '7', 7000],
  ['retry-after-ms', '250', 250],
] as const)(
  'honors %s without changing the requested model',
  async (header, value, delay) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Rate limited', {
          status: 429,
          headers: { [header]: value },
        }),
      )
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetch);
    await expect(invoke()).resolves.toMatchObject({
      analysis: 'Verified content.',
    });
    expect(mocks.delay.mock.calls.map((args) => args[0])).toEqual([delay]);
  },
);

test('does not wait when the provider asks beyond the existing retry bound', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('Rate limited', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(invoke()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.delay).not.toHaveBeenCalled();
});

test.each([
  { HYBRIDCLAW_RETRY_ENABLED: 'false' },
  { HYBRIDCLAW_RETRY_MAX_ATTEMPTS: '1' },
])('respects existing retry settings %j', async (settings) => {
  for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value);
  const fetch = vi.fn(async () => {
    throw new TypeError('fetch failed');
  });
  vi.stubGlobal('fetch', fetch);
  await expect(invoke()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.delay).not.toHaveBeenCalled();
});

test('does not retry or accept a truncated analysis', async () => {
  const fetch = vi.fn(async () => reply('length'));
  vi.stubGlobal('fetch', fetch);
  await expect(invoke()).rejects.toThrow('analysis is incomplete');
  expect(fetch).toHaveBeenCalledOnce();
});

test.each(['before call', 'during backoff'] as const)(
  'does not start another auxiliary request after shutdown %s',
  async (phase) => {
    const { callAuxiliaryModel } = await import(
      '../container/src/providers/auxiliary.js'
    );
    const { startShutdown } = await import(
      '../container/src/shutdown-latch.js'
    );
    const shutdown = () => {
      void startShutdown(() => new Promise<never>(() => {}));
    };
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetch);
    if (phase === 'before call') shutdown();
    else mocks.delay.mockImplementationOnce(async () => shutdown());
    const completed = vi.fn();
    void callAuxiliaryModel({
      task: 'vision',
      fallbackContext,
      question: 'Describe the image.',
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    }).then(completed, completed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(phase === 'before call' ? 0 : 1);
    expect(mocks.delay).toHaveBeenCalledTimes(phase === 'before call' ? 0 : 1);
    expect(completed).not.toHaveBeenCalled();
  },
);

test.each(['web_extract', 'compression'] as const)(
  'a retried %s call preserves its task override, tool schemas and explicit budget',
  async (task) => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetch);
    const { callAuxiliaryModel } = await import(
      '../container/src/providers/auxiliary.js'
    );
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'collect_fact',
          description: 'Record a synthetic fact',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const messages = [
      { role: 'user' as const, content: 'Summarize the supplied records.' },
    ];
    const result = await callAuxiliaryModel({
      task,
      fallbackContext,
      messages,
      tools,
      maxTokens: 64,
      taskModels: {
        [task]: {
          provider: 'openrouter',
          baseUrl: 'https://example.com/helper/v1',
          apiKey: 'test-auxiliary-key',
          model: 'openrouter/example/selected-model',
          chatbotId: '',
          maxTokens: 128,
        },
      },
    });
    expect(result.model).toBe('openrouter/example/selected-model');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    expect(fetch.mock.calls[0][0]).toBe(
      'https://example.com/helper/v1/chat/completions',
    );
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toMatchObject({
      model: 'example/selected-model',
      messages,
      tools,
      max_tokens: 64,
    });
  },
);

test('an aborted helper request is not retried', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValue(new DOMException('Operation aborted', 'AbortError'));
  vi.stubGlobal('fetch', fetch);
  await expect(invoke()).rejects.toThrow('Operation aborted');
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.delay).not.toHaveBeenCalled();
});
