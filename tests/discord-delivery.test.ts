import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshDelivery() {
  vi.resetModules();

  const chunkMessage = vi.fn<(text: string) => string[]>();
  const rewriteUserMentions = vi.fn(
    (text: string) => `rewritten:${text}` as string,
  );
  const getHumanDelayMs = vi.fn(() => 0);
  const sleep = vi.fn(async () => {});

  vi.doMock('../src/config/config.ts', () => ({
    DISCORD_MAX_LINES_PER_MESSAGE: 20,
    DISCORD_TEXT_CHUNK_LIMIT: 1_900,
  }));
  vi.doMock('../src/memory/chunk.js', () => ({
    chunkMessage,
  }));
  vi.doMock('../src/channels/discord/human-delay.js', () => ({
    getHumanDelayMs,
    sleep,
  }));
  vi.doMock('../src/channels/discord/mentions.js', () => ({
    rewriteUserMentions,
  }));

  const delivery = await import('../src/channels/discord/delivery.js');
  return {
    delivery,
    chunkMessage,
    rewriteUserMentions,
    getHumanDelayMs,
    sleep,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/memory/chunk.js');
  vi.doUnmock('../src/channels/discord/human-delay.js');
  vi.doUnmock('../src/channels/discord/mentions.js');
  vi.resetModules();
});

