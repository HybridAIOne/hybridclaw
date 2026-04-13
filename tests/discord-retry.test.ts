import { afterEach, expect, test, vi } from 'vitest';

async function importFreshDiscordRetry() {
  vi.resetModules();

  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));

  const retry = await import('../src/channels/discord/retry.js');
  return { retry, warn };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/logger.js');
  vi.useRealTimers();
  vi.resetModules();
});

test('withDiscordRetry honors retryAfter headers before succeeding', async () => {
  vi.useFakeTimers();

  const { retry, warn } = await importFreshDiscordRetry();
  const run = vi
    .fn()
    .mockRejectedValueOnce({ status: 429, retryAfter: 0.05 })
    .mockResolvedValueOnce('ok');

  const resultPromise = retry.withDiscordRetry('discord.send', run);

  await vi.advanceTimersByTimeAsync(49);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(resultPromise).resolves.toBe('ok');

  expect(run).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'discord.send',
      attempt: 1,
      waitMs: 50,
    }),
    'Discord API call failed; retrying',
  );
});
