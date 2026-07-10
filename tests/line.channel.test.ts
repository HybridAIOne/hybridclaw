import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import {
  evaluateLineAccessPolicy,
  processInboundLineEvent,
} from '../src/channels/line/inbound.js';
import {
  buildLineChannelId,
  isLineChannelId,
  normalizeLineChannelId,
  normalizeLineSendTargetId,
  normalizeLineUserId,
  parseLineTarget,
} from '../src/channels/line/target.js';
import { verifyLineWebhookSignature } from '../src/channels/line/runtime.js';
import { buildSessionKey } from '../src/session/session-key.js';

const LINE_USER_ID = 'U0123456789abcdef0123456789ABCDEF';
const LINE_GROUP_ID = 'C0123456789abcdef0123456789ABCDEF';
const LINE_ROOM_ID = 'R0123456789abcdef0123456789ABCDEF';

const BASE_LINE_CONFIG = {
  enabled: true,
  channelAccessToken: '',
  channelSecret: '',
  webhookPath: '/api/line/webhook',
  dmPolicy: 'allowlist' as const,
  groupPolicy: 'allowlist' as const,
  allowFrom: [LINE_USER_ID],
  groupAllowFrom: [LINE_USER_ID],
  requireMention: true,
  textChunkLimit: 5_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('normalizes LINE targets without changing identifier casing', () => {
  expect(normalizeLineUserId(LINE_USER_ID)).toBe(LINE_USER_ID);
  expect(normalizeLineChannelId(`line:${LINE_USER_ID}`)).toBe(
    `line:${LINE_USER_ID}`,
  );
  expect(normalizeLineChannelId(`line:group:${LINE_GROUP_ID}`)).toBe(
    `line:group:${LINE_GROUP_ID}`,
  );
  expect(normalizeLineChannelId(`line:room:${LINE_ROOM_ID}`)).toBe(
    `line:room:${LINE_ROOM_ID}`,
  );
  expect(normalizeLineSendTargetId(`line:${LINE_USER_ID}`)).toBe(
    `line:${LINE_USER_ID}`,
  );
  expect(normalizeLineSendTargetId(LINE_USER_ID)).toBeUndefined();
});

test('builds and parses canonical LINE channel ids', () => {
  expect(buildLineChannelId(LINE_GROUP_ID, 'group')).toBe(
    `line:group:${LINE_GROUP_ID}`,
  );
  expect(parseLineTarget(`line:group:${LINE_GROUP_ID}`)).toEqual({
    kind: 'group',
    recipient: LINE_GROUP_ID,
  });
  expect(isLineChannelId(`line:group:${LINE_GROUP_ID}`)).toBe(true);
  expect(isLineChannelId('line:not-a-recipient')).toBe(false);
});

test('verifies LINE webhook signatures against the raw request body', () => {
  const body = Buffer.from('{"destination":"bot","events":[]}', 'utf8');
  const channelSecret = 'line-channel-secret';
  const signature = createHmac('sha256', channelSecret)
    .update(body)
    .digest('base64');

  expect(
    verifyLineWebhookSignature({
      body,
      channelSecret,
      signature,
    }),
  ).toBe(true);
  expect(
    verifyLineWebhookSignature({
      body: Buffer.from(`${body.toString('utf8')} `),
      channelSecret,
      signature,
    }),
  ).toBe(false);
});

test('blocks LINE group messages without a mention when mention gating is enabled', () => {
  const result = evaluateLineAccessPolicy({
    dmPolicy: 'open',
    groupPolicy: 'allowlist',
    allowFrom: [],
    groupAllowFrom: [LINE_USER_ID],
    isGroup: true,
    senderId: LINE_USER_ID,
    requireMention: true,
    isMentioned: false,
  });

  expect(result).toEqual({
    allowed: false,
    isGroup: true,
  });
});

test('builds inbound LINE sessions for allowed direct messages', () => {
  const result = processInboundLineEvent({
    agentId: 'main',
    config: BASE_LINE_CONFIG,
    event: {
      type: 'message',
      replyToken: 'reply-token',
      source: {
        type: 'user',
        userId: LINE_USER_ID,
      },
      message: {
        type: 'text',
        text: 'hello line',
      },
    },
  });

  expect(result).toEqual({
    sessionId: buildSessionKey(
      'main',
      'line',
      'dm',
      `line:${LINE_USER_ID}`,
    ),
    guildId: null,
    channelId: `line:${LINE_USER_ID}`,
    userId: LINE_USER_ID,
    username: LINE_USER_ID,
    content: 'hello line',
    media: [],
    isGroup: false,
  });
});

test('builds inbound LINE sessions for mentioned group messages', () => {
  const result = processInboundLineEvent({
    agentId: 'main',
    config: BASE_LINE_CONFIG,
    event: {
      type: 'message',
      replyToken: 'reply-token',
      source: {
        type: 'group',
        userId: LINE_USER_ID,
        groupId: LINE_GROUP_ID,
      },
      message: {
        type: 'text',
        text: '@HybridClaw status',
        mention: {
          mentionees: [
            {
              isSelf: true,
              userId: LINE_USER_ID,
            },
          ],
        },
      },
    },
  });

  expect(result?.sessionId).toBe(
    buildSessionKey(
      'main',
      'line',
      'group',
      `line:group:${LINE_GROUP_ID}`,
    ),
  );
  expect(result?.channelId).toBe(`line:group:${LINE_GROUP_ID}`);
  expect(result?.isGroup).toBe(true);
});

test('rejects LINE events with an unknown source type', () => {
  const result = processInboundLineEvent({
    agentId: 'main',
    config: BASE_LINE_CONFIG,
    event: {
      type: 'message',
      source: {
        type: 'future-source',
        userId: LINE_USER_ID,
      },
      message: {
        type: 'text',
        text: 'should not be treated as a DM',
      },
    },
  });

  expect(result).toBeNull();
});

test('processes LINE webhook batch events independently', async () => {
  const channelSecret = 'line-channel-secret';
  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      line: {
        ...BASE_LINE_CONFIG,
        dmPolicy: 'open',
      },
    }),
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_CHANNEL_SECRET: channelSecret,
  }));

  const { handleLineWebhook, initLine, shutdownLine } = await import(
    '../src/channels/line/runtime.js'
  );
  let resolveSecondEvent!: () => void;
  const secondEventProcessed = new Promise<void>((resolve) => {
    resolveSecondEvent = resolve;
  });
  let releaseFirstEvent!: () => void;
  const firstEventRelease = new Promise<void>((resolve) => {
    releaseFirstEvent = resolve;
  });
  const handler = vi.fn(async (...args: unknown[]) => {
    const content = String(args[5] || '');
    if (content === 'first') {
      await firstEventRelease;
      throw new Error('first event failed');
    }
    resolveSecondEvent();
  });
  await initLine(handler);

  const body = Buffer.from(
    JSON.stringify({
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: LINE_USER_ID },
          message: { type: 'text', text: 'first' },
        },
        {
          type: 'message',
          source: { type: 'user', userId: LINE_USER_ID },
          message: { type: 'text', text: 'second' },
        },
      ],
    }),
  );
  const request = Readable.from([body]) as unknown as IncomingMessage;
  request.headers = {
    'x-line-signature': createHmac('sha256', channelSecret)
      .update(body)
      .digest('base64'),
  };
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;

  try {
    await expect(handleLineWebhook(request, response)).resolves.toBe(true);
    expect(response.statusCode).toBe(200);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Second LINE event was blocked by the first.')),
        1_000,
      );
    });
    try {
      await Promise.race([secondEventProcessed, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    expect(handler).toHaveBeenCalledTimes(2);
  } finally {
    releaseFirstEvent();
    await shutdownLine();
  }
});

test('sendLineTextForReply falls back to push when a reply token is invalid', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Invalid reply token' }), {
        status: 400,
      }),
    )
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      line: {
        textChunkLimit: 5_000,
      },
    }),
  }));

  const { sendLineTextForReply } = await import(
    '../src/channels/line/delivery.js'
  );

  await sendLineTextForReply({
    channelAccessToken: 'line-token',
    target: `line:${LINE_USER_ID}`,
    replyToken: 'expired-reply-token',
    text: 'hello',
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    'https://api.line.me/v2/bot/message/reply',
  );
  expect(String(fetchMock.mock.calls[1][0])).toBe(
    'https://api.line.me/v2/bot/message/push',
  );

  const pushBody = JSON.parse(
    String((fetchMock.mock.calls[1][1] as RequestInit).body || '{}'),
  ) as {
    to?: string;
    messages?: Array<{ type?: string; text?: string }>;
  };
  expect(pushBody).toEqual({
    to: LINE_USER_ID,
    messages: [
      {
        type: 'text',
        text: 'hello',
      },
    ],
  });
});
