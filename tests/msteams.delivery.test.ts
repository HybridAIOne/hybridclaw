import { expect, test, vi } from 'vitest';

import {
  buildMSTeamsMessageActivity,
  buildMSTeamsSessionSwitcherCard,
  formatMSTeamsMarkdown,
  prepareChunkedActivities,
  sendChunkedReply,
  stripUnusableMSTeamsArtifactLinks,
} from '../src/channels/msteams/delivery.js';

test('buildMSTeamsSessionSwitcherCard offers switch and new-session actions', () => {
  const attachment = buildMSTeamsSessionSwitcherCard([
    { sessionId: 'sess_current', label: '1. current', isCurrent: true },
    { sessionId: 'sess_older', label: '2. older chat', isCurrent: false },
  ]);

  expect(attachment.contentType).toBe(
    'application/vnd.microsoft.card.adaptive',
  );
  const card = attachment.content as {
    actions: Array<{
      title: string;
      data: { msteams: { type: string; text: string } };
    }>;
  };
  expect(card.actions).toHaveLength(2);
  expect(card.actions[0].title).toBe('2. older chat');
  expect(card.actions[0].data.msteams).toMatchObject({
    type: 'messageBack',
    text: '/sessions switch sess_older',
  });
  expect(card.actions[1].data.msteams.text).toBe('/new');
});

test('stripUnusableMSTeamsArtifactLinks keeps artifact names but removes local URLs', () => {
  expect(
    stripUnusableMSTeamsArtifactLinks(
      'Created [dog_with_image.pdf](sandbox:/workspace/dog_with_image.pdf) and [docs](https://example.com/docs).',
    ),
  ).toBe(
    'Created dog_with_image.pdf and [docs](https://example.com/docs).',
  );
});

test('prepareChunkedActivities keeps attachment-only Teams sends empty', () => {
  const attachments = [
    {
      contentType: 'image/png',
      contentUrl: 'https://example.com/image.png',
      name: 'image.png',
    },
  ];

  const chunks = prepareChunkedActivities({
    text: '',
    attachments,
  });

  expect(chunks).toEqual([
    {
      text: '',
      attachments,
    },
  ]);
});

test('formatMSTeamsMarkdown preserves visible line breaks outside code blocks', () => {
  expect(
    formatMSTeamsMarkdown(
      [
        'First line',
        'Second line',
        '',
        '```ts',
        'const first = 1;',
        'const second = 2;',
        '```',
        'Final line',
      ].join('\n'),
    ),
  ).toBe(
    [
      'First line  ',
      'Second line',
      '',
      '```ts',
      'const first = 1;',
      'const second = 2;',
      '```',
      'Final line',
    ].join('\n'),
  );
});

test('buildMSTeamsMessageActivity marks text as Teams markdown', () => {
  expect(
    buildMSTeamsMessageActivity({
      text: 'First line  \nSecond line',
      replyStyle: 'thread',
      replyToId: 'incoming-1',
    }),
  ).toEqual({
    type: 'message',
    text: 'First line  \nSecond line',
    textFormat: 'markdown',
    replyToId: 'incoming-1',
  });
});

test('sendChunkedReply omits the text field for attachment-only Teams sends', async () => {
  const sendActivity = vi.fn(async () => ({ id: 'activity-1' }));
  const turnContext = {
    sendActivity,
  };
  const attachments = [
    {
      contentType: 'image/png',
      contentUrl: 'https://example.com/image.png',
      name: 'image.png',
    },
  ];

  await sendChunkedReply({
    turnContext: turnContext as never,
    text: '',
    attachments,
    replyStyle: 'thread',
    replyToId: 'incoming-1',
  });

  expect(sendActivity).toHaveBeenCalledWith({
    type: 'message',
    attachments,
    replyToId: 'incoming-1',
  });
});

test('sendChunkedReply retries transient Teams transport failures', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 429, retryAfter: 0.05 })
      .mockResolvedValueOnce({ id: 'activity-1' });
    const turnContext = {
      sendActivity,
    };

    const replyPromise = sendChunkedReply({
      turnContext: turnContext as never,
      text: 'Hello',
      replyStyle: 'thread',
      replyToId: 'incoming-1',
    });

    expect(sendActivity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(sendActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await replyPromise;

    expect(sendActivity).toHaveBeenCalledTimes(2);
    expect(sendActivity).toHaveBeenNthCalledWith(1, {
      type: 'message',
      text: 'Hello',
      textFormat: 'markdown',
      replyToId: 'incoming-1',
    });
    expect(sendActivity).toHaveBeenNthCalledWith(2, {
      type: 'message',
      text: 'Hello',
      textFormat: 'markdown',
      replyToId: 'incoming-1',
    });
  } finally {
    vi.useRealTimers();
  }
});

test('buildResponseText appends the memory footer unless disabled', async () => {
  const { buildResponseText } = await import('../src/channels/msteams/delivery.js');
  const memoryAccess = {
    semanticRecallAttempted: true,
    summaryIncluded: false,
    recalledMemories: [
      {
        ref: '[mem:1]',
        memoryId: 1,
        content: 'User prefers concise changelog entries.',
        confidence: 0.9,
      },
    ],
  };

  expect(buildResponseText('Hello', ['search'], memoryAccess)).toBe(
    'Hello\n\n*Memory: Recalled 1 memory*\n[mem:1]: User prefers concise changelog entries. (90%)\n*Tools: search*',
  );
  expect(
    buildResponseText('Hello', ['search'], memoryAccess, {
      showMemoryFooter: false,
    }),
  ).toBe('Hello\n*Tools: search*');
  expect(
    buildResponseText('', undefined, memoryAccess, { showMemoryFooter: false }),
  ).toBe('');
});
