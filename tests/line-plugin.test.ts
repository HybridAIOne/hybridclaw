import { afterEach, expect, test, vi } from 'vitest';
import type {
  ChannelTransportInstance,
  ChannelTransportRegistration,
  HybridClawPluginApi,
  ChannelTransportHost,
} from '../src/plugins/plugin-sdk.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test('register and create stay lazy until the transport is used', async () => {
  const instance: ChannelTransportInstance = {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendMedia: vi.fn(async () => {}),
  };
  const createLineTransport = vi.fn(() => instance);
  vi.doMock('../plugins/line/src/transport.js', () => ({
    createLineTransport,
  }));

  const registered: ChannelTransportRegistration[] = [];
  const plugin = (await import('../plugins/line/src/index.js')).default;
  plugin.register({
    runtime: { homeDir: '/tmp/unused' },
    registerChannelTransport(transport: ChannelTransportRegistration) {
      registered.push(transport);
    },
  } as unknown as HybridClawPluginApi);

  expect(registered).toHaveLength(1);
  expect(registered[0]?.kind).toBe('line');
  expect(createLineTransport).not.toHaveBeenCalled();

  const transport = registered[0]?.create({} as ChannelTransportHost);
  expect(transport).toBeDefined();
  expect(createLineTransport).not.toHaveBeenCalled();

  const handler = vi.fn(async () => {});
  await transport?.init(handler);
  expect(createLineTransport).toHaveBeenCalledTimes(1);
  expect(instance.init).toHaveBeenCalledWith(handler);
});

test('a plugin reload keeps the pairing prompt the live transport reports', async () => {
  const pairingStateKey = Symbol.for('hybridclaw.line.pairingState');
  const hosts: Array<{ pairing: { setPincode(pin: string): void } }> = [];
  vi.doMock('../plugins/line/src/transport.js', () => ({
    createLineTransport: (host: (typeof hosts)[number]) => {
      hosts.push(host);
      return {
        init: async () => {},
        shutdown: async () => {},
        sendText: async () => {},
        sendMedia: async () => {},
      };
    },
  }));
  const registerFresh = async () => {
    vi.resetModules();
    const registered: ChannelTransportRegistration[] = [];
    (await import('../plugins/line/src/index.js')).default.register({
      runtime: { homeDir: '/tmp/unused' },
      registerChannelTransport(transport: ChannelTransportRegistration) {
        registered.push(transport);
      },
    } as unknown as HybridClawPluginApi);
    return registered[0] as ChannelTransportRegistration;
  };

  try {
    const live = (await registerFresh()).create({} as ChannelTransportHost);
    await live.init(async () => {});
    const reloaded = await registerFresh();

    hosts[0]?.pairing.setPincode('123456');
    expect(reloaded.getPairingState?.()).toMatchObject({ pincode: '123456' });
  } finally {
    delete (globalThis as Record<symbol, unknown>)[pairingStateKey];
  }
});
