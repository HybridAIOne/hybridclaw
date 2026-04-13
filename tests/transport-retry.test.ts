import { afterEach, expect, test, vi } from 'vitest';

async function importFreshTransportRetry() {
  vi.resetModules();

  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));

  const retry = await import('../src/utils/transport-retry.js');
  return { retry, warn };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/logger.js');
  vi.useRealTimers();
  vi.resetModules();
});

test('withTransportRetry uses extracted retry delays and logs attempts', async () => {
  vi.useFakeTimers();

  const { retry, warn } = await importFreshTransportRetry();
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error('transient'))
    .mockResolvedValueOnce('ok');

  const resultPromise = retry.withTransportRetry('test.transport', run, {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    isRetryable: () => true,
    extractRetryAfter: () => 250,
    logMessage: 'Transport failed; retrying',
  });

  await vi.advanceTimersByTimeAsync(249);
  expect(run).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  await expect(resultPromise).resolves.toBe('ok');
  expect(run).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'test.transport',
      attempt: 1,
      waitMs: 250,
    }),
    'Transport failed; retrying',
  );
});

test('withTransportRetry does not cap extracted retry delays', async () => {
  vi.useFakeTimers();

  const { retry, warn } = await importFreshTransportRetry();
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error('transient'))
    .mockResolvedValueOnce('ok');

  const resultPromise = retry.withTransportRetry('test.transport', run, {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 150,
    isRetryable: () => true,
    extractRetryAfter: () => 250,
    logMessage: 'Transport failed; retrying',
  });

  await vi.advanceTimersByTimeAsync(249);
  expect(run).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  await expect(resultPromise).resolves.toBe('ok');
  expect(run).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'test.transport',
      attempt: 1,
      waitMs: 250,
    }),
    'Transport failed; retrying',
  );
});

test('withTransportRetry caps exponential backoff at maxDelayMs', async () => {
  vi.useFakeTimers();

  const { retry, warn } = await importFreshTransportRetry();
  const error = new Error('still failing');
  const run = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error);

  const resultPromise = retry
    .withTransportRetry('test.transport', run, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 150,
      isRetryable: () => true,
      logMessage: 'Transport failed; retrying',
    })
    .then(
      (value: unknown) => ({ ok: true as const, value }),
      (caughtError: unknown) => ({ ok: false as const, error: caughtError }),
    );

  await vi.advanceTimersByTimeAsync(99);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(149);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await expect(resultPromise).resolves.toEqual({ ok: false, error });

  expect(run).toHaveBeenCalledTimes(3);
  expect(warn).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ waitMs: 100 }),
    'Transport failed; retrying',
  );
  expect(warn).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ waitMs: 150 }),
    'Transport failed; retrying',
  );
});

test('withTransportRetry fails fast on non-finite numeric config', async () => {
  const { retry } = await importFreshTransportRetry();

  await expect(
    retry.withTransportRetry('test.transport', async () => 'ok', {
      maxAttempts: Number.NaN,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      isRetryable: () => true,
    }),
  ).rejects.toThrow('Retry values must be finite numbers');
});

test('withTransportRetry fails fast on non-finite extracted retry delays', async () => {
  vi.useFakeTimers();

  const { retry } = await importFreshTransportRetry();
  const run = vi.fn().mockRejectedValueOnce(new Error('transient'));

  await expect(
    retry.withTransportRetry('test.transport', run, {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      isRetryable: () => true,
      extractRetryAfter: () => Number.POSITIVE_INFINITY,
    }),
  ).rejects.toThrow('Retry values must be finite numbers');
});

test('withTransportRetry does not retry non-retryable errors', async () => {
  const { retry, warn } = await importFreshTransportRetry();
  const error = new Error('not retryable');
  const run = vi.fn().mockRejectedValueOnce(error);

  await expect(
    retry.withTransportRetry('test.transport', run, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      isRetryable: () => false,
      logMessage: 'Transport failed; retrying',
    }),
  ).rejects.toThrow('not retryable');

  expect(run).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});
