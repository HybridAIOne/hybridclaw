import { expect, test, vi } from 'vitest';

import { createDiscoveryStore } from '../src/providers/utils.js';

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
  expect(onError).toHaveBeenCalledTimes(2);
});
