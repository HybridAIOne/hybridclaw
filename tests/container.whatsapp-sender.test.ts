import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  executeTool,
  setGatewayContext,
  setSessionContext,
} from '../container/src/tools.js';
import { sendWhatsAppToolMessage } from '../src/channels/whatsapp/tool-send.js';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({ text: vi.fn(), media: vi.fn() }));
vi.mock('../src/channels/whatsapp/auth.js', () => ({
  getWhatsAppAuthStatus: async () => ({
    linked: true,
    jid: '15550100100:7@s.whatsapp.net',
  }),
}));
vi.mock('../src/channels/whatsapp/runtime.js', () => ({
  sendToWhatsAppChat: mocks.text,
  sendWhatsAppMediaToChat: mocks.media,
}));
useCleanMocks({
  unstubAllGlobals: true,
  restoreAllMocks: true,
  cleanup: () => {
    vi.clearAllMocks();
    setGatewayContext('', '', '');
    setSessionContext('');
  },
});

test.each(['+15550100200', '', null])(
  'container preserves from=%s so the gateway rejects text and media sends',
  async (from) => {
    setGatewayContext('http://gateway.local', 'test-key', '');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload).toHaveProperty('from', from);
      try {
        const result = await sendWhatsAppToolMessage({
          ...payload,
          filePath: payload.filePath ?? null,
        });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(result),
        };
      } catch (error) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: (error as Error).message }),
        };
      }
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isFile: () => true,
    } as fs.Stats);
    for (const filePath of [undefined, 'image.png']) {
      const result = await executeTool(
        'message',
        JSON.stringify({
          action: 'send',
          channelId: 'whatsapp:+15550100200',
          content: 'hello',
          from,
          filePath,
        }),
      );
      expect(result).toContain('Messages are sent from +15550100100');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.media).not.toHaveBeenCalled();
  },
);

test('container does not add from when the caller omits it', async () => {
  setGatewayContext('http://gateway.local', 'test-key', '');
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('from');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  await executeTool(
    'message',
    JSON.stringify({
      action: 'send',
      channelId: 'whatsapp:+15550100200',
      content: 'hello',
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
