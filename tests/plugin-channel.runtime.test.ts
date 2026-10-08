import { afterEach, expect, test, vi } from 'vitest';
import {
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import {
  createPluginChannelPairingSession,
  initPluginChannel,
  sendPluginChannelMedia,
  sendPluginChannelText,
  shutdownPluginChannel,
} from '../src/channels/plugin-channel/runtime.js';
import { sendPluginChannelProactive } from '../src/channels/plugin-channel/proactive.js';
import {
  createFakeTransportInstance,
  legacyWhatsAppRegistration,
} from './helpers/fake-channel-transport.js';

vi.mock('../src/channels/plugin-channel/host.js', () => ({
  createChannelTransportHost: (kind: string) => ({ kind }),
}));

afterEach(async () => {
  await shutdownPluginChannel('whatsapp');
  await shutdownPluginChannel('line');
  unregisterChannelTransport('whatsapp');
  unregisterChannelTransport('line');
  vi.restoreAllMocks();
});

test.each([
  'whatsapp',
  'line',
] as const)('reports the install command when the %s plugin is missing', async (kind) => {
  await expect(initPluginChannel(kind, vi.fn())).rejects.toThrow(
    'transport plugin is not installed. Install it with: hybridclaw plugin install',
  );
  await expect(sendPluginChannelText(kind, 'chat', 'hello')).rejects.toThrow(
    'hybridclaw plugin install',
  );
  await expect(
    sendPluginChannelProactive(kind, 'chat', 'hello', 'test'),
  ).resolves.toEqual({
    status: 'failed',
    reason: 'transport plugin is not installed',
  });
});

test('an unknown kind throws instead of reaching another channel', async () => {
  await expect(
    sendPluginChannelText('telegram' as never, 'chat', 'hello'),
  ).rejects.toThrow('Unknown channel transport kind "telegram"');
});

test('prefers the registered plugin and retains its instance for shutdown', async () => {
  const pairingSession = {
    start: vi.fn(async () => {}),
    waitForConnection: vi.fn(async () => ({ id: 'linked@s.whatsapp.net' })),
    stop: vi.fn(async () => {}),
  };
  const instance = createFakeTransportInstance({
    createPairingSession: vi.fn(async () => pairingSession),
  });
  const registration = legacyWhatsAppRegistration(instance);
  registerChannelTransport(registration);

  const handler = vi.fn(async () => {});
  await initPluginChannel('whatsapp', handler);
  await sendPluginChannelText(
    'whatsapp',
    '491701234567@s.whatsapp.net',
    'hello',
  );
  await expect(createPluginChannelPairingSession('whatsapp')).resolves.toBe(
    pairingSession,
  );

  expect(
    (registration as unknown as { create: ReturnType<typeof vi.fn> }).create,
  ).toHaveBeenCalledTimes(1);
  expect(instance.init).toHaveBeenCalledWith(handler);
  expect(instance.sendText).toHaveBeenCalledWith(
    '491701234567@s.whatsapp.net',
    'hello',
  );

  unregisterChannelTransport('whatsapp');
  await shutdownPluginChannel('whatsapp');
  expect(instance.shutdown).toHaveBeenCalledTimes(1);
});

test('preserves plugin send IDs for text and media', async () => {
  const textResult = { messageIds: ['chunk-1', 'chunk-2'] };
  const mediaResult = { messageIds: ['attachment-1'] };
  registerChannelTransport(
    legacyWhatsAppRegistration(
      createFakeTransportInstance({
        sendText: async () => textResult,
        sendMedia: async () => mediaResult,
      }),
    ),
  );
  await expect(
    sendPluginChannelText('whatsapp', '15550100200@s.whatsapp.net', 'hello'),
  ).resolves.toBe(textResult);
  await expect(
    sendPluginChannelMedia('whatsapp', {
      jid: '15550100200@s.whatsapp.net',
      filePath: '/tmp/image.png',
    }),
  ).resolves.toBe(mediaResult);
});

test('the legacy WhatsApp host keeps the auth, pairing, and phone helpers', async () => {
  const create = vi.fn(() => createFakeTransportInstance());
  registerChannelTransport({ kind: 'whatsapp', create } as never);
  await sendPluginChannelText('whatsapp', '15550100200@s.whatsapp.net', 'hi');

  const host = create.mock.calls[0]?.[0] as unknown as Record<
    string,
    Record<string, unknown>
  >;
  expect(host.kind).toBe('whatsapp');
  expect(host.auth.authDir).toMatch(/credentials[/\\]whatsapp$/);
  expect(Object.keys(host.pairing).sort()).toEqual([
    'clear',
    'setError',
    'setQrText',
  ]);
  expect(
    (host.phone.normalizePhoneNumber as (raw: string) => string | null)(
      'whatsapp:(555) 123-4567',
    ),
  ).toBe('+5551234567');
});
