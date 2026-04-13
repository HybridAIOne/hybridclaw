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

test('withDiscordRetry honors retryAfter delays above the backoff cap', async () => {
  vi.useFakeTimers();

  const { retry, warn } = await importFreshDiscordRetry();
  const run = vi
    .fn()
    .mockRejectedValueOnce({ status: 429, retryAfter: 10 })
    .mockResolvedValueOnce('ok');

  const resultPromise = retry.withDiscordRetry('discord.send', run);

  await vi.advanceTimersByTimeAsync(9_999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(resultPromise).resolves.toBe('ok');

  expect(run).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'discord.send',
      attempt: 1,
      waitMs: 10_000,
    }),
    'Discord API call failed; retrying',
  );
});

test('withDiscordRetry retries 5xx errors using jitter when no retryAfter is present', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.4);

  const { retry, warn } = await importFreshDiscordRetry();
  const run = vi
    .fn()
    .mockRejectedValueOnce({ status: 503 })
    .mockResolvedValueOnce('ok');

  const resultPromise = retry.withDiscordRetry('discord.send', run);

  await vi.advanceTimersByTimeAsync(599);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(resultPromise).resolves.toBe('ok');

  expect(run).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'discord.send',
      attempt: 1,
      waitMs: 600,
    }),
    'Discord API call failed; retrying',
  );
});

test('withDiscordRetry does not retry non-429 4xx errors', async () => {
  const { retry, warn } = await importFreshDiscordRetry();
  const error = { status: 400 };
  const run = vi.fn().mockRejectedValueOnce(error);

  await expect(retry.withDiscordRetry('discord.send', run)).rejects.toBe(error);

  expect(run).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

test('withDiscordRetry propagates the last retryable error after max attempts', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);

  const { retry, warn } = await importFreshDiscordRetry();
  const error = { status: 503 };
  const run = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error);

  const resultPromise = retry.withDiscordRetry('discord.send', run).then(
    (value: unknown) => ({ ok: true as const, value }),
    (caughtError: unknown) => ({ ok: false as const, error: caughtError }),
  );

  await vi.advanceTimersByTimeAsync(499);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await expect(resultPromise).resolves.toEqual({ ok: false, error });

  expect(run).toHaveBeenCalledTimes(3);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ attempt: 1, waitMs: 500 }),
    'Discord API call failed; retrying',
  );
  expect(warn).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ attempt: 2, waitMs: 1000 }),
    'Discord API call failed; retrying',
  );
});
