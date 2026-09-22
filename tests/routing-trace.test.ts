import { describe, expect, it, vi } from 'vitest';
import { parseRoutingTrace } from '../src/types/routing-trace.js';
import { captureRoutingTrace, finishRoutingTraceAttempt, startRoutingTraceAttempt } from '../src/usage/routing-trace.js';

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata: (model: string) => ({ zone: model === 'local' ? 'local' : 'cloud', pricingUsdPerToken: model === 'priced' ? { input: 0.001, output: 0.002 } : { input: null, output: null } }),
}));

it('keeps concurrent turns separate and includes retries and auxiliary overhead', async () => {
  const [first, second] = await Promise.all([
    captureRoutingTrace(async () => {
      const attempt = startRoutingTraceAttempt('priced', 'auxiliary', 'concierge');
      await Promise.resolve();
      finishRoutingTraceAttempt({ model: 'priced', attempt, status: 'success', durationMs: 4, inputTokens: 2, outputTokens: 1 });
      startRoutingTraceAttempt('local');
      finishRoutingTraceAttempt({ model: 'local', status: 'error', durationMs: 10 });
      startRoutingTraceAttempt('priced');
      finishRoutingTraceAttempt({ model: 'priced', status: 'success', durationMs: 20, inputTokens: 3, outputTokens: 2, costUsd: 0.1 });
    }),
    captureRoutingTrace(async () => { startRoutingTraceAttempt('other'); }),
  ]);
  expect(first.trace.attempts).toHaveLength(3);
  expect(first.trace.attempts[0]).toMatchObject({ costUsd: 0.004, costSource: 'estimated', totalTokens: 3 });
  expect(first.trace.attempts[1]).toMatchObject({ zone: 'local', costUsd: null, costSource: 'unknown', totalTokens: null });
  expect(first.trace.attempts[2]).toMatchObject({ costUsd: 0.1, costSource: 'reported' });
  expect(second.trace.attempts.map((a) => a.model)).toEqual(['other']);
  expect(parseRoutingTrace(JSON.stringify(first.trace))).toEqual(first.trace);
});

it('does not mutate already emitted progress or collect detached work after completion', async () => {
  const progress = vi.fn();
  let later: () => void = () => {};
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { trace } = await captureRoutingTrace(async () => {
    startRoutingTraceAttempt('priced');
    finishRoutingTraceAttempt({ model: 'priced', status: 'success', durationMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    later = finish;
    void pending.then(() => startRoutingTraceAttempt('late'));
  }, progress);
  later();
  await pending;
  expect(progress.mock.calls[0][0].attempts[0].status).toBe('running');
  expect(trace.attempts).toHaveLength(1);
  expect(trace.attempts[0]).toMatchObject({ costUsd: 0, costSource: 'reported' });
});

describe('stored trace boundary', () => {
  it.each(['bad json', 'null', '{"version":2}', '{"version":1,"status":"complete","mode":"direct","durationMs":0,"attempts":[null]}'])('ignores invalid metadata: %s', (raw) => expect(parseRoutingTrace(raw)).toBeNull());
});
