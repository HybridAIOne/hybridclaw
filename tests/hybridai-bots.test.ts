import os from 'node:os';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;

async function importFreshBots() {
  vi.resetModules();
  return import('../src/providers/hybridai-bots.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_HYBRIDAI_API_KEY === undefined) {
    delete process.env.HYBRIDAI_API_KEY;
  } else {
    process.env.HYBRIDAI_API_KEY = ORIGINAL_HYBRIDAI_API_KEY;
  }
});

test('fetchHybridAIBots preserves upstream auth error details', async () => {
  process.env.HOME = os.homedir();
  process.env.HYBRIDAI_API_KEY = 'hai-bot-test';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 401,
              message: 'Invalid API key provided',
              type: 'authentication_error',
            },
          }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        ),
    ),
  );

  const { HybridAIBotFetchError, fetchHybridAIBots } = await importFreshBots();

  await expect(fetchHybridAIBots()).rejects.toMatchObject({
    name: 'HybridAIBotFetchError',
    message: 'Invalid API key provided',
    status: 401,
    code: 401,
    type: 'authentication_error',
  });
  await expect(fetchHybridAIBots()).rejects.toBeInstanceOf(
    HybridAIBotFetchError,
  );
});

test('fetchHybridAIBots logs and preserves nested transport failure details', async () => {
  process.env.HOME = os.homedir();
  process.env.HYBRIDAI_API_KEY = 'hai-bot-test';

  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:5000'),
      });
    }),
  );

  const { HybridAIBotFetchError, fetchHybridAIBots } = await importFreshBots();

  await expect(fetchHybridAIBots()).rejects.toMatchObject({
    name: 'HybridAIBotFetchError',
    message: 'fetch failed (connect ECONNREFUSED 127.0.0.1:5000)',
    status: 0,
    type: 'network_error',
  });
  await expect(fetchHybridAIBots()).rejects.toBeInstanceOf(
    HybridAIBotFetchError,
  );
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      err: expect.any(TypeError),
      url: expect.stringContaining('/api/v1/bot-management/bots'),
    }),
    'HybridAI bot fetch failed before receiving a response',
  );
});
