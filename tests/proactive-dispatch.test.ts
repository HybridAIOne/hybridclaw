import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';
import { deliverProactiveMessage, sendProactiveMessageNow } from '../src/gateway/proactive-dispatch.js';
import { useCleanMocks } from './test-utils.js';

const state = vi.hoisted(() => ({
  config: {} as typeof DEFAULT_RUNTIME_CONFIG,
  activeHours: true,
  enqueue: vi.fn(() => ({ queued: 1, dropped: 0 })),
  sendSignal: vi.fn(async () => undefined),
}));
vi.mock('../src/config/config.js', () => ({
  getConfigSnapshot: () => state.config,
  PROACTIVE_QUEUE_OUTSIDE_HOURS: true,
}));
vi.mock('../src/agent/proactive-policy.js', () => ({
  isWithinActiveHours: () => state.activeHours,
  proactiveWindowLabel: () => 'test window',
}));
vi.mock('../src/memory/db.js', () => ({ enqueueProactiveMessage: state.enqueue }));
vi.mock('../src/channels/signal/runtime.js', () => ({ sendToSignalChat: state.sendSignal }));
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

useCleanMocks({ restoreAllMocks: true });
beforeEach(() => {
  state.config = structuredClone(DEFAULT_RUNTIME_CONFIG);
  state.config.signal.enabled = true;
  state.config.signal.daemonUrl = 'http://127.0.0.1:8080';
  state.config.signal.account = '+14155551212';
  state.activeHours = true;
  state.enqueue.mockClear();
  state.sendSignal.mockReset();
});

describe('proactive dispatch boundary', () => {
  test('delivers a Signal target through its sender', async () => {
    expect(await deliverProactiveMessage('  signal:+14155551212  ', 'hello', 'delegate')).toEqual({ status: 'delivered' });
    expect(state.sendSignal).toHaveBeenCalledWith('signal:+14155551212', 'hello');
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  test.each([true, false])('rejects unknown, malformed, and unsupported targets with active hours %s', async activeHours => {
    state.activeHours = activeHours;
    for (const target of ['unknown', 'signal:invalid', 'signal', 'msteams', '19:conversation@thread.tacv2', 'voice:CA1234567890abcdef', 'web', 'heartbeat', '']) {
      expect(await deliverProactiveMessage(target, 'hello', 'delegate')).toMatchObject({ status: 'failed' });
      expect(await sendProactiveMessageNow(target, 'hello', 'delegate')).toMatchObject({ status: 'failed' });
    }
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.sendSignal).not.toHaveBeenCalled();
  });

  test('queues only the explicit local pull target during immediate delivery', async () => {
    expect(await sendProactiveMessageNow('  tui  ', 'hello', 'delegate')).toEqual({ status: 'queued' });
    expect(state.enqueue).toHaveBeenCalledWith('tui', 'hello', 'delegate', expect.any(Number));
  });

  test('queues a valid Signal target outside active hours', async () => {
    state.activeHours = false;
    expect(await deliverProactiveMessage('signal:+14155551212', 'hello', 'delegate')).toMatchObject({ status: 'queued' });
    expect(state.enqueue).toHaveBeenCalledWith('signal:+14155551212', 'hello', 'delegate', expect.any(Number));
    expect(state.sendSignal).not.toHaveBeenCalled();
  });

  test('reports missing Signal configuration without falling back to a local queue', async () => {
    state.config.signal.enabled = false;
    expect(await deliverProactiveMessage('signal:+14155551212', 'hello', 'delegate')).toMatchObject({ status: 'failed', reason: expect.any(String) });
    expect(state.sendSignal).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  test('reports sender failures without marking delivery successful or queueing locally', async () => {
    state.sendSignal.mockRejectedValueOnce(new Error('transport unavailable'));
    expect(await deliverProactiveMessage('signal:+14155551212', 'hello', 'delegate')).toEqual({ status: 'failed', reason: 'transport unavailable' });
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  test('A2A local mode blocks Signal delivery and retains TUI pull delivery', async () => {
    state.config.deployment.a2a_local_mode = true;
    expect(await deliverProactiveMessage('signal:+14155551212', 'hello', 'delegate')).toMatchObject({ status: 'suppressed' });
    expect(await sendProactiveMessageNow('signal:+14155551212', 'hello', 'delegate')).toMatchObject({ status: 'suppressed' });
    expect(state.sendSignal).not.toHaveBeenCalled();
    expect(await deliverProactiveMessage('unknown', 'hello', 'delegate')).toMatchObject({ status: 'failed' });
    expect(await sendProactiveMessageNow('unknown', 'hello', 'delegate')).toMatchObject({ status: 'failed' });
    expect(await deliverProactiveMessage('tui', 'hello', 'delegate')).toMatchObject({ status: 'queued' });
  });
});