describe('discord delivery', () => {
  test('builds response and formatter strings', async () => {
    const { delivery } = await importFreshDelivery();

    expect(delivery.buildResponseText('Hello')).toBe('Hello');
    expect(delivery.buildResponseText('Hello', ['search', 'read'])).toBe(
      'Hello\n*Tools: search, read*',
    );
    expect(
      delivery.buildResponseText(
        'Hello',
        ['search'],
        [
          {
            ref: '[mem:1]',
            memoryId: 4,
            content: 'User prefers concise changelog entries.',
            confidence: 0.9,
          },
        ],
      ),
    ).toBe(
      'Hello\n\n*Recalled memories:*\n[mem:1]: User prefers concise changelog entries. (90%)\n*Tools: search*',
    );
    expect(delivery.formatInfo('Status', 'Ready')).toBe('**Status**\nReady');
    expect(delivery.formatError('Oops', 'Failed')).toBe('**Oops:** Failed');
  });

  test('prepares chunked payloads and only attaches files to the final chunk', async () => {
    const { delivery, chunkMessage, rewriteUserMentions } =
      await importFreshDelivery();
    chunkMessage.mockReturnValue(['chunk-1', 'chunk-2']);
    const files = [{ name: 'report.txt' }] as unknown as [];
    const components = [{ type: 1, components: [] }];

    const payloads = delivery.prepareChunkedPayloads(
      '@alice hello',
      files,
      components,
      {
        byAlias: new Map(),
      },
    );

    expect(rewriteUserMentions).toHaveBeenCalledWith(
      '@alice hello',
      expect.objectContaining({ byAlias: expect.any(Map) }),
    );
    expect(payloads).toEqual([
      { content: 'chunk-1', components },
      { content: 'chunk-2', files },
    ]);
  });

  test('falls back to a no-content payload when chunking yields nothing', async () => {
    const { delivery, chunkMessage } = await importFreshDelivery();
    chunkMessage.mockReturnValue([]);

    expect(delivery.prepareChunkedPayloads('ignored')).toEqual([
      { content: '(no content)' },
    ]);
  });

  test('omits empty files and component arrays from payloads', async () => {
    const { delivery, chunkMessage } = await importFreshDelivery();
    chunkMessage.mockReturnValue(['only chunk']);

    expect(
      delivery.prepareChunkedPayloads('ignored', [], [], {
        byAlias: new Map(),
      }),
    ).toEqual([{ content: 'only chunk' }]);
  });

  test('filters blank-only chunks before building Discord payloads', async () => {
    const { delivery, chunkMessage } = await importFreshDelivery();
    chunkMessage.mockReturnValue(['\n', 'visible chunk']);

    expect(delivery.prepareChunkedPayloads('ignored')).toEqual([
      { content: 'visible chunk' },
    ]);
  });

  test('sends chunked replies through reply then channel send with delay', async () => {
    const { delivery, chunkMessage, getHumanDelayMs, sleep } =
      await importFreshDelivery();
    chunkMessage.mockReturnValue(['first chunk', 'second chunk']);
    getHumanDelayMs.mockReturnValue(25);

    const reply = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const attempts: string[] = [];
    const withRetry = async <T>(label: string, fn: () => Promise<T>) => {
      attempts.push(label);
      return fn();
    };

    await delivery.sendChunkedReply({
      msg: { reply, channel: { send } } as never,
      text: 'ignored',
      components: [{ type: 1, components: [] }],
      withRetry,
      humanDelay: { mode: 'custom', minMs: 25, maxMs: 25 },
    });

    expect(attempts).toEqual(['reply', 'send']);
    expect(reply).toHaveBeenCalledWith({
      content: 'first chunk',
      components: [{ type: 1, components: [] }],
    });
    expect(send).toHaveBeenCalledWith({ content: 'second chunk' });
    expect(sleep).toHaveBeenCalledWith(25);
  });

  test('sends chunked direct replies through DM open then DM sends', async () => {
    const { delivery, chunkMessage, getHumanDelayMs, sleep } =
      await importFreshDelivery();
    chunkMessage.mockReturnValue(['direct-1', 'direct-2']);
    getHumanDelayMs.mockReturnValue(10);

    const dmSend = vi.fn(async () => {});
    const createDM = vi.fn(async () => ({ send: dmSend }));
    const attempts: string[] = [];
    const withRetry = async <T>(label: string, fn: () => Promise<T>) => {
      attempts.push(label);
      return fn();
    };

    await delivery.sendChunkedDirectReply({
      msg: { author: { createDM } } as never,
      text: 'ignored',
      withRetry,
      humanDelay: { mode: 'custom', minMs: 10, maxMs: 10 },
    });

    expect(attempts).toEqual(['dm-open', 'dm-send', 'dm-send']);
    expect(createDM).toHaveBeenCalledTimes(1);
    expect(dmSend).toHaveBeenNthCalledWith(1, { content: 'direct-1' });
    expect(dmSend).toHaveBeenNthCalledWith(2, { content: 'direct-2' });
    expect(sleep).toHaveBeenCalledWith(10);
  });

  test('replies to guild interactions ephemerally and uses follow-up for additional chunks', async () => {
    const { delivery, chunkMessage } = await importFreshDelivery();
    chunkMessage.mockReturnValue(['one', 'two']);

    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const attempts: string[] = [];
    const withRetry = async <T>(label: string, fn: () => Promise<T>) => {
      attempts.push(label);
      return fn();
    };

    await delivery.sendChunkedInteractionReply({
      interaction: {
        guildId: 'guild-1',
        replied: false,
        deferred: false,
        reply,
        followUp,
      } as never,
      text: 'ignored',
      components: [{ type: 1, components: [] }],
      withRetry,
    });

    expect(attempts).toEqual(['interaction-reply', 'interaction-followup']);
    expect(reply).toHaveBeenCalledWith({
      content: 'one',
      components: [{ type: 1, components: [] }],
      flags: 'Ephemeral',
    });
    expect(followUp).toHaveBeenCalledWith({
      content: 'two',
      flags: 'Ephemeral',
    });
  });

  test('uses normal visible replies for DM interactions', async () => {
    const { delivery, chunkMessage } = await importFreshDelivery();
    chunkMessage.mockReturnValue(['one', 'two']);

    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const withRetry = async <T>(_label: string, fn: () => Promise<T>) => fn();

    await delivery.sendChunkedInteractionReply({
      interaction: {
        guildId: null,
        replied: false,
        deferred: false,
        reply,
        followUp,
      } as never,
      text: 'ignored',
      withRetry,
    });

    expect(reply).toHaveBeenCalledWith({ content: 'one' });
    expect(followUp).toHaveBeenCalledWith({ content: 'two' });
  });

  test('uses follow-up immediately when an interaction was already replied or deferred', async () => {
    const { delivery, chunkMessage } = await importFreshDelivery();
    chunkMessage.mockReturnValue(['only']);

    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const withRetry = async <T>(_label: string, fn: () => Promise<T>) => fn();

    await delivery.sendChunkedInteractionReply({
      interaction: {
        guildId: 'guild-1',
        replied: true,
        deferred: false,
        reply,
        followUp,
      } as never,
      text: 'ignored',
      withRetry,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({
      content: 'only',
      flags: 'Ephemeral',
    });
  });
});
