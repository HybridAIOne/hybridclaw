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
