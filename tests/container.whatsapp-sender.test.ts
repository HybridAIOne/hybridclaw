import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  executeTool,
  setGatewayContext,
  setSessionContext,
} from '../container/src/tools.js';
import { registerChannelTransport } from '../src/channels/channel-transport.js';
import {
  resolvePluginChannelTarget,
  sendPluginChannelToolMessage,
} from '../src/channels/plugin-channel/tool-send.js';
import {
  createFakeTransportInstance,
  legacyWhatsAppRegistration,
} from './helpers/fake-channel-transport.js';
import { useCleanMocks } from './test-utils.js';

vi.mock('../src/channels/whatsapp/auth.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWhatsAppAuthStatus: async () => ({
    linked: true,
    jid: '15550100100:7@s.whatsapp.net',
  }),
}));
vi.mock('../src/channels/plugin-channel/host.js', () => ({
  createChannelTransportHost: () => ({}),
}));
const instance = createFakeTransportInstance();
registerChannelTransport(legacyWhatsAppRegistration(instance));
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
        const target = resolvePluginChannelTarget(payload.channelId);
        if (!target) throw new Error('unresolved target');
        const result = await sendPluginChannelToolMessage({
          ...target,
          content: payload.content,
          filePath: payload.filePath ?? null,
          hasComponents: false,
          from: payload.from,
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
    expect(instance.sendText).not.toHaveBeenCalled();
    expect(instance.sendMedia).not.toHaveBeenCalled();
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
