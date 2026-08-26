import { afterEach, expect, test, vi } from 'vitest';

async function importInboundModule() {
  vi.resetModules();
  vi.doMock('botbuilder-core', () => ({
    TurnContext: {
      getMentions: vi.fn(() => []),
      removeRecipientMention: vi.fn(
        (activity: { text?: string | null }) => activity.text || '',
      ),
    },
  }));
  vi.doMock('../src/command-registry.js', () => ({
    isRegisteredTextCommandName: vi.fn(() => false),
  }));
  return import('../src/channels/msteams/inbound.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test('cleanIncomingContent strips comments and preserves CDATA text', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: '<div>Hello<!--ignore--></div><![CDATA[raw]]><br><span>world</span>&amp;',
    }),
  ).toBe('Hello raw\nworld &');
});

test('cleanIncomingContent maps Teams mention bodies to agent addresses', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: '<at>Research Agent</at> hi there',
    }),
  ).toBe('@Research-Agent hi there');

  expect(
    cleanIncomingContent({
      text: '<at id="0">Research Agent</at> hi there',
    }),
  ).toBe('@Research-Agent hi there');
});

test('cleanIncomingContent drops the html attachment mirroring the text', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: 'how many fused couplers are we selling per year?',
      attachments: [
        {
          contentType: 'text/html',
          content:
            '<p>how many fused couplers are we selling per year?</p>',
        },
      ],
    }),
  ).toBe('how many fused couplers are we selling per year?');
});

test('cleanIncomingContent keeps html attachments that add content', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: 'see the forwarded note',
      attachments: [
        {
          contentType: 'text/html',
          content: '<p>quarterly numbers attached below</p>',
        },
      ],
    }),
  ).toBe('see the forwarded note\n\nquarterly numbers attached below');
});

test('cleanIncomingContent extracts nested Adaptive Card text', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: 'Please review this',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            body: [
              { type: 'TextBlock', text: 'Deployment status' },
              {
                type: 'ColumnSet',
                columns: [
                  {
                    type: 'Column',
                    items: [{ type: 'TextBlock', text: 'Healthy' }],
                  },
                ],
              },
              {
                type: 'FactSet',
                facts: [{ title: 'Version', value: '1.2.3' }],
              },
            ],
            actions: [{ type: 'Action.Submit', title: 'Acknowledge' }],
          },
        },
      ],
    }),
  ).toBe(
    'Please review this\n\nDeployment status\n\nHealthy\n\nVersion: 1.2.3\n\nAcknowledge',
  );
});

test('cleanIncomingContent extracts classic card text fields', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: '',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.hero',
          content: {
            title: 'Build failed',
            subtitle: 'main branch',
            text: 'Please check the CI logs.',
            buttons: [{ type: 'openUrl', title: 'Open logs' }],
          },
        },
      ],
    }),
  ).toBe(
    'Build failed\n\nmain branch\n\nPlease check the CI logs.\n\nOpen logs',
  );
});

test('cleanIncomingContent falls back to HTML attachment content', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: '',
      attachments: [
        {
          contentType: 'text/html',
          content:
            '<div><p>Hello <strong>world</strong></p><ul><li>One</li><li>Two</li></ul></div>',
        },
      ],
    }),
  ).toBe('Hello world One Two');
});

test('parseTeamsConversationId splits the channel root post id', async () => {
  const { parseTeamsConversationId } = await importInboundModule();

  expect(
    parseTeamsConversationId('19:channel@thread.tacv2;messageid=1755000000001'),
  ).toEqual({
    baseId: '19:channel@thread.tacv2',
    messageId: '1755000000001',
  });
  expect(parseTeamsConversationId('19:group@thread.v2')).toEqual({
    baseId: '19:group@thread.v2',
    messageId: null,
  });
});

test('resolveTeamsConversationKind classifies personal, group, and channel chats', async () => {
  const { resolveTeamsConversationKind } = await importInboundModule();

  expect(
    resolveTeamsConversationKind({
      conversation: { conversationType: 'personal', id: 'a:1' },
    } as never),
  ).toBe('personal');
  expect(
    resolveTeamsConversationKind({
      conversation: { conversationType: 'groupChat', id: '19:group@thread.v2' },
    } as never),
  ).toBe('group');
  expect(
    resolveTeamsConversationKind({
      conversation: { id: '19:channel@thread.tacv2;messageid=5' },
      channelData: { team: { id: '19:team@thread.tacv2' } },
    } as never),
  ).toBe('channel');
  expect(
    resolveTeamsConversationKind({
      conversation: { id: 'a:legacy' },
    } as never),
  ).toBe('personal');
});

test('buildSessionIdFromActivity keys personal chats by user', async () => {
  const { buildSessionIdFromActivity } = await importInboundModule();

  expect(
    buildSessionIdFromActivity({
      conversation: { conversationType: 'personal', id: 'a:1' },
      from: { id: '29:enc', aadObjectId: 'User-AAD' },
    } as never),
  ).toBe('agent:main:channel:msteams:chat:dm:peer:user-aad');
});

test('buildSessionIdFromActivity keys group chats by conversation', async () => {
  const { buildSessionIdFromActivity } = await importInboundModule();

  expect(
    buildSessionIdFromActivity({
      conversation: {
        conversationType: 'groupChat',
        id: '19:Group@thread.v2',
      },
      from: { id: '29:enc', aadObjectId: 'user-aad' },
    } as never),
  ).toBe('agent:main:channel:msteams:chat:group:peer:19%3Agroup%40thread.v2');
});

test('buildSessionIdFromActivity keys channel posts as per-thread sessions', async () => {
  const { buildSessionIdFromActivity } = await importInboundModule();

  expect(
    buildSessionIdFromActivity({
      conversation: {
        conversationType: 'channel',
        id: '19:channel@thread.tacv2;messageid=1755000000001',
      },
      channelData: { team: { id: '19:team@thread.tacv2' } },
      from: { id: '29:enc', aadObjectId: 'user-aad' },
    } as never),
  ).toBe(
    'agent:main:channel:msteams:chat:thread:peer:19%3Achannel%40thread.tacv2:thread:1755000000001:topic:19%3Ateam%40thread.tacv2',
  );

  expect(
    buildSessionIdFromActivity({
      conversation: {
        conversationType: 'channel',
        id: '19:channel@thread.tacv2',
      },
      channelData: { team: { id: '19:team@thread.tacv2' } },
      from: { id: '29:enc', aadObjectId: 'user-aad' },
    } as never),
  ).toBe(
    'agent:main:channel:msteams:chat:channel:peer:19%3Achannel%40thread.tacv2:topic:19%3Ateam%40thread.tacv2',
  );
});
