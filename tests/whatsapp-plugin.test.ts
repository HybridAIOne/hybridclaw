import { afterEach, expect, test, vi } from 'vitest';
import type {
  ChannelTransportInstance,
  ChannelTransportRegistration,
  HybridClawPluginApi,
} from '../src/plugins/plugin-sdk.js';
import { createWhatsAppTestHost } from './whatsapp-test-host.js';

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
  const createWhatsAppTransport = vi.fn(() => instance);
  vi.doMock('../plugins/whatsapp/src/transport.ts', () => ({
    createWhatsAppTransport,
  }));

  const registered: ChannelTransportRegistration[] = [];
  const plugin = (await import('../plugins/whatsapp/src/index.ts')).default;
  plugin.register({
    registerChannelTransport(transport) {
      registered.push(transport);
    },
  } as HybridClawPluginApi);

  expect(registered).toHaveLength(1);
  expect(createWhatsAppTransport).not.toHaveBeenCalled();

  const transport = registered[0]?.create(createWhatsAppTestHost());
  expect(transport).toBeDefined();
  expect(createWhatsAppTransport).not.toHaveBeenCalled();

  const handler = vi.fn(async () => {});
  await transport?.init(handler);
  expect(createWhatsAppTransport).toHaveBeenCalledTimes(1);
  expect(instance.init).toHaveBeenCalledWith(handler);
});
