import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshSlackDelivery() {
  vi.resetModules();

  const chunkMessage = vi.fn<(text: string) => string[]>();

  vi.doMock('../src/config/config.ts', () => ({
    SLACK_TEXT_CHUNK_LIMIT: 12_000,
  }));
  vi.doMock('../src/memory/chunk.js', () => ({
    chunkMessage,
  }));

  const delivery = await import('../src/channels/slack/delivery.js');
  return {
    delivery,
    chunkMessage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/memory/chunk.js');
  vi.resetModules();
});

describe('slack delivery', () => {
  test('converts common markdown to Slack mrkdwn', async () => {
    const { delivery } = await importFreshSlackDelivery();

    const input = [
      'Here’s a quick overview:',
      '',
      '- **Ukraine war / Orthodox Easter ceasefire tensions:** Russia and Ukraine are **trading accusations**.',
      '- **General Europe news feed constraints:** **Reuters’ Europe page** is blocked.',
      '',
      'Ask for **markets/economy** if you want a tighter brief.',
      '*Tools: web_search, web_fetch*',
    ].join('\n');

    expect(delivery.formatSlackMrkdwn(input)).toBe(
      [
        'Here’s a quick overview:',
        '',
        '- *Ukraine war / Orthodox Easter ceasefire tensions:* Russia and Ukraine are *trading accusations*.',
        '- *General Europe news feed constraints:* *Reuters’ Europe page* is blocked.',
        '',
        'Ask for *markets/economy* if you want a tighter brief.',
        '*Tools: web_search, web_fetch*',
      ].join('\n'),
    );
  });

  test('preserves Slack entities and code while converting links and escaping plain text', async () => {
    const { delivery } = await importFreshSlackDelivery();

    const input = [
      'Hello <@U1234567890> & [Docs](https://example.com/a(b)c)',
      '> quoted',
      '`**literal**`',
      '```ts',
      '**literal**',
      '```',
    ].join('\n');

    expect(delivery.formatSlackMrkdwn(input)).toBe(
      [
        'Hello <@U1234567890> &amp; <https://example.com/a(b)c|Docs>',
        '> quoted',
        '`**literal**`',
        '```ts',
        '**literal**',
        '```',
      ].join('\n'),
    );
  });

  test('formats text before chunking for Slack delivery', async () => {
    const { delivery, chunkMessage } = await importFreshSlackDelivery();
    chunkMessage.mockReturnValue(['chunk-1', 'chunk-2']);

    const chunks = delivery.prepareSlackTextChunks(
      '- **General Europe news feed constraints:** blocked.',
    );

    expect(chunkMessage).toHaveBeenCalledWith(
      '- *General Europe news feed constraints:* blocked.',
      {
        maxChars: 12_000,
        maxLines: 200,
      },
    );
    expect(chunks).toEqual(['chunk-1', 'chunk-2']);
  });

  test('falls back to a no-content Slack payload when chunking yields blanks', async () => {
    const { delivery, chunkMessage } = await importFreshSlackDelivery();
    chunkMessage.mockReturnValue(['\n', '   ']);

    expect(delivery.prepareSlackTextChunks('ignored')).toEqual([
      '(no content)',
    ]);
  });
});
