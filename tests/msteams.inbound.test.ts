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

test('cleanIncomingContent removes Teams mention bodies', async () => {
  const { cleanIncomingContent } = await importInboundModule();

  expect(
    cleanIncomingContent({
      text: '<at>HybridClaw</at> hi there',
    }),
  ).toBe('hi there');
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
