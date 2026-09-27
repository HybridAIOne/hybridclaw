import { expect, test, vi } from 'vitest';

import {
  haltIfShuttingDown,
  startShutdown,
} from '../container/src/shutdown-latch.js';

test('shutdown runs its teardown once and parks later work even if teardown fails', async () => {
  await expect(haltIfShuttingDown()).resolves.toBeUndefined();

  const teardown = vi.fn(() => Promise.reject(new Error('teardown failed')));
  const shutdown = startShutdown(teardown);
  shutdown.catch(() => {});
  expect(startShutdown(teardown)).toBe(shutdown);
  expect(teardown).toHaveBeenCalledTimes(1);

  const resumed = vi.fn();
  void haltIfShuttingDown().then(resumed, resumed);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(resumed).not.toHaveBeenCalled();
});
