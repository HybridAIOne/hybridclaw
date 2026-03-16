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

test('append throttles Teams stream edits instead of syncing every delta', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi.fn(async () => ({ id: 'activity-1' }));
    const updateActivity = vi.fn(async () => {});
    const turnContext = {
      sendActivity,
      updateActivity,
      deleteActivity: vi.fn(async () => {}),
    };

    const stream = new MSTeamsStreamManager(turnContext as never, {
      replyStyle: 'thread',
      replyToId: 'incoming-1',
      editIntervalMs: 500,
    });

    await stream.append('Hel');
    await stream.append('lo');
    expect(sendActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(sendActivity).toHaveBeenCalledWith({
      type: 'message',
      text: 'Hello',
      replyToId: 'incoming-1',
    });

    await stream.append(' world');
    expect(updateActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(updateActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(updateActivity).toHaveBeenCalledTimes(1);
    expect(updateActivity).toHaveBeenCalledWith({
      id: 'activity-1',
      type: 'message',
      text: 'Hello world',
      replyToId: 'incoming-1',
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(updateActivity).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('append surfaces send failures with a terminal Teams error message', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport down'))
      .mockResolvedValueOnce({ id: 'activity-1' });
    const turnContext = {
      sendActivity,
      updateActivity: vi.fn(async () => {}),
      deleteActivity: vi.fn(async () => {}),
    };

    const stream = new MSTeamsStreamManager(turnContext as never, {
      replyStyle: 'thread',
      replyToId: 'incoming-1',
      editIntervalMs: 500,
    });

    await stream.append('Hello');
    await vi.advanceTimersByTimeAsync(0);

    expect(sendActivity).toHaveBeenCalledTimes(2);
    expect(sendActivity).toHaveBeenNthCalledWith(1, {
      type: 'message',
      text: 'Hello',
      replyToId: 'incoming-1',
    });
    expect(sendActivity).toHaveBeenNthCalledWith(2, {
      type: 'message',
      text: 'Hello\n\nTeams streaming was interrupted while sending the reply. Please retry.',
      replyToId: 'incoming-1',
    });

    await stream.append(' again');
    await vi.advanceTimersByTimeAsync(500);
    expect(sendActivity).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('stream retries transient Teams send and update failures', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 429, retryAfter: 0.05 })
      .mockResolvedValueOnce({ id: 'activity-1' });
    const updateActivity = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce(undefined);
    const turnContext = {
      sendActivity,
      updateActivity,
      deleteActivity: vi.fn(async () => {}),
    };

    const stream = new MSTeamsStreamManager(turnContext as never, {
      replyStyle: 'thread',
      replyToId: 'incoming-1',
      editIntervalMs: 500,
    });

    await stream.append('Hello');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(sendActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendActivity).toHaveBeenCalledTimes(2);

    await stream.append(' world');
    await vi.advanceTimersByTimeAsync(500);
    expect(updateActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(updateActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(updateActivity).toHaveBeenCalledTimes(2);
    expect(updateActivity).toHaveBeenNthCalledWith(2, {
      id: 'activity-1',
      type: 'message',
      text: 'Hello world',
      replyToId: 'incoming-1',
    });
  } finally {
    vi.useRealTimers();
  }
});
