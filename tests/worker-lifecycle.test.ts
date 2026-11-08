import { expect, test, vi } from 'vitest';
import { WorkerLifecycle } from '../src/infra/worker-lifecycle.js';
import { WarmProcessPool } from '../src/infra/warm-process-pool.js';
import { removeWarmPoolEntry } from '../src/infra/warm-runner-utils.js';

const activity = () => ({ lastActivityMs: 0, notify: vi.fn() });

test('a spare is claimed once and cannot execute before it has an owner', () => {
  const worker = new WorkerLifecycle(null);
  expect(() => worker.begin('request', activity())).toThrow();
  worker.claim('session');
  expect(() => worker.claim('other')).toThrow();
  worker.begin('request', activity());
  expect(() => worker.begin('other', activity())).toThrow();
  expect(worker.owner).toEqual({ kind: 'session', sessionId: 'session' });
});

test('readiness does not release an executing request and stale finalizers cannot release its successor', () => {
  const worker = new WorkerLifecycle('session');
  const progress = activity();
  worker.begin('first', progress);
  worker.ready(100);
  expect(worker.phase).toBe('executing');
  expect(progress.notify).toHaveBeenCalledOnce();
  expect(worker.finish('first')).toBe(true);
  worker.begin('second', activity());
  expect(worker.finish('first')).toBe(false);
  expect(worker.phase).toBe('executing');
});

test.each(['stop', 'exit'] as const)('late readiness and completion cannot resurrect a worker after %s', (event) => {
  const worker = new WorkerLifecycle('session');
  worker.begin('request', activity());
  if (event === 'stop') worker.stop();
  else worker.exit('failed');
  worker.ready(100);
  expect(worker.finish('request')).toBe(true);
  expect(worker.reusable).toBe(false);
  expect(worker.stop()).toBe(false);
  expect(() => worker.begin('next', activity())).toThrow();
  expect(worker.activity).toBeUndefined();
});

test('an old worker exit removes only that worker, not its replacement', () => {
  const config = { enabled: true, coldStartBudgetMs: 200, trafficWindowMs: 60_000, minIdlePerActiveAgent: 0, maxIdlePerAgent: 1, memoryPressureRssBytes: 0 };
  const spare = new WarmProcessPool(config);
  const previous = { id: 'old', agentId: 'agent_a', lastUsedAt: 0, stop: vi.fn() };
  const replacement = { ...previous, id: 'new' };
  const active = new Map([['session', replacement]]);
  removeWarmPoolEntry(active, spare, previous);
  expect(active.get('session')).toBe(replacement);
});
