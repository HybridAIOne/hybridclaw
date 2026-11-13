import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({ delay: vi.fn(async (_ms: number) => {}) }));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});
beforeEach(() => {
  mocks.delay.mockReset();
  vi.stubEnv('HYBRIDCLAW_RETRY_BASE_DELAY_MS', '100');
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_ATTEMPTS', '3');
});

test.each(['vision', 'web_extract', 'compression', 'eval_judge'] as const)(
  'an overridden %s helper cannot renew an expired parent budget',
  async (task) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { callAuxiliaryModel } = await import(
      '../container/src/providers/auxiliary.js'
    );
    const params = {
      taskModels: {
        [task]: {
          provider: 'openrouter' as const,
          model: 'openrouter/example/helper',
          apiKey: 'test-key',
          baseUrl: 'https://example.com/helper',
          chatbotId: '',
        },
      },
      fallbackContext: {
        provider: 'openrouter' as const,
        baseUrl: 'https://example.com/v1',
        model: 'openrouter/example/primary',
        apiKey: 'test-key',
        chatbotId: '',
        executionDeadlineAtMs: Date.now() - 1,
      },
    };
    const result =
      task === 'vision'
        ? callAuxiliaryModel({
            ...params,
            task,
            question: 'Describe synthetic pixels.',
            imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
          })
        : callAuxiliaryModel({
            ...params,
            task,
            messages: [{ role: 'user', content: 'Read synthetic notes.' }],
          });
    await expect(result).rejects.toThrow('deadline exceeded');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.delay).not.toHaveBeenCalled();
  },
);

test('expiry during auxiliary backoff prevents a second model request', async () => {
  const deadline = Date.now() + 1000;
  const fetch = vi.fn(async () => {
    throw new TypeError('fetch failed');
  });
  vi.stubGlobal('fetch', fetch);
  mocks.delay.mockImplementationOnce(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
  });
  const { callAuxiliaryModel } = await import(
    '../container/src/providers/auxiliary.js'
  );
  await expect(
    callAuxiliaryModel({
      task: 'web_extract',
      messages: [{ role: 'user', content: 'Read synthetic notes.' }],
      fallbackContext: {
        provider: 'openrouter',
        baseUrl: 'https://example.com/v1',
        model: 'openrouter/example/primary',
        apiKey: 'test-key',
        chatbotId: '',
        executionDeadlineAtMs: deadline,
      },
    }),
  ).rejects.toThrow('deadline exceeded');
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.delay).toHaveBeenCalledOnce();
});
