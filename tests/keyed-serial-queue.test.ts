import { describe, expect, test } from 'vitest';
import { KeyedSerialQueue } from '../src/utils/keyed-serial-queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('KeyedSerialQueue', () => {
  test('serializes tasks with the same key in arrival order', async () => {
    const queue = new KeyedSerialQueue();
    const firstGate = deferred();
    const events: string[] = [];

    const first = queue.run('shared-session', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = queue.run('shared-session', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  test('allows different keys to run concurrently', async () => {
    const queue = new KeyedSerialQueue();
    const gate = deferred();
    const events: string[] = [];

    const first = queue.run('session-a', async () => {
      events.push('a');
      await gate.promise;
    });
    const second = queue.run('session-b', async () => {
      events.push('b');
      await gate.promise;
    });

    await Promise.resolve();
    expect(events).toEqual(['a', 'b']);
    gate.resolve();
    await Promise.all([first, second]);
  });

  test('releases the next task when the current task rejects', async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];

    const first = queue.run('shared-session', async () => {
      events.push('first');
      throw new Error('failed turn');
    });
    const second = queue.run('shared-session', async () => {
      events.push('second');
      return 'completed';
    });

    await expect(first).rejects.toThrow('failed turn');
    await expect(second).resolves.toBe('completed');
    expect(events).toEqual(['first', 'second']);
  });
});
