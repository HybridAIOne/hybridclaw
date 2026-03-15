import { expect, test, vi } from 'vitest';

import { MSTeamsStreamManager } from '../src/channels/msteams/stream.js';

test('finalize omits the text field for attachment-only Teams stream sends', async () => {
  const sendActivity = vi.fn(async () => ({ id: 'activity-1' }));
  const turnContext = {
    sendActivity,
    updateActivity: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
  };
  const attachments = [
    {
      contentType: 'image/png',
      contentUrl: 'https://example.com/image.png',
      name: 'image.png',
    },
  ];

  const stream = new MSTeamsStreamManager(turnContext as never, {
    replyStyle: 'thread',
    replyToId: 'incoming-1',
  });
  await stream.finalize('', attachments);

  expect(sendActivity).toHaveBeenCalledWith({
    type: 'message',
    attachments,
    replyToId: 'incoming-1',
  });
});
