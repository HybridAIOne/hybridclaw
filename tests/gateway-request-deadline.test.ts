import { beforeEach, expect, test, vi } from 'vitest';
import { ExecutionDeadlineError } from '../packages/shared/src/execution-deadline.js';
import {
  registerActiveGatewayRequest,
  resolveGatewayRequestContext,
} from '../src/gateway/gateway-request-runtime.js';
import { useCleanMocks } from './test-utils.js';

vi.mock('../src/agent/executor.js', () => ({ stopSessionExecution: vi.fn() }));
const releases: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
useCleanMocks({
  cleanup: () => {
    for (const release of releases.splice(0)) release();
    vi.useRealTimers();
  },
});
function register(options: Parameters<typeof registerActiveGatewayRequest>[0]) {
  const request = registerActiveGatewayRequest(options);
  releases.push(request.release);
  return request;
}

test('the registry owns one budget across preparation and alias lookups', async () => {
  const deadline = Date.now() + 1000;
  const request = register({
    sessionId: 'parent',
    executionSessionId: 'worker',
    executionDeadlineAtMs: deadline,
    maxWallClockMs: 2000,
  });
  expect(request.executionDeadlineAtMs).toBe(deadline);
  expect(resolveGatewayRequestContext('worker')).toMatchObject({
    sessionId: 'parent',
    executionDeadlineAtMs: deadline,
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(request.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(request.signal.reason).toBeInstanceOf(ExecutionDeadlineError);
  expect(resolveGatewayRequestContext('worker')).toBeNull();
});

test('ambiguous live deadlines cannot grant a fresh child lease', () => {
  register({
    sessionId: 'parent',
    executionSessionId: 'worker',
    executionDeadlineAtMs: Date.now() + 1000,
  });
  register({
    sessionId: 'parent',
    executionSessionId: 'worker',
    executionDeadlineAtMs: Date.now() + 2000,
  });
  expect(resolveGatewayRequestContext('worker')).toBeNull();
});

test('releasing the request removes its timer without aborting a later turn', async () => {
  const first = register({ sessionId: 'parent', maxWallClockMs: 100 });
  first.release();
  expect(vi.getTimerCount()).toBe(0);
  const next = register({ sessionId: 'parent' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(first.signal.aborted).toBe(false);
  expect(next.signal.aborted).toBe(false);
});

test('long accepted bounds do not overflow Node timers into immediate cancellation', async () => {
  const duration = 2 ** 31 + 1000;
  const request = register({
    sessionId: 'parent',
    executionDeadlineAtMs: Date.now() + duration,
  });
  await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
  expect(request.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1001);
  expect(request.signal.reason).toBeInstanceOf(ExecutionDeadlineError);
});

test('expired initial requests abort immediately and no-header requests keep defaults', () => {
  expect(
    register({ sessionId: 'expired', executionDeadlineAtMs: Date.now() }).signal
      .aborted,
  ).toBe(true);
  expect(
    register({ sessionId: 'ordinary' }).executionDeadlineAtMs,
  ).toBeUndefined();
});
