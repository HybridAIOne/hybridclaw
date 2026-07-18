import { afterEach, expect, test, vi } from 'vitest';
import {
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import {
  createWhatsAppPairingSession,
  initWhatsApp,
  isWhatsAppTransportInstalled,
  sendToWhatsAppChat,
  shutdownWhatsApp,
  WhatsAppTransportMissingError,
  WHATSAPP_PLUGIN_INSTALL_COMMAND,
} from '../src/channels/whatsapp/runtime.js';

afterEach(async () => {
  await shutdownWhatsApp();
  unregisterChannelTransport('whatsapp');
  vi.restoreAllMocks();
});

test('reports actionable errors when the WhatsApp transport is not installed', async () => {
  expect(isWhatsAppTransportInstalled()).toBe(false);
  await expect(initWhatsApp(vi.fn(async () => {}))).rejects.toBeInstanceOf(
    WhatsAppTransportMissingError,
  );
  await expect(sendToWhatsAppChat('chat', 'hello')).rejects.toThrow(
    WHATSAPP_PLUGIN_INSTALL_COMMAND,
  );
});

test('prefers the registered plugin and retains its instance for shutdown', async () => {
  const pairingSession = {
    start: vi.fn(async () => {}),
    waitForConnection: vi.fn(async () => ({ id: 'linked@s.whatsapp.net' })),
    stop: vi.fn(async () => {}),
  };
  const instance = {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendMedia: vi.fn(async () => {}),
    createPairingSession: vi.fn(async () => pairingSession),
  };
  const create = vi.fn(() => instance);
  registerChannelTransport({ kind: 'whatsapp', create });

  const handler = vi.fn(async () => {});
  await initWhatsApp(handler);
  await sendToWhatsAppChat('491701234567@s.whatsapp.net', 'hello');
  await expect(createWhatsAppPairingSession()).resolves.toBe(pairingSession);

  expect(create).toHaveBeenCalledTimes(1);
  expect(instance.init).toHaveBeenCalledWith(handler);
  expect(instance.sendText).toHaveBeenCalledWith(
    '491701234567@s.whatsapp.net',
    'hello',
  );

  unregisterChannelTransport('whatsapp');
  await shutdownWhatsApp();
  expect(instance.shutdown).toHaveBeenCalledTimes(1);
});
