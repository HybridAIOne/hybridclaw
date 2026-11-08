import { expect, test, vi } from 'vitest';
import { KeyedSerialQueue } from '../src/utils/keyed-serial-queue.js';

test('a stale lease cannot release a later task or bypass its queued successor', async () => {
  const queue = new KeyedSerialQueue();
  const releaseFirst = await queue.acquire('shared');
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const second = queue.run('shared', async () => {
    entered();
    await pending;
  });
  const thirdTask = vi.fn(async () => {});
  const third = queue.run('shared', thirdTask);
  try {
    await queue.run('independent', async () => {});
    expect(thirdTask).not.toHaveBeenCalled();
    releaseFirst();
    await started;
    releaseFirst();
    await queue.run('independent', async () => {});
    expect(thirdTask).not.toHaveBeenCalled();
  } finally {
    releaseFirst();
    finish();
    await Promise.all([second, third]);
  }
  expect(thirdTask).toHaveBeenCalledOnce();
});
