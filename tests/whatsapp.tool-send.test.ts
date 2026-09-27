import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  text: vi.fn(),
  media: vi.fn(),
}));
vi.mock('../src/channels/whatsapp/auth.js', () => ({
  getWhatsAppAuthStatus: mocks.auth,
}));
vi.mock('../src/channels/whatsapp/runtime.js', () => ({
  sendToWhatsAppChat: mocks.text,
  sendWhatsAppMediaToChat: mocks.media,
}));
import { sendWhatsAppToolMessage } from '../src/channels/whatsapp/tool-send.js';

useCleanMocks({ cleanup: () => vi.clearAllMocks() });
const params = {
  channelId: '15550100200@s.whatsapp.net',
  content: 'hello',
  filePath: null,
  from: undefined,
};

test.each([null, '/tmp/image.png'])(
  'preserves IDs for filePath=%s without claiming delivery or recipient verification',
  async (filePath) => {
    mocks.auth.mockResolvedValue({
      linked: true,
      jid: '15550100100:7@s.whatsapp.net',
    });
    mocks.text.mockResolvedValue({ messageIds: ['chunk-1', 'chunk-2'] });
    mocks.media.mockResolvedValue({ messageIds: ['attachment-1'] });
    const result = await sendWhatsAppToolMessage({ ...params, filePath });
    expect(result).toMatchObject({
      ok: true,
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
    mocks.text.mockRejectedValue(new Error('transport failed'));
    mocks.media.mockRejectedValue(new Error('transport failed'));
    await expect(
      sendWhatsAppToolMessage({ ...params, filePath }),
    ).rejects.toThrow('transport failed');
  },
);

test('does not invent a sender when auth has no JID', async () => {
  mocks.auth.mockResolvedValue({ linked: true });
  await expect(
    sendWhatsAppToolMessage({ ...params, from: '+15550100200' }),
  ).rejects.toThrow('the linked WhatsApp account');
  expect(mocks.text).not.toHaveBeenCalled();
  expect(mocks.media).not.toHaveBeenCalled();
});
