import { afterEach, expect, test, vi } from 'vitest';
import type {
  ChannelTransportInstance,
  ChannelTransportRegistration,
  HybridClawPluginApi,
  LineTransportHost,
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
    registerChannelTransport(transport: ChannelTransportRegistration) {
      registered.push(transport);
    },
  } as HybridClawPluginApi);

  expect(registered).toHaveLength(1);
  expect(registered[0]?.kind).toBe('line');
  expect(createLineTransport).not.toHaveBeenCalled();

  const transport = registered[0]?.create({} as LineTransportHost);
  expect(transport).toBeDefined();
  expect(createLineTransport).not.toHaveBeenCalled();

  const handler = vi.fn(async () => {});
  await transport?.init(handler);
  expect(createLineTransport).toHaveBeenCalledTimes(1);
  expect(instance.init).toHaveBeenCalledWith(handler);
});
