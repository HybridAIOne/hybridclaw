import { afterEach, expect, test, vi } from 'vitest';
import {
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import {
  resolvePluginChannelTarget,
  sendPluginChannelToolMessage,
} from '../src/channels/plugin-channel/tool-send.js';
import {
  createFakeTransportInstance,
  legacyWhatsAppRegistration,
} from './helpers/fake-channel-transport.js';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../src/channels/whatsapp/auth.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWhatsAppAuthStatus: mocks.auth,
}));
vi.mock('../src/channels/plugin-channel/host.js', () => ({
  createChannelTransportHost: () => ({}),
}));

const instance = createFakeTransportInstance();
registerChannelTransport(legacyWhatsAppRegistration(instance));

useCleanMocks({ cleanup: () => vi.clearAllMocks() });
afterEach(() => {
  instance.sendText.mockReset();
  instance.sendMedia.mockReset();
});

const params = {
  kind: 'whatsapp' as const,
  channelId: '15550100200@s.whatsapp.net',
  content: 'hello',
  filePath: null,
  hasComponents: false,
  from: undefined,
};

test.each([null, '/tmp/image.png'])(
  'preserves IDs for filePath=%s without claiming delivery or recipient verification',
  async (filePath) => {
    mocks.auth.mockResolvedValue({
      linked: true,
      jid: '15550100100:7@s.whatsapp.net',
    });
    instance.sendText.mockResolvedValue({
      messageIds: ['chunk-1', 'chunk-2'],
    } as never);
    instance.sendMedia.mockResolvedValue({
      messageIds: ['attachment-1'],
    } as never);
    const result = await sendPluginChannelToolMessage({ ...params, filePath });
    expect(result).toMatchObject({
      ok: true,
      transport: 'whatsapp',
      sentFrom: '+15550100100',
      recipient: '+15550100200',
      messageIds: filePath ? ['attachment-1'] : ['chunk-1', 'chunk-2'],
      deliveryStatus: 'unknown-recipient',
      deliveryConfirmed: false,
    });
  },
);

test.each([null, '/tmp/image.png'])(
  'propagates transport failure for filePath=%s',
  async (filePath) => {
    mocks.auth.mockResolvedValue({ linked: true });
    instance.sendText.mockRejectedValue(new Error('transport failed'));
    instance.sendMedia.mockRejectedValue(new Error('transport failed'));
    await expect(
      sendPluginChannelToolMessage({ ...params, filePath }),
    ).rejects.toThrow('transport failed');
  },
);

test('does not invent a sender when auth has no JID', async () => {
  mocks.auth.mockResolvedValue({ linked: true });
  await expect(
    sendPluginChannelToolMessage({ ...params, from: '+15550100200' }),
  ).rejects.toThrow('the linked WhatsApp account');
  expect(instance.sendText).not.toHaveBeenCalled();
  expect(instance.sendMedia).not.toHaveBeenCalled();
});

test('fails loudly once the WhatsApp plugin is gone', async () => {
  mocks.auth.mockResolvedValue({ linked: true });
  unregisterChannelTransport('whatsapp');
  try {
    // A stored JID stays WhatsApp's instead of resolving as an email address.
    expect(resolvePluginChannelTarget(params.channelId)).toEqual({
      kind: 'whatsapp',
      channelId: params.channelId,
    });
    expect(resolvePluginChannelTarget('peer@example.com')).toBeNull();
    await expect(sendPluginChannelToolMessage(params)).rejects.toThrow(
      'WhatsApp transport plugin is not installed',
    );
  } finally {
    registerChannelTransport(legacyWhatsAppRegistration(instance));
  }
});
