import { afterEach, expect, test, vi } from 'vitest';

import { logger } from '../src/logger.js';
import { createDiscoveryStore } from '../src/providers/utils.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferredState() {
  let resolve!: (state: { models: string[] }) => void;
  const promise = new Promise<{ models: string[] }>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('discovery store caches error fallbacks until the TTL expires', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-27T12:00:00Z'));

  const store = createDiscoveryStore({ models: [] as string[] }, 60_000);
  const fetchFreshState = vi.fn(async () => {
    throw new Error('provider unavailable');
  });
  const onError = vi.fn((_err: unknown, staleState: { models: string[] }) => ({
    ...staleState,
    models: ['stale-model'],
  }));

  await expect(store.discover(fetchFreshState, { onError })).resolves.toEqual({
    models: ['stale-model'],
  });
  await expect(store.discover(fetchFreshState, { onError })).resolves.toEqual({
    models: ['stale-model'],
  });

  expect(fetchFreshState).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);

  vi.setSystemTime(new Date('2026-04-27T12:01:01Z'));
  await store.discover(fetchFreshState, { onError });

  expect(fetchFreshState).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
});

test('discovery store can skip caching an error fallback', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-27T12:00:00Z'));

  const store = createDiscoveryStore({ models: [] as string[] }, 60_000);
  const fetchFreshState = vi.fn(async () => {
    throw new Error('provider unavailable');
  });
  const onError = vi.fn((_err: unknown, staleState: { models: string[] }) => ({
    _tag: 'update' as const,
    state: {
      ...staleState,
      models: ['uncached-fallback'],
    },
    skipCache: true,
  }));

  await expect(store.discover(fetchFreshState, { onError })).resolves.toEqual({
    models: ['uncached-fallback'],
  });
  await expect(store.discover(fetchFreshState, { onError })).resolves.toEqual({
    models: ['uncached-fallback'],
  });

  expect(fetchFreshState).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledTimes(2);
});

test('an expired cache answers at once and refreshes once in the background', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-27T12:00:00Z'));
  const store = createDiscoveryStore({ models: [] as string[] }, 60_000);
  await store.discover(async () => ({ models: ['model-a'] }));
  vi.setSystemTime(new Date('2026-04-27T12:01:01Z'));
  const fresh = deferredState();
  const fetchFreshState = vi.fn(() => fresh.promise);

  await expect(store.discover(fetchFreshState)).resolves.toEqual({
    models: ['model-a'],
  });
  await expect(store.discover(fetchFreshState)).resolves.toEqual({
    models: ['model-a'],
  });
  expect(fetchFreshState).toHaveBeenCalledTimes(1);

  fresh.resolve({ models: ['model-b'] });
  await vi.waitFor(() =>
    expect(store.getState()).toEqual({ models: ['model-b'] }),
  );
  await expect(store.discover(fetchFreshState)).resolves.toEqual({
    models: ['model-b'],
  });
  expect(fetchFreshState).toHaveBeenCalledTimes(1);
});

test.each([
  { name: 'an empty store', primed: false, force: false },
  { name: 'a forced refresh', primed: true, force: true },
])('$name waits for the fetch', async ({ primed, force }) => {
  const store = createDiscoveryStore({ models: [] as string[] }, 60_000);
  if (primed) await store.discover(async () => ({ models: ['model-a'] }));
  const fresh = deferredState();
  let settled = false;
  const discovery = store
    .discover(() => fresh.promise, { force })
    .finally(() => {
      settled = true;
    });

  await Promise.resolve();
  expect(settled).toBe(false);
  fresh.resolve({ models: ['model-b'] });
  await expect(discovery).resolves.toEqual({ models: ['model-b'] });
});

test('a background refresh whose error handler throws is logged, not left unhandled', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-27T12:00:00Z'));
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const store = createDiscoveryStore({ models: [] as string[] }, 60_000);
  await store.discover(async () => ({ models: ['model-a'] }));
  vi.setSystemTime(new Date('2026-04-27T12:01:01Z'));

  await expect(
    store.discover(
      async () => {
        throw new Error('provider unavailable');
      },
      {
        onError: () => {
          throw new Error('error handler failed');
        },
      },
    ),
  ).resolves.toEqual({ models: ['model-a'] });

  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  expect(store.getState()).toEqual({ models: ['model-a'] });
});
