import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const liveWorkers = new Set<string>();
const stopSessionExecution = vi.fn((sessionId: string) =>
  liveWorkers.delete(sessionId),
);

vi.mock('../src/agent/executor.js', () => ({ stopSessionExecution }));

const { gatewaySessionQueue, releaseSessionWorker } = await import(
  '../src/gateway/session-worker-release.js'
);

useCleanMocks();

beforeEach(() => {
  liveWorkers.clear();
  stopSessionExecution.mockClear();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

test.each([
  ['a session with an idle worker', true, true],
  ['an unknown session', false, false],
])('releasing %s stops right away', async (_label, hasWorker, stopped) => {
  if (hasWorker) liveWorkers.add('call-a');

  await expect(releaseSessionWorker('call-a')).resolves.toBe(stopped);
  expect(stopSessionExecution).toHaveBeenCalledExactlyOnceWith('call-a');
});

test('a running turn finishes and keeps its result before the worker stops', async () => {
  liveWorkers.add('call-a');
  let finishTurn: (value: string) => void = () => {};
  const turn = gatewaySessionQueue.run(
    'call-a',
    () =>
      new Promise<string>((resolve) => {
        finishTurn = resolve;
      }),
  );

  const release = releaseSessionWorker('call-a');
  await flush();
  expect(stopSessionExecution).not.toHaveBeenCalled();
  expect(liveWorkers.has('call-a')).toBe(true);

  finishTurn('stored reply');
  await expect(turn).resolves.toBe('stored reply');
  await expect(release).resolves.toBe(true);
  expect(stopSessionExecution).toHaveBeenCalledExactlyOnceWith('call-a');
});

test('a turn in another session does not delay the release', async () => {
  liveWorkers.add('call-a');
  let finishOther: () => void = () => {};
  const otherTurn = gatewaySessionQueue.run(
    'call-b',
    () =>
      new Promise<void>((resolve) => {
        finishOther = resolve;
      }),
  );

  await expect(releaseSessionWorker('call-a')).resolves.toBe(true);
  finishOther();
  await otherTurn;
});

test('releasing twice stops the worker once', async () => {
  liveWorkers.add('call-a');

  const results = await Promise.all([
    releaseSessionWorker('call-a'),
    releaseSessionWorker('call-a'),
  ]);

  expect(results).toEqual([true, false]);
  expect(liveWorkers.size).toBe(0);
});
