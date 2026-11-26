import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';
import { deliverProactiveMessage, sendProactiveMessageNow } from '../src/gateway/proactive-dispatch.js';
import { useCleanMocks } from './test-utils.js';

const state = vi.hoisted(() => ({
  config: {} as typeof DEFAULT_RUNTIME_CONFIG,
  activeHours: true,
  enqueue: vi.fn(() => ({ queued: 1, dropped: 0 })),
  sendSignal: vi.fn(async () => undefined),
  deliverWeb: vi.fn(() => ({ status: 'delivered' as const, messageId: 7 })),
  mainChat: vi.fn((agentId: string) => ({ id: `main:${agentId}` })),
  sendTeams: vi.fn(async () => ({ status: 'delivered' as const })),
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
vi.mock('../src/channels/msteams/proactive.js', () => ({ sendProactive: state.sendTeams }));
vi.mock('../src/gateway/web-scheduled-delivery.js', () => ({ agentMainChatForWebTarget: state.mainChat, deliverWebScheduledMessage: state.deliverWeb }));
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
  state.deliverWeb.mockReset().mockReturnValue({ status: 'delivered', messageId: 7 });
  state.mainChat.mockReset().mockImplementation((agentId: string) => ({ id: `main:${agentId}` }));
  state.sendTeams.mockReset().mockResolvedValue({ status: 'delivered' });
});

describe('proactive dispatch boundary', () => {
  test('delivers a Signal target through its sender', async () => {
    expect(await deliverProactiveMessage('  signal:+14155551212  ', 'hello', 'delegate')).toEqual({ status: 'delivered' });
    expect(state.sendSignal).toHaveBeenCalledWith('signal:+14155551212', 'hello');
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  test.each([true, false])('stores a bare web target in the default agent main chat at once with active hours %s', async activeHours => {
    state.activeHours = activeHours;
    expect(await deliverProactiveMessage('  web  ', 'hello web', 'heartbeat')).toMatchObject({ status: 'delivered' });
    expect(state.mainChat).toHaveBeenCalledWith('main');
    expect(state.deliverWeb).toHaveBeenCalledWith('main:main', 'hello web', 'heartbeat', undefined);
    // A queued `web` row has no agent or chat, so web output is never queued.
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  test('fails a bare web target explicitly when the agent has no main chat', async () => {
    state.mainChat.mockImplementation(() => { throw new Error('Agent "main" has no main web chat to deliver to.'); });
    expect(await deliverProactiveMessage('web', 'hello', 'heartbeat')).toEqual({ status: 'failed', reason: 'Agent "main" has no main web chat to deliver to.' });
    expect(state.deliverWeb).not.toHaveBeenCalled();
  });

  test('delivers a Teams conversation target through its proactive sender', async () => {
    expect(await deliverProactiveMessage('19:conversation@thread.tacv2', 'hello teams', 'schedule:1')).toEqual({ status: 'delivered' });
    expect(state.sendTeams).toHaveBeenCalledWith('19:conversation@thread.tacv2', 'hello teams', 'schedule:1', undefined);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  test.each([true, false])('rejects unknown, malformed, and unsupported targets with active hours %s', async activeHours => {
    state.activeHours = activeHours;
    for (const target of ['unknown', 'signal:invalid', 'signal', 'msteams', 'voice:CA1234567890abcdef', 'a2a', 'a2a:peer-1', 'heartbeat', '']) {
      expect(await deliverProactiveMessage(target, 'hello', 'delegate')).toMatchObject({ status: 'failed' });
      expect(await sendProactiveMessageNow(target, 'hello', 'delegate')).toMatchObject({ status: 'failed' });
    }
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.sendSignal).not.toHaveBeenCalled();
    expect(state.deliverWeb).not.toHaveBeenCalled();
    expect(state.sendTeams).not.toHaveBeenCalled();
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

  test('immediate sends bypass quiet hours and heartbeat suppression', async () => {
    state.activeHours = false;
    expect(await sendProactiveMessageNow('signal:+14155551212', 'HEARTBEAT_OK', 'heartbeat')).toEqual({ status: 'delivered' });
    expect(state.sendSignal).toHaveBeenCalledOnce();
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  test('policy delivery suppresses heartbeat acknowledgements after validating the target', async () => {
    expect(await deliverProactiveMessage('signal:+14155551212', 'HEARTBEAT_OK', 'heartbeat')).toMatchObject({ status: 'suppressed' });
    expect(await deliverProactiveMessage('unknown', 'HEARTBEAT_OK', 'heartbeat')).toMatchObject({ status: 'failed' });
    expect(state.sendSignal).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
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

  test('A2A local mode blocks external channel delivery and retains TUI and local web delivery', async () => {
    state.config.deployment.a2a_local_mode = true;
    expect(await deliverProactiveMessage('signal:+14155551212', 'hello', 'delegate')).toMatchObject({ status: 'suppressed' });
    expect(await sendProactiveMessageNow('signal:+14155551212', 'hello', 'delegate')).toMatchObject({ status: 'suppressed' });
    expect(await deliverProactiveMessage('19:conversation@thread.tacv2', 'hello', 'delegate')).toMatchObject({ status: 'suppressed' });
    expect(state.sendSignal).not.toHaveBeenCalled();
    expect(state.sendTeams).not.toHaveBeenCalled();
    expect(await deliverProactiveMessage('unknown', 'hello', 'delegate')).toMatchObject({ status: 'failed' });
    expect(await sendProactiveMessageNow('unknown', 'hello', 'delegate')).toMatchObject({ status: 'failed' });
    expect(await deliverProactiveMessage('tui', 'hello', 'delegate')).toMatchObject({ status: 'queued' });
    expect(await deliverProactiveMessage('web', 'hello', 'delegate')).toMatchObject({ status: 'delivered' });
  });
});
