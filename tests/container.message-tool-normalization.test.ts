import fs from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  executeTool,
  getMessageToolDescription,
  setGatewayContext,
  setSessionContext,
} from '../container/src/tools.js';

const CHANNEL_ID = '1475079601968648386';
const USER_ID = '1312680972151558236';

function mockGatewayFetch(responsePayload: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(responsePayload),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe.sequential('container message tool normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setSessionContext('');
    setGatewayContext('', '', '');
  });

  test('normalizes action alias dm -> send', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: CHANNEL_ID,
    });
    setGatewayContext('http://gateway.local', 'token', '');

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'dm',
        channelId: CHANNEL_ID,
        content: 'dm alias test',
      }),
    );

    expect(result).toContain('"ok": true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://gateway.local/api/message/action',
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.action).toBe('send');
    expect(payload.channelId).toBe(CHANNEL_ID);
  });

  test('strips discord: prefix from channel target before gateway call', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: CHANNEL_ID,
    });
    setGatewayContext('http://gateway.local', 'token', '');

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'send',
        channelId: `discord:${CHANNEL_ID}`,
        content: 'prefix normalization test',
      }),
    );

    expect(result).toContain('"ok": true');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.channelId).toBe(CHANNEL_ID);
  });

  test('normalizes user mentions for member-info payload', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'member-info',
      guildId: '123456789012345678',
      userId: USER_ID,
    });
    setGatewayContext('http://gateway.local', 'token', '');

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'lookup',
        guildId: '123456789012345678',
        user: `<@${USER_ID}>`,
      }),
    );

    expect(result).toContain('"ok": true');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.action).toBe('member-info');
    expect(payload.userId).toBe(USER_ID);
  });

  test('send payload includes contextChannelId for user-target sends', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: 'dm-channel-id',
    });
    setGatewayContext('http://gateway.local', 'token', CHANNEL_ID);

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'send',
        to: '@alice',
        content: 'hello',
      }),
    );

    expect(result).toContain('"ok": true');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.channelId).toBe('@alice');
    expect(payload.contextChannelId).toBe(CHANNEL_ID);
  });

  test('send payload includes filePath and sessionId for local uploads', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: CHANNEL_ID,
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isFile: () => true,
    } as fs.Stats);
    setGatewayContext('http://gateway.local', 'token', CHANNEL_ID);
    setSessionContext('dm:439508376087560193');

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'send',
        filePath: 'package.json',
      }),
    );

    expect(result).toContain('"ok": true');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.filePath).toBe('package.json');
    expect(payload.sessionId).toBe('dm:439508376087560193');
  });

  test('send normalizes explicit user mentions to ids', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: 'dm-channel-id',
    });
    setGatewayContext('http://gateway.local', 'token', CHANNEL_ID);

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'send',
        to: `<@${USER_ID}>`,
        content: 'hello',
      }),
    );

    expect(result).toContain('"ok": true');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.channelId).toBe(USER_ID);
  });

  test('send forwards username target when channelId is omitted', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: 'dm-channel-id',
    });
    setGatewayContext('http://gateway.local', 'token', CHANNEL_ID);

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'send',
        username: '@alice',
        content: 'hello',
      }),
    );

    expect(result).toContain('"ok": true');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.user).toBe('@alice');
    expect(payload.channelId).toBeUndefined();
    expect(payload.contextChannelId).toBe(CHANNEL_ID);
  });

  test('send requires an explicit Discord target from WhatsApp context', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: 'should-not-be-called',
    });
    setGatewayContext(
      'http://gateway.local',
      'token',
      '491234567890@s.whatsapp.net',
    );

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'send',
        content: 'hello',
      }),
    );

    expect(result).toContain(
      'channelId is required for message action "send" unless user/username is provided.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('send targets the current Teams conversation when channelId is omitted', async () => {
    const fetchMock = mockGatewayFetch({
      ok: true,
      action: 'send',
      channelId: 'a:teams-current-conversation',
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isFile: () => true,
    } as fs.Stats);
    setGatewayContext(
      'http://gateway.local',
      'token',
      'a:teams-current-conversation',
    );
    setSessionContext('teams:dm:user-aad-id');

    const result = await executeTool(
      'message',
      JSON.stringify({
        action: 'send',
        filePath: 'package.json',
      }),
    );

    expect(result).toContain('"ok": true');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload.channelId).toBe('a:teams-current-conversation');
    expect(payload.sessionId).toBe('teams:dm:user-aad-id');
    expect(payload.filePath).toBe('package.json');
  });

  test('message tool description does not treat WhatsApp chat as a Discord channel', () => {
    setGatewayContext(
      'http://gateway.local',
      'token',
      '491234567890@s.whatsapp.net',
    );

    const description = getMessageToolDescription();
    expect(description).not.toContain('491234567890@s.whatsapp.net');
    expect(description).toContain('Supports actions:');
    expect(description).toContain('WhatsApp');
    expect(description).toContain('ingested email thread history');
  });

  test('message tool description advertises current Teams send support', () => {
    setGatewayContext(
      'http://gateway.local',
      'token',
      'a:teams-current-conversation',
    );
    setSessionContext('teams:dm:user-aad-id');

    const description = getMessageToolDescription();
    expect(description).toContain(
      'Current Teams conversation (a:teams-current-conversation) supports: send.',
    );
    expect(description).toContain('current Teams conversation for send');
  });

  test('message tool description enumerates other configured channels', () => {
    const otherChannelId = '223456789012345679';
    setGatewayContext('http://gateway.local', 'token', CHANNEL_ID, [
      CHANNEL_ID,
      otherChannelId,
    ]);

    const description = getMessageToolDescription(CHANNEL_ID);
    expect(description).toContain(`Current Discord channel (${CHANNEL_ID})`);
    expect(description).toContain(
      `Other configured channels: ${otherChannelId} (`,
    );
  });
});
