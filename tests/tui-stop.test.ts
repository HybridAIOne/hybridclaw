import { expect, test, vi } from 'vitest';

import { stopTuiRun } from '../src/tui-stop.js';

test('stopTuiRun reuses an in-flight stop request after aborting locally', async () => {
  const abortController = new AbortController();
  let resolveStop!: (value: string) => void;
  const requestStop = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveStop = resolve;
      }),
  );
  const clearStopRequest = vi.fn();

  const first = stopTuiRun({
    abortController,
    stopRequest: null,
    requestStop,
    clearStopRequest,
  });
  const second = stopTuiRun({
    abortController,
    stopRequest: first,
    requestStop,
    clearStopRequest,
  });

  expect(first).toBeTruthy();
  expect(second).toBe(first);
  expect(abortController.signal.aborted).toBe(true);
  expect(requestStop).toHaveBeenCalledTimes(1);

  resolveStop('stopped');
  await first;
  await Promise.resolve();
  expect(clearStopRequest).toHaveBeenCalledTimes(1);
});

test('stopTuiRun ignores inactive foreground requests', () => {
  const requestStop = vi.fn(async () => 'stopped');

  expect(
    stopTuiRun({
      abortController: null,
      stopRequest: null,
      requestStop,
      clearStopRequest: () => {},
    }),
  ).toBeNull();
  expect(requestStop).not.toHaveBeenCalled();
});
