import { expect, test, vi } from 'vitest';

import {
  prepareChunkedActivities,
  sendChunkedReply,
} from '../src/channels/msteams/delivery.js';

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
      replyToId: 'incoming-1',
    });
    expect(sendActivity).toHaveBeenNthCalledWith(2, {
      type: 'message',
      text: 'Hello',
      replyToId: 'incoming-1',
    });
  } finally {
    vi.useRealTimers();
  }
});
