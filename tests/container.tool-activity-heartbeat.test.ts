import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { withToolActivityHeartbeat } from '../container/src/tool-activity-heartbeat.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('emits activity while the tool is running and stops once it resolves', async () => {
  const emit = vi.fn();
  let finish: (value: string) => void = () => {};
  const run = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );

  const promise = withToolActivityHeartbeat(run, emit, 1_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(emit).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(3_500);
  expect(emit).toHaveBeenCalledTimes(3);

  finish('done');
  await expect(promise).resolves.toBe('done');

  await vi.advanceTimersByTimeAsync(5_000);
  expect(emit).toHaveBeenCalledTimes(3);
});

test('stops the heartbeat when the tool rejects', async () => {
  const emit = vi.fn();
  let fail: (error: Error) => void = () => {};
  const promise = withToolActivityHeartbeat(
    () =>
      new Promise<never>((_resolve, reject) => {
        fail = reject;
      }),
    emit,
    1_000,
  );

  await vi.advanceTimersByTimeAsync(1_000);
  expect(emit).toHaveBeenCalledTimes(1);

  fail(new Error('tool failed'));
  await expect(promise).rejects.toThrow('tool failed');

  await vi.advanceTimersByTimeAsync(5_000);
  expect(emit).toHaveBeenCalledTimes(1);
});
